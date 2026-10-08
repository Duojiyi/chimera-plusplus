import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiPluginMarket } from "@/views/PiPluginMarket";
import {
  piPluginsApi,
  parseOmpPlugins,
  validPluginTarget,
} from "@/lib/api/piPlugins";
import { piApi } from "@/lib/api/pi";
import { piPluginCatalog } from "@/config/piPluginCatalog";

vi.mock("@/lib/api/piPlugins", async (original) => ({
  ...(await original<typeof import("@/lib/api/piPlugins")>()),
  piPluginsApi: { run: vi.fn() },
}));
vi.mock("@/lib/api/pi", () => ({ piApi: { read: vi.fn() } }));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    busy,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    title: string;
    message: string;
    busy: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <p>{message}</p>
        <button disabled={busy} onClick={onConfirm}>
          确认执行
        </button>
        <button disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    ) : null,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(piPluginsApi.run).mockImplementation(async (runtime, action) =>
    runtime === "omp" && action === "list"
      ? '{"npm":[],"marketplace":[]}'
      : "OK",
  );
  vi.mocked(piApi.read).mockResolvedValue({
    path: "/pi/settings.json",
    revision: "x",
    value: { packages: [] },
  });
});

describe("embedded Pi market", () => {
  it("shows ten real pinned candidates without invoking tools", () => {
    render(<PiPluginMarket native={false} />);
    expect(screen.getAllByRole("article")).toHaveLength(10);
    expect(new Set(piPluginCatalog.map((p) => p.name)).size).toBe(10);
    for (const plugin of piPluginCatalog) {
      expect(validPluginTarget(`${plugin.name}@${plugin.version}`)).toBe(true);
      expect(plugin.repository).toMatch(/^https:\/\/github.com\//);
    }
    expect(
      screen.getAllByRole("button", { name: "安装固定版本" })[0],
    ).toBeDisabled();
    expect(piPluginsApi.run).not.toHaveBeenCalled();
  });
  it("filters recommendations by text and category", () => {
    render(<PiPluginMarket native={false} />);
    fireEvent.change(screen.getByLabelText("搜索推荐插件"), {
      target: { value: "langfuse" },
    });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText(/可能上传提示与响应/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("插件分类"), {
      target: { value: "代码质量" },
    });
    expect(screen.getByText("没有匹配的推荐插件。")).toBeInTheDocument();
  });
  it("requires confirmation, installs a pinned source, and refreshes", async () => {
    render(<PiPluginMarket native />);
    fireEvent.click(
      within(screen.getByRole("article", { name: "pi-web-access" })).getByRole(
        "button",
        { name: "安装固定版本" },
      ),
    );
    expect(piPluginsApi.run).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "pi-web-access@0.37.0",
    );
    fireEvent.click(screen.getByText("确认执行"));
    await waitFor(() => expect(piApi.read).toHaveBeenCalledWith("settings"));
    expect(piPluginsApi.run).toHaveBeenNthCalledWith(
      1,
      "pi",
      "install",
      "pi-web-access@0.37.0",
    );
    expect(piPluginsApi.run).toHaveBeenNthCalledWith(2, "pi", "list");
  });
  it("cancellation never runs the CLI", () => {
    render(<PiPluginMarket native />);
    fireEvent.click(screen.getAllByText("安装固定版本")[0]);
    fireEvent.click(screen.getByText("取消"));
    expect(piPluginsApi.run).not.toHaveBeenCalled();
  });
  it("reports failures without claiming installed state", async () => {
    vi.mocked(piPluginsApi.run).mockRejectedValue(new Error("command failed"));
    render(<PiPluginMarket native />);
    fireEvent.click(screen.getAllByText("安装固定版本")[0]);
    fireEvent.click(screen.getByText("确认执行"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "command failed",
    );
    expect(
      screen.queryByText(/已声明（不代表已安装）/),
    ).not.toBeInTheDocument();
  });
  it("preserves filtered declarations and makes git sources read-only", async () => {
    vi.mocked(piApi.read).mockResolvedValue({
      path: "/pi/settings.json",
      revision: "x",
      value: {
        packages: [
          { source: "npm:pi-web-access@0.37.0", extensions: ["x.ts"] },
          "git:example/repo",
        ],
      },
    });
    render(<PiPluginMarket native />);
    fireEvent.click(screen.getByText("本地声明与状态"));
    fireEvent.click(screen.getByText("刷新插件状态"));
    expect(
      await screen.findByText("npm:pi-web-access@0.37.0（含资源筛选）"),
    ).toBeInTheDocument();
    const buttons = screen.getAllByText("卸载");
    expect(buttons[1]).toBeDisabled();
    fireEvent.click(buttons[0]);
    fireEvent.click(screen.getByText("确认执行"));
    await waitFor(() =>
      expect(piPluginsApi.run).toHaveBeenCalledWith(
        "pi",
        "remove",
        "pi-web-access@0.37.0",
      ),
    );
  });
  it("keeps OMP independent and manages native installed plugins", async () => {
    vi.mocked(piPluginsApi.run).mockResolvedValue(
      '{"npm":[{"name":"omp-example","version":"1.0.0","enabled":true}],"marketplace":[]}',
    );
    render(<PiPluginMarket native runtime="omp" />);
    expect(screen.queryByText("精选推荐 · 10")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("已安装插件"));
    fireEvent.click(screen.getByText("刷新插件状态"));
    expect(await screen.findByText("omp-example")).toBeInTheDocument();
    expect(piApi.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("停用"));
    fireEvent.click(screen.getByText("确认执行"));
    await waitFor(() =>
      expect(piPluginsApi.run).toHaveBeenCalledWith(
        "omp",
        "disable",
        "omp-example",
      ),
    );
  });
  it("can disable a marketplace plugin with omitted enabled status", async () => {
    vi.mocked(piPluginsApi.run).mockResolvedValue(
      '{"npm":[],"marketplace":[{"id":"review@official","entries":[{"version":"1"}]}]}',
    );
    render(<PiPluginMarket native runtime="omp" />);
    fireEvent.click(screen.getByText("已安装插件"));
    fireEvent.click(screen.getByText("刷新插件状态"));
    expect(await screen.findByText("review@official")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    fireEvent.click(screen.getByText("确认执行"));
    await waitFor(() =>
      expect(piPluginsApi.run).toHaveBeenCalledWith(
        "omp",
        "disable",
        "review@official",
      ),
    );
  });
  it("does not add marketplace sources implicitly", () => {
    render(<PiPluginMarket native runtime="omp" />);
    expect(piPluginsApi.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("管理市场源"));
    fireEvent.change(screen.getByLabelText("OMP 市场源"), {
      target: { value: "anthropics/claude-plugins-official" },
    });
    fireEvent.click(screen.getByText("添加市场源"));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "anthropics/claude-plugins-official",
    );
    expect(piPluginsApi.run).not.toHaveBeenCalled();
  });
  it("locks switching and duplicate submits while an operation is pending", async () => {
    let finish!: (value: string) => void;
    vi.mocked(piPluginsApi.run).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<PiPluginMarket native />);
    fireEvent.click(screen.getAllByText("安装固定版本")[0]);
    fireEvent.click(screen.getByText("确认执行"));
    expect(
      screen.queryByRole("button", { name: "oh-my-pi" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("确认执行")).toBeDisabled();
    finish("done");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

describe("plugin input and upstream parsing", () => {
  it.each([
    "--help",
    "../path",
    "a & calc",
    "a%PATH%",
    "a\nwhoami",
    "https://evil",
    "git:repo",
    "a^b",
    "a$(id)",
    "a|b",
    "",
    "@scope",
    "a@^1",
    "x".repeat(215),
  ])("rejects %s", (value) => expect(validPluginTarget(value)).toBe(false));
  it.each([
    "@scope/name@1.2.3",
    "review@official",
    "pi-example",
    "x@1.0.0-beta.1",
  ])("accepts %s", (value) => expect(validPluginTarget(value)).toBe(true));
  it.each([true, false])(
    "preserves explicit marketplace enabled=%s",
    (enabled) => {
      expect(
        parseOmpPlugins(
          JSON.stringify({
            npm: [],
            marketplace: [
              { id: "review@official", entries: [{ version: "1", enabled }] },
            ],
          }),
        ),
      ).toEqual([{ id: "review@official", version: "1", enabled }]);
    },
  );
  it.each([
    undefined,
    null,
    {},
    [],
    [null],
    ["bad"],
    [[]],
    [{ enabled: null }],
    [{ enabled: "false" }],
  ])("keeps malformed marketplace entries unknown: %j", (entries) => {
    expect(
      parseOmpPlugins(
        JSON.stringify({
          npm: [],
          marketplace: [{ id: "review@official", entries }],
        }),
      ),
    ).toEqual([{ id: "review@official", version: "未知", enabled: null }]);
  });
  it("keeps missing npm enabled status unknown", () => {
    expect(
      parseOmpPlugins(
        '{"npm":[{"name":"omp-example","version":"1"}],"marketplace":[]}',
      ),
    ).toEqual([{ id: "omp-example", version: "1", enabled: null }]);
  });
  it("defaults marketplace entries to enabled", () => {
    expect(
      parseOmpPlugins(
        '{"npm":[],"marketplace":[{"id":"review@official","entries":[{"version":"1"}]}]}',
      ),
    ).toEqual([{ id: "review@official", version: "1", enabled: true }]);
    expect(() => parseOmpPlugins('{"npm":[]}')).toThrow();
    expect(() => parseOmpPlugins("bad")).toThrow();
  });
});
