import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
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
    const open = screen.getByRole("button", { name: "修复自有引用" });
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
    expect(screen.getByRole("button", { name: "修复自有引用" })).toBeDisabled();
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
    const open = screen.getByRole("button", { name: "修复自有引用" });
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
    expect(screen.getByRole("button", { name: "修复自有引用" })).toBeDisabled();
    expect(screen.queryByText(/14 项通过/)).not.toBeInTheDocument();
  });
  it("renders real diagnostics and warning descriptions", async () => {
    vi.mocked(configHealthApi.check).mockResolvedValue({
      ...report,
      repairToken: "available-token",
      issues: [
        {
          id: "real",
          severity: "warning",
          title: "未发现登录配置",
          location: "auth.json",
          impact: "环境变量认证可以不需要此文件",
          solution: "请检查登录方式",
          repairable: false,
        },
      ],
    });
    render(<ConfigHealthView />);
    expect(await screen.findByText("未发现登录配置")).toBeInTheDocument();
    expect(
      screen.getByText("环境变量认证可以不需要此文件"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^修复$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "修复自有引用" })).toBeDisabled();
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
