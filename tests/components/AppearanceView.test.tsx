import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import AppearanceView from "@/views/AppearanceView";

vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const skin = {
  id: "sample",
  name: "测试皮肤",
  description: "独立展示的长描述，不占用标题。",
  version: "1.2.0",
  author: "测试作者",
  appearance: "dual",
  preview: "previews/sample.webp",
  installed: true,
  applied: true,
};
const second = {
  ...skin,
  id: "second",
  name: "第二皮肤",
  description: "第二款",
  preview: "previews/second.webp",
  installed: false,
  applied: false,
};
const frameOf = (image: HTMLElement) => image.closest(".skin-art")!;
beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue([skin]);
});

describe("appearance review", () => {
  it("separates the title and description and shows only known installation status", async () => {
    render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
    const title = await screen.findByRole("heading", {
      level: 2,
      name: "测试皮肤",
    });
    expect(title.textContent).toBe("测试皮肤");
    const footer = title.parentElement!;
    expect(within(footer).getByText(skin.description)).toBeVisible();
    expect(
      within(footer).getByText(/v1.2.0.*测试作者.*当前外观/),
    ).toBeVisible();
    expect(screen.queryByText(/适配当前 Codex/)).not.toBeInTheDocument();
  });
  it("finishes loading an empty catalog", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
    expect(
      await screen.findByRole("heading", { name: "皮肤目录暂无内容" }),
    ).toBeVisible();
    expect(screen.queryByText("正在读取皮肤目录…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });
  it("keeps skin application behind confirmation", async () => {
    const request = vi.fn();
    render(<AppearanceView enabled onRequestSkinAction={request} />);
    fireEvent.click(await screen.findByRole("button", { name: "重新应用" }));
    expect(request).toHaveBeenCalledWith({
      label: "重新应用皮肤",
      execute: expect.any(Function),
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(([command]) => command === "list_skin_catalog"),
    ).toBe(true);
  });
  it("does not load the catalog when the capability is disabled", () => {
    render(<AppearanceView enabled={false} onRequestSkinAction={vi.fn()} />);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("appearance loading and failure states", () => {
  it("shows a skeleton and one status line while the catalog loads", () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取皮肤目录…");
    expect(screen.getAllByText(/正在读取/)).toHaveLength(1);
    expect(screen.queryByText(/暂无内容|选择一个皮肤/)).not.toBeInTheDocument();
  });
  it("fades a preview in only after it loads and lazy-loads thumbnails", async () => {
    render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
    const preview = await screen.findByAltText("测试皮肤 预览");
    expect(preview).toHaveAttribute("decoding", "async");
    expect(preview).toHaveAttribute("loading", "eager");
    expect(frameOf(preview)).toHaveAttribute("data-state", "loading");
    const card = screen.getByRole("button", { name: /测试皮肤/ });
    const thumbnail = card.querySelector("img")!;
    expect(thumbnail).toHaveAttribute("loading", "lazy");
    expect(thumbnail).toHaveAttribute("decoding", "async");
    fireEvent.load(preview);
    await waitFor(() =>
      expect(frameOf(preview)).toHaveAttribute("data-state", "loaded"),
    );
    expect(frameOf(thumbnail)).toHaveAttribute("data-state", "loading");
  });
  it("preserves absolute preview URLs and offers recovery after an image error", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { ...skin, preview: "https://cdn.example.com/skin.webp" },
    ]);
    render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
    const image = await screen.findByAltText("测试皮肤 预览");
    expect(image).toHaveAttribute("src", "https://cdn.example.com/skin.webp");
    fireEvent.error(image);
    expect(screen.getByRole("status")).toHaveTextContent("预览图加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(screen.getByAltText("测试皮肤 预览")).toBeInTheDocument();
  });
  it("marks a failed thumbnail and retries it when that skin is chosen", async () => {
    vi.mocked(invoke).mockResolvedValue([skin, second]);
    render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
    await screen.findByAltText("测试皮肤 预览");
    const card = screen.getByRole("button", { name: /第二皮肤/ });
    fireEvent.error(card.querySelector("img")!);
    expect(within(card).getByText("加载失败")).toBeInTheDocument();
    expect(card.querySelector("img")).toBeNull();
    fireEvent.click(card);
    expect(card.querySelector("img")).not.toBeNull();
    expect(screen.getByAltText("第二皮肤 预览")).toBeInTheDocument();
  });
  it("reports a stalled main preview instead of loading forever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
      await screen.findByAltText("测试皮肤 预览");
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByRole("status")).toHaveTextContent("预览图加载失败");
    } finally {
      vi.useRealTimers();
    }
  });
  it("explains a catalog failure and retries it", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      "Could not reach the verified skin catalog.",
    );
    render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("皮肤目录读取失败");
    expect(alert).toHaveTextContent(
      "详细信息：Could not reach the verified skin catalog.",
    );
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "测试皮肤" }),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("points an empty filter back to the full catalog", async () => {
    vi.mocked(invoke).mockResolvedValue([second]);
    render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
    await screen.findByRole("heading", { level: 2, name: "第二皮肤" });
    fireEvent.click(screen.getByRole("button", { name: "已安装" }));
    expect(
      screen.getByRole("heading", { name: "还没有安装皮肤" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看精选" }));
    expect(
      screen.getByRole("heading", { level: 2, name: "第二皮肤" }),
    ).toBeVisible();
  });
});
