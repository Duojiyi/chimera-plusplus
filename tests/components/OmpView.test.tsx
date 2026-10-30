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
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: invokeMock,
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
  fireEvent.click(await screen.findByRole("button", { name: "编辑test" }));
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
    fireEvent.change(screen.getByLabelText(/^API 请求地址( \*)?$/), {
      target: { value: "https://new.example/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "插件市场" }));
    fireEvent.click(screen.getByRole("button", { name: "模型线路" }));
    expect(screen.getByLabelText(/^API 请求地址( \*)?$/)).toHaveValue(
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
    fireEvent.change(screen.getByLabelText(/^API 请求地址( \*)?$/), {
      target: { value: "https://draft.example/v1" },
    });
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("外部修改冲突");
    expect(screen.getByLabelText(/^API 请求地址( \*)?$/)).toHaveValue(
      "https://draft.example/v1",
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新线路" }));
    expect(
      await screen.findByRole("dialog", { name: "放弃当前草稿？" }),
    ).toBeVisible();
    expect(ompApi.read).toHaveBeenCalledTimes(1);
  });
  it("confirms deletion and writes only the selected provider removal", async () => {
    render(<OmpView native />);
    fireEvent.click(await screen.findByRole("button", { name: "删除test" }));
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
  it("asks again before rewriting a models.yml with comments, then saves with the backup flag", async () => {
    vi.mocked(ompApi.save).mockImplementation(
      async (value, _document, allowLossyRewrite) => {
        if (!allowLossyRewrite)
          throw "OMP_LOSSY_REWRITE: models.yml 含注释、锚点或别名";
        return {
          ...initial(),
          revision: "r2",
          value: value as PiDocument["value"],
        };
      },
    );
    render(<OmpView native />);
    fireEvent.click(await screen.findByRole("button", { name: "删除test" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    const dialog = await screen.findByRole("dialog", {
      name: "models.yml 含注释或锚点",
    });
    expect(dialog).toHaveTextContent("注释会丢失");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(ompApi.save).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "备份后保存" }));
    await waitFor(() =>
      expect(ompApi.save).toHaveBeenLastCalledWith(
        { future: true, providers: {} },
        initial(),
        true,
      ),
    );
    expect(await screen.findByText("尚未配置自定义线路")).toBeVisible();
  });
  it("validates duplicates and adds a local no-auth model", async () => {
    render(<OmpView native />);
    await screen.findByText("test");
    fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
    fireEvent.change(screen.getByLabelText(/^线路 ID( \*)?$/), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存线路" }));
    expect(screen.getByRole("alert")).toHaveTextContent("线路 ID 已存在");
    fireEvent.change(screen.getByLabelText(/^线路 ID( \*)?$/), {
      target: { value: "local" },
    });
    fireEvent.change(screen.getByLabelText(/^API 请求地址( \*)?$/), {
      target: { value: "http://localhost:1234/v1" },
    });
    fireEvent.click(screen.getByText("高级配置"));
    fireEvent.click(screen.getByRole("radio", { name: "免认证（本地服务）" }));
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
  it("shows a read failure as the titled tool error card with a retry", async () => {
    vi.mocked(ompApi.read)
      .mockRejectedValueOnce(new Error("OMP YAML 无法解析"))
      .mockResolvedValueOnce(initial());
    render(<OmpView native />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("tool-load-error");
    expect(alert).toHaveTextContent("读取 oh-my-pi 配置失败");
    expect(alert).toHaveTextContent("OMP YAML 无法解析");
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("test")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(ompApi.read).toHaveBeenCalledTimes(2);
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
    expect(
      await screen.findByRole("dialog", { name: "保存 OMP 线路？" }),
    ).toBeVisible();
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
    expect(
      await screen.findByRole("dialog", { name: "保存 OMP 线路？" }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("dialog", { name: "保存 OMP 线路？" })).getByText(
        /YAML/,
      ),
    ).toBeVisible();
  });
});

it("prefills Chimera, offers protocol choices and allows checking the credential", async () => {
  render(<OmpView native />);
  await screen.findByText("test");
  fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
  await waitFor(() =>
    expect(
      screen.getByDisplayValue("https://api.chimerahub.org/v1"),
    ).toBeVisible(),
  );
  const protocol = screen.getByRole("radiogroup", { name: "协议" });
  expect(
    within(protocol)
      .getAllByRole("radio")
      .map((radio) => radio.getAttribute("value")),
  ).toEqual([
    "openai-responses",
    "openai-completions",
    "anthropic-messages",
    "google-generative-ai",
    "__other__",
  ]);
  expect(
    within(protocol).getByRole("radio", { name: "Chat Completions" }),
  ).toBeChecked();
  expect(screen.getByText("配置模板 · ChimeraHub")).toBeInTheDocument();
  expect(screen.getByLabelText("API Key / 环境变量名")).toHaveAttribute(
    "type",
    "password",
  );
  fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
  expect(screen.getByLabelText("API Key / 环境变量名")).toHaveAttribute(
    "type",
    "text",
  );
  expect(
    screen.queryByRole("button", { name: "添加线路" }),
  ).not.toBeInTheDocument();
});

it("uses the shared full-screen editor and confirms closing without losing edits", async () => {
  render(<OmpView native />);
  await edit();
  const panel = screen.getByRole("dialog", { name: "编辑 Oh My Pi 线路" });
  expect(panel).toHaveAttribute("data-fullscreen-panel");
  const save = within(panel).getByRole("button", { name: "保存线路" });
  expect(save).toHaveAttribute("form", "omp-provider-form");
  expect(save.closest("form")).toBeNull();
  fireEvent.change(screen.getByLabelText(/^API 请求地址( \*)?$/), {
    target: { value: "https://draft.example/v1" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "取消" }));
  const confirm = await screen.findByRole("dialog", { name: "放弃当前草稿？" });
  fireEvent.click(within(confirm).getByRole("button", { name: "放弃草稿" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "编辑 Oh My Pi 线路" }),
    ).not.toBeInTheDocument(),
  );
  expect(ompApi.save).not.toHaveBeenCalled();
});

it("shares route editor structure, inherits the shell and closes unchanged drafts directly", async () => {
  render(
    <div className="chimera-shell">
      <aside>Sidebar</aside>
      <main className="chimera-main">
        <div className="chimera-content">
          <OmpView native />
        </div>
      </main>
    </div>,
  );
  await edit();
  const panel = screen.getByRole("dialog", { name: "编辑 Oh My Pi 线路" });
  expect(panel.parentElement).toHaveClass("chimera-shell");
  expect(panel).toHaveClass("provider-editor-page");
  expect(
    within(panel).getByRole("heading", { name: "基础" }),
  ).toBeInTheDocument();
  expect(
    within(panel).getByRole("heading", { name: "协议与模型" }),
  ).toBeInTheDocument();
  const details = within(panel).getByText("保存详情").closest("details");
  expect(details).toHaveClass("editor-preview");
  // The shared inline disclosure, not the user-agent triangle.
  expect(details).toHaveClass("chimera-disclosure", "is-inline");
  expect(details).not.toHaveAttribute("open");
  expect(
    within(panel)
      .getByRole("button", { name: "保存线路" })
      .closest(".editor-bottom"),
  ).not.toBeNull();
  fireEvent.click(within(panel).getByRole("button", { name: "返回线路" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(ompApi.save).not.toHaveBeenCalled();
});

it("aligns the route list with tool headers, navigation and endpoint tables", async () => {
  const { container } = render(<OmpView native />);
  const table = await screen.findByRole("table", { name: "OMP 自定义线路" });
  // Same header and list as the other tool pages.
  expect(
    container.querySelector("header.tool-header .tool-mark"),
  ).toHaveTextContent(/^Om$/);
  expect(table).toHaveClass("tool-lines");
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["线路", "请求地址", "协议", "模型", "操作"]);
  const row = within(table).getByRole("row", { name: /test/ });
  expect(within(row).getByRole("rowheader")).toHaveTextContent("test");
  expect(within(row).getByText("https://example.com/v1")).toHaveClass(
    "tool-line-mono",
  );
  expect(within(row).getByText("Chat")).toHaveAttribute(
    "title",
    "openai-completions",
  );
  expect(within(row).getByText("model-1")).toBeVisible();
  // Icon actions, as on the other tool tables; delete still confirms.
  expect(within(row).getByRole("button", { name: "编辑test" })).toHaveClass(
    "tool-line-icon",
  );
  expect(within(row).getByRole("button", { name: "删除test" })).toHaveClass(
    "tool-provider-delete",
  );
  expect(
    screen.queryByRole("heading", { name: "模型线路" }),
  ).not.toBeInTheDocument();
  const actions = screen.getByRole("group", { name: "oh-my-pi 工具操作" });
  expect(actions.closest("header")).not.toBeNull();
  expect(
    within(actions).getByRole("button", { name: "添加线路" }),
  ).toBeVisible();
  expect(
    screen.getByRole("navigation", { name: "oh-my-pi 管理导航" }),
  ).toHaveClass("tool-section-nav");
  fireEvent.click(screen.getByRole("button", { name: "插件市场" }));
  expect(actions).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "模型线路" }));
  expect(actions).toBeVisible();
  expect(table).toBeVisible();
});
