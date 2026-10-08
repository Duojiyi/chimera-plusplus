import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OmpView from "@/views/OmpView";
import { ompApi } from "@/lib/api/omp";
import { piPluginsApi } from "@/lib/api/piPlugins";
import type { PiDocument } from "@/lib/api/pi";
vi.mock("@/lib/api/omp", async (original) => ({
  ...(await original<typeof import("@/lib/api/omp")>()),
  ompApi: { read: vi.fn(), save: vi.fn() },
}));
vi.mock("@/lib/api/piPlugins", async (original) => ({
  ...(await original<typeof import("@/lib/api/piPlugins")>()),
  piPluginsApi: { run: vi.fn() },
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
const initial = (): PiDocument => ({
  path: "C:/test/.omp/agent/models.yml",
  revision: "r1",
  value: {
    future: true,
    providers: {
      test: {
        baseUrl: "https://example.com/v1",
        api: "openai-completions",
        apiKey: "SECRET_ENV",
        headers: { custom: "keep" },
        models: [
          { id: "model-1", contextWindow: 64000, compat: { future: true } },
        ],
      },
    },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ompApi.read).mockResolvedValue(initial());
  vi.mocked(ompApi.save).mockImplementation(async (value) => ({
    ...initial(),
    revision: "r2",
    value,
  }));
  vi.mocked(piPluginsApi.run).mockResolvedValue("18.8.3");
});
const edit = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
};
const submit = async () => {
  fireEvent.click(screen.getByRole("button", { name: "保存线路" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认保存" }));
};
describe("OMP native routes and hierarchy", () => {
  it("defaults to routes and separates plugin operations from runtime maintenance", async () => {
    render(<OmpView native />);
    expect(await screen.findByText("test")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "安装 oh-my-pi" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "插件市场" }));
    expect(screen.getByRole("button", { name: "原生市场" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "检测版本" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("OMP 市场源")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "安装与更新" }));
    expect(screen.getByRole("button", { name: "检测版本" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "安装此来源" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检测版本" }));
    await waitFor(() =>
      expect(piPluginsApi.run).toHaveBeenCalledWith("omp", "version", ""),
    );
  });
  it("preserves drafts across tabs and unknown provider/model fields on save", async () => {
    render(<OmpView native />);
    await edit();
    expect(screen.getByLabelText("API Key / 环境变量名")).toHaveAttribute(
      "type",
      "password",
    );
    fireEvent.change(screen.getByLabelText("API 地址"), {
      target: { value: "https://new.example/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "插件市场" }));
    fireEvent.click(screen.getByRole("button", { name: "模型线路" }));
    expect(screen.getByLabelText("API 地址")).toHaveValue(
      "https://new.example/v1",
    );
    await submit();
    await waitFor(() => expect(ompApi.save).toHaveBeenCalled());
    const expected = initial();
    (expected.value.providers as any).test.baseUrl = "https://new.example/v1";
    expect(ompApi.save).toHaveBeenCalledWith(expected.value, initial());
    expect(await screen.findByText(/线路已保存/)).toBeVisible();
  });
  it("keeps failed saves and stale revisions from losing the draft", async () => {
    vi.mocked(ompApi.save).mockRejectedValue(new Error("外部修改冲突"));
    render(<OmpView native />);
    await edit();
    fireEvent.change(screen.getByLabelText("API 地址"), {
      target: { value: "https://draft.example/v1" },
    });
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("外部修改冲突");
    expect(screen.getByLabelText("API 地址")).toHaveValue(
      "https://draft.example/v1",
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新线路" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(ompApi.read).toHaveBeenCalledTimes(1);
  });
  it("confirms deletion and writes only the selected provider removal", async () => {
    render(<OmpView native />);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(ompApi.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(ompApi.save).toHaveBeenCalledWith(
        { future: true, providers: {} },
        initial(),
      ),
    );
    expect(await screen.findByText("尚未配置自定义线路")).toBeVisible();
  });
  it("validates duplicates and adds a local no-auth model", async () => {
    render(<OmpView native />);
    await screen.findByText("test");
    fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
    fireEvent.change(screen.getByLabelText("线路 ID"), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存线路" }));
    expect(screen.getByRole("alert")).toHaveTextContent("线路 ID 已存在");
    fireEvent.change(screen.getByLabelText("线路 ID"), {
      target: { value: "local" },
    });
    fireEvent.change(screen.getByLabelText("API 地址"), {
      target: { value: "http://localhost:1234/v1" },
    });
    fireEvent.change(screen.getByLabelText("认证方式"), {
      target: { value: "none" },
    });
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "local-model" },
    });
    await submit();
    await waitFor(() => expect(ompApi.save).toHaveBeenCalled());
    expect(
      (vi.mocked(ompApi.save).mock.calls[0][0].providers as any).local,
    ).toEqual({
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      auth: "none",
      models: [{ id: "local-model" }],
    });
  });
  it("reports malformed native responses without crashing the page", async () => {
    vi.mocked(ompApi.read).mockResolvedValue({} as PiDocument);
    render(<OmpView native />);
    expect(await screen.findByRole("alert")).toHaveTextContent("桌面端已更新");
    expect(screen.getByRole("button", { name: "添加线路" })).toBeDisabled();
  });
  it("does not access the native config in browser preview", () => {
    render(<OmpView native={false} />);
    expect(ompApi.read).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "添加线路" })).toBeDisabled();
  });
  it("hides route confirmations on other tabs without losing pending state", async () => {
    render(<OmpView native />);
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "保存线路" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    // Programmatic navigation covers app/sidebar changes even while a modal is open.
    fireEvent.click(
      screen.getByRole("button", {
        name: "插件市场",
        hidden: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "模型线路" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByText(/YAML/)).toBeVisible();
  });
});
