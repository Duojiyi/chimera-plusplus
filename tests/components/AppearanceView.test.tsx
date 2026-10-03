import { fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(await screen.findByText("皮肤目录暂无内容。")).toBeVisible();
    expect(screen.queryByText("正在读取皮肤目录…")).not.toBeInTheDocument();
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

it("preserves absolute preview URLs and offers recovery after an image error", async () => {
  vi.mocked(invoke).mockResolvedValue([
    { ...skin, preview: "https://cdn.example.com/skin.webp" },
  ]);
  render(<AppearanceView enabled onRequestSkinAction={vi.fn()} />);
  const image = await screen.findByAltText("测试皮肤 预览");
  expect(image).toHaveAttribute("src", "https://cdn.example.com/skin.webp");
  fireEvent.error(image);
  expect(screen.getByRole("status")).toHaveTextContent("预览暂不可用");
  fireEvent.click(screen.getByRole("button", { name: "重试预览" }));
  expect(screen.getByAltText("测试皮肤 预览")).toBeInTheDocument();
});
