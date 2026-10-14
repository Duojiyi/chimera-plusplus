import { isTauri } from "@tauri-apps/api/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigHealthView } from "@/views/ConfigHealthView";
import {
  configHealthApi,
  type ConfigHealthReport,
} from "@/lib/api/configHealth";
vi.mock("@/lib/api/configHealth", () => ({
  configHealthApi: { check: vi.fn(), repairOwnedInstructions: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  isTauri: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
const report: ConfigHealthReport = {
  issues: [],
  checkedAt: "2026-10-02T00:00:00Z",
  readOnly: true,
};
const repairableIssue = {
  id: "owned",
  severity: "critical" as const,
  title: "失效自有引用",
  location: "config.toml",
  impact: "自有指令无法加载",
  solution: "备份并清理失效引用",
  repairable: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(configHealthApi.check).mockResolvedValue(report);
});
describe("connected configuration health", () => {
  it("requires consent and serializes repair with the exact report token", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      repairToken: "observed-token",
      issues: [repairableIssue],
    });
    let finish!: (value: ConfigHealthReport) => void;
    vi.mocked(configHealthApi.repairOwnedInstructions).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<ConfigHealthView />);
    const open = await screen.findByRole("button", { name: "修复自有引用" });
    await waitFor(() => expect(open).toBeEnabled());
    const recheck = screen.getByRole("button", { name: "重新检查" });
    fireEvent.click(open);
    const confirm = screen.getByRole("button", { name: "备份并修复" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(configHealthApi.repairOwnedInstructions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(recheck).toBeDisabled();
    fireEvent.click(confirm);
    expect(
      configHealthApi.repairOwnedInstructions,
    ).toHaveBeenCalledExactlyOnceWith("observed-token");
    await act(async () => finish(report));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // The repaired report carries no token, so nothing is left to repair.
    expect(
      screen.queryByRole("button", { name: "修复自有引用" }),
    ).not.toBeInTheDocument();
  });
  it("cancels without writes and reloads after failure without retaining consent", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      repairToken: "old-token",
      issues: [repairableIssue],
    });
    vi.mocked(configHealthApi.repairOwnedInstructions).mockRejectedValue(
      new Error("private-secret"),
    );
    render(<ConfigHealthView />);
    const open = await screen.findByRole("button", { name: "修复自有引用" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(configHealthApi.repairOwnedInstructions).not.toHaveBeenCalled();
    fireEvent.click(open);
    fireEvent.click(screen.getByRole("checkbox"));
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      repairToken: "new-token",
      issues: [repairableIssue],
    });
    fireEvent.click(screen.getByRole("button", { name: "备份并修复" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(configHealthApi.check).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("private-secret");
    fireEvent.click(open);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "备份并修复" })).toBeDisabled();
  });
  it("checks on mount without fictional failures or repair success", async () => {
    render(<ConfigHealthView />);
    expect(
      await screen.findByText(/本次已检查范围内未发现问题/),
    ).toBeInTheDocument();
    expect(configHealthApi.check).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/14:40|用时 1.2 秒/)).not.toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute(
      "datetime",
      report.checkedAt,
    );
    expect(
      screen.queryByRole("button", { name: "修复自有引用" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("一切正常")).toBeInTheDocument();
    expect(screen.queryByText(/14 项通过/)).not.toBeInTheDocument();
  });
  it("renders real diagnostics without repair buttons that cannot repair", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      issues: [
        {
          id: "deepseek-ws-0",
          severity: "warning",
          title: "DeepSeek WebSocket 设置需检查",
          location: "config.toml · model_providers",
          impact: "DeepSeek 官方接口应使用 HTTP 连接。",
          solution: "请检查配置；自动修复尚未开放。",
          repairable: false,
        },
      ],
    });
    render(<ConfigHealthView />);
    const item = (
      await screen.findByText("DeepSeek WebSocket 设置需检查")
    ).closest("li")!;
    expect(item).toHaveAttribute("data-tone", "warning");
    expect(item).toHaveTextContent("DeepSeek 官方接口应使用 HTTP 连接。");
    expect(screen.getByText("有 1 项建议")).toBeInTheDocument();
    // No repair is offered; the inactive control says the fix is manual and why.
    expect(screen.queryByRole("button", { name: /^修复/ })).toBeNull();
    const manual = within(item).getByRole("button", { name: "需手动修复" });
    expect(manual).toHaveAttribute("aria-disabled", "true");
    expect(manual).toHaveAccessibleDescription(/手动修改 config\.toml/);
  });
  it("shows where each issue is, which parameter and how to fix it", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      issues: [
        {
          id: "provider-boolean-0",
          severity: "critical",
          title: "供应商开关格式不正确",
          location: "config.toml",
          impact: "开关必须使用 true 或 false，不能使用带引号的文字。",
          solution: "将该开关写为 true 或 false（不带引号）。",
          repairable: false,
          line: 2,
          column: 1,
          field: "supports_websockets",
        },
        {
          id: "provider-name-1",
          severity: "critical",
          title: "供应商缺少有效名称",
          location: "config.toml",
          impact: "供应商名称必须是非空文字。",
          solution: "在这张供应商表里填写 name。",
          repairable: false,
          field: "name",
        },
        {
          id: "auth-format-2",
          severity: "critical",
          title: "登录配置格式不正确",
          location: "auth.json",
          impact: "登录配置必须是 JSON 对象；未回显凭据内容。",
          solution: "在「官方账号」页重新登录会重新生成 auth.json。",
          repairable: false,
        },
      ],
    });
    render(<ConfigHealthView />);
    const located = (await screen.findByText("供应商开关格式不正确")).closest(
      "li",
    )!;
    expect(
      within(located).getByText("config.toml · 第 2 行，第 1 列"),
    ).toBeVisible();
    expect(located).toHaveTextContent("参数：supports_websockets");
    expect(located).toHaveTextContent(
      "修复建议：将该开关写为 true 或 false（不带引号）。",
    );
    const undefinedLine = screen.getByText("供应商缺少有效名称").closest("li")!;
    expect(
      within(undefinedLine).getByText("config.toml · 未定义，无对应行"),
    ).toBeVisible();
    const fileLevel = screen.getByText("登录配置格式不正确").closest("li")!;
    expect(within(fileLevel).getByText("auth.json")).toBeVisible();
    expect(fileLevel).not.toHaveTextContent("参数：");
    expect(fileLevel).not.toHaveTextContent("第");
    expect(screen.getAllByRole("button", { name: "需手动修复" })).toHaveLength(
      3,
    );
  });
  it("offers repair, not manual repair, for issues the backend can fix", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      repairToken: "token",
      issues: [{ ...repairableIssue, line: 1, column: 1 }],
    });
    render(<ConfigHealthView />);
    expect(
      await screen.findByRole("button", { name: "修复「失效自有引用」" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "需手动修复" }),
    ).not.toBeInTheDocument();
  });
  it("treats a fresh install's missing files as information, not warnings", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      issues: [
        {
          id: "missing-0",
          severity: "warning",
          title: "尚未创建 Codex 配置",
          location: "config.toml",
          impact: "首次使用时可以通过线路页面配置。",
          solution: "请检查配置；自动修复尚未开放。",
          repairable: false,
        },
        {
          id: "auth-missing-1",
          severity: "warning",
          title: "未发现登录配置",
          location: "auth.json",
          impact:
            "使用环境变量认证时可以没有此文件；官方账户可通过登录流程创建。",
          solution: "请检查配置；自动修复尚未开放。",
          repairable: false,
        },
      ],
    });
    render(<ConfigHealthView />);
    const config = (await screen.findByText("尚未创建 Codex 配置")).closest(
      "li",
    )!;
    const auth = screen.getByText("未发现登录配置").closest("li")!;
    expect(config).toHaveAttribute("data-tone", "info");
    expect(auth).toHaveAttribute("data-tone", "info");
    expect(config).toHaveTextContent("在「线路」页添加线路后会自动生成");
    expect(auth).toHaveTextContent("登录官方账号后会自动生成");
    expect(document.body).not.toHaveTextContent("自动修复尚未开放");
    expect(screen.getByRole("heading", { name: "提示 · 2" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: /建议/ })).toBeNull();
    expect(screen.getByText("一切正常")).toBeInTheDocument();
    expect(screen.getByText("2 条提示 · 只读检测")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /修复/ })).toBeNull();
  });
  it("summarises findings that need attention", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      issues: [
        { ...repairableIssue, id: "toml-0", repairable: false },
        {
          ...repairableIssue,
          id: "deepseek-ws-1",
          severity: "warning",
          repairable: false,
        },
      ],
    });
    render(<ConfigHealthView />);
    expect(await screen.findByText("有 1 项需要处理")).toBeInTheDocument();
    expect(screen.getByText("1 条建议 · 只读检测")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "需要处理 · 1" }),
    ).toBeInTheDocument();
  });
  it("offers repair from the header whenever the backend issued a token", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      repairToken: "available-token",
      issues: [
        {
          id: "file-ref-unreadable-0",
          severity: "critical",
          title: "引用文件缺失或无法安全读取",
          location: "config.toml · file references",
          impact: "请检查指令与模型目录文件是否存在、权限与大小。",
          solution: "请检查配置；自动修复尚未开放。",
          repairable: false,
        },
      ],
    });
    render(<ConfigHealthView />);
    const open = await screen.findByRole("button", { name: "修复自有引用" });
    await waitFor(() => expect(open).toBeEnabled());
    expect(screen.queryByRole("button", { name: /^修复「/ })).toBeNull();
    fireEvent.click(open);
    expect(screen.getByRole("dialog")).toHaveTextContent("先备份 config.toml");
  });
  it("keeps the header repair action in place while a recheck runs", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      repairToken: "available-token",
      issues: [repairableIssue],
    });
    render(<ConfigHealthView />);
    const open = await screen.findByRole("button", { name: "修复自有引用" });
    await waitFor(() => expect(open).toBeEnabled());
    let finish!: (r: ConfigHealthReport) => void;
    vi.mocked(configHealthApi.check).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(open).toBeInTheDocument();
    expect(open).toBeDisabled();
    await act(async () => finish(report));
    expect(open).not.toBeInTheDocument();
  });
  it("hides stale results after a failed recheck and does not expose raw errors", async () => {
    render(<ConfigHealthView />);
    await screen.findByText(/本次已检查范围内未发现问题/);
    vi.mocked(configHealthApi.check).mockRejectedValueOnce(
      new Error("secret-token"),
    );
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("配置体检失败");
    expect(
      screen.queryByText(/本次已检查范围内未发现问题/),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret-token");
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await screen.findByText(/本次已检查范围内未发现问题/);
  });
  it("keeps recheck disabled while the native request is pending", async () => {
    let finish!: (r: ConfigHealthReport) => void;
    vi.mocked(configHealthApi.check).mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    );
    render(<ConfigHealthView />);
    expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
    await act(async () => finish(report));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "重新检查" }),
      ).not.toBeDisabled(),
    );
  });
});

it("explains browser preview without reporting a failed health check", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  render(<ConfigHealthView />);
  expect(screen.getByRole("status")).toHaveTextContent("浏览器预览未连接本机");
  expect(configHealthApi.check).not.toHaveBeenCalled();
  expect(screen.queryByText("检查失败")).not.toBeInTheDocument();
});
