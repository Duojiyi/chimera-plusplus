import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ConfigDirectoriesPanel } from "@/components/settings/ConfigDirectoriesPanel";
import { settingsApi } from "@/lib/api/settings";
vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    get: vi.fn(),
    save: vi.fn(),
    patchConfigDirectory: vi.fn(),
    getConfigDir: vi.fn(),
    getAppConfigPath: vi.fn(),
    getAppConfigDirOverride: vi.fn(),
    setAppConfigDirOverride: vi.fn(),
    pickDirectory: vi.fn(),
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(settingsApi.get).mockResolvedValue({
    codexConfigDir: "C:\\old",
    enableLocalProxy: false,
  } as never);
  vi.mocked(settingsApi.getConfigDir).mockResolvedValue("C:\\effective");
  vi.mocked(settingsApi.getAppConfigPath).mockResolvedValue("C:\\app");
  vi.mocked(settingsApi.getAppConfigDirOverride).mockResolvedValue(null);
  vi.mocked(settingsApi.patchConfigDirectory).mockResolvedValue(true);
  vi.mocked(settingsApi.setAppConfigDirOverride).mockResolvedValue(true);
});
async function mount() {
  render(<ConfigDirectoriesPanel />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "保存 Codex" })).toBeEnabled(),
  );
}
it("does not save on load or typing, patches only the chosen WSL directory without replaying preferences", async () => {
  await mount();
  const path = "\\\\wsl.localhost\\Ubuntu\\home\\user\\.codex";
  fireEvent.change(screen.getByLabelText("Codex目录"), {
    target: { value: path },
  });
  expect(settingsApi.save).not.toHaveBeenCalled();
  expect(settingsApi.patchConfigDirectory).not.toHaveBeenCalled();
  vi.mocked(settingsApi.get).mockResolvedValue({
    codexConfigDir: "C:\\old",
    showProviderBalance: true,
    enableLocalProxy: false,
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存 Codex" }));
  await waitFor(() =>
    expect(settingsApi.patchConfigDirectory).toHaveBeenCalledWith(
      "codex",
      path,
    ),
  );
  expect(settingsApi.get).toHaveBeenCalledTimes(1);
  expect(settingsApi.save).not.toHaveBeenCalled();
});
it("rejects relative paths and resets defaults only on explicit save", async () => {
  await mount();
  fireEvent.change(screen.getByLabelText("Codex目录"), {
    target: { value: "../bad" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存 Codex" }));
  expect(await screen.findByRole("status")).toHaveTextContent("绝对路径");
  expect(settingsApi.save).not.toHaveBeenCalled();
  expect(settingsApi.patchConfigDirectory).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Codex目录"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存 Codex" }));
  await waitFor(() =>
    expect(settingsApi.patchConfigDirectory).toHaveBeenCalledWith(
      "codex",
      null,
    ),
  );
});
it("saves the app directory via the dedicated backend without saving tool settings", async () => {
  await mount();
  fireEvent.change(screen.getByLabelText("应用数据目录目录"), {
    target: { value: "D:\\app-data" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存 应用数据目录" }));
  await waitFor(() =>
    expect(settingsApi.setAppConfigDirOverride).toHaveBeenCalledWith(
      "D:\\app-data",
    ),
  );
  expect(settingsApi.save).not.toHaveBeenCalled();
  expect(settingsApi.patchConfigDirectory).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("重启应用后生效");
});
it("blocks saves after a failed load", async () => {
  vi.mocked(settingsApi.get).mockRejectedValue(new Error("failed"));
  render(<ConfigDirectoriesPanel />);
  expect(await screen.findByRole("status")).toHaveTextContent("读取目录失败");
  expect(screen.getByRole("button", { name: "保存 Codex" })).toBeDisabled();
});

it.each([
  ["claude", "Claude Code", "/tmp/claude"],
  ["codex", "Codex", "C:/codex"],
  ["gemini", "Gemini", "/tmp/gemini"],
  ["grokbuild", "Grok Build", "/tmp/grok"],
  ["opencode", "OpenCode", "/tmp/opencode"],
  ["openclaw", "OpenClaw", "/tmp/openclaw"],
  ["hermes", "Hermes", "/tmp/hermes"],
])("patches only %s and trims the path", async (app, label, path) => {
  await mount();
  fireEvent.change(screen.getByLabelText(`${label}目录`), {
    target: { value: `  ${path}  ` },
  });
  fireEvent.click(screen.getByRole("button", { name: `保存 ${label}` }));
  await waitFor(() =>
    expect(settingsApi.patchConfigDirectory).toHaveBeenCalledWith(app, path),
  );
  expect(settingsApi.patchConfigDirectory).toHaveBeenCalledTimes(1);
  expect(settingsApi.save).not.toHaveBeenCalled();
  expect(settingsApi.get).toHaveBeenCalledTimes(1);
});

it("reports a rejected patch without falling back to a full save", async () => {
  await mount();
  vi.mocked(settingsApi.patchConfigDirectory).mockRejectedValue(
    new Error("patch failed"),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存 Codex" }));
  expect(await screen.findByRole("status")).toHaveTextContent("patch failed");
  expect(settingsApi.save).not.toHaveBeenCalled();
  expect(settingsApi.get).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "保存 Codex" })).toBeEnabled();
});
