import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  OutboundProxyPanel,
  FailoverSettingsPanel,
} from "@/components/settings/AdvancedConnectionPanels";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/proxy/FailoverQueueManager", () => ({
  FailoverQueueManager: ({
    appType,
    disabled,
  }: {
    appType: string;
    disabled: boolean;
  }) => <button disabled={disabled}>queue {appType}</button>,
}));
vi.mock("@/components/proxy/AutoFailoverConfigPanel", () => ({
  AutoFailoverConfigPanel: ({
    appType,
    disabled,
  }: {
    appType: string;
    disabled: boolean;
  }) => <button disabled={disabled}>threshold {appType}</button>,
}));
function mount(child: React.ReactNode) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {child}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "get_global_proxy_url") return null;
    if (command === "get_proxy_status") return { running: false };
    if (command === "get_proxy_takeover_status")
      return { codex: false, claude: false, gemini: false };
    if (command === "test_proxy_url")
      return { success: true, latencyMs: 5, error: null };
    return undefined;
  });
});
it("reads global proxy only on mount; tests and saves through real command adapters only on click", async () => {
  mount(<OutboundProxyPanel />);
  const input = await screen.findByPlaceholderText(
    "http://127.0.0.1:7890 / socks5://127.0.0.1:1080",
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(([command]) => command === "get_global_proxy_url"),
  ).toBe(true);
  fireEvent.change(input, { target: { value: "socks5://127.0.0.1:1080" } });
  fireEvent.click(screen.getByTitle("settings.globalProxy.test"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("test_proxy_url", {
      url: "socks5://127.0.0.1:1080",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_global_proxy_url", {
      url: "socks5://127.0.0.1:1080",
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("start_proxy_server");
});
it("does not render editable global settings after a read error", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("failed"));
  mount(<OutboundProxyPanel />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "读取全局代理失败",
  );
  expect(
    screen.queryByRole("button", { name: "common.save" }),
  ).not.toBeInTheDocument();
});
it("keeps failover disabled without running takeover, only reads status and isolates tools", async () => {
  mount(<FailoverSettingsPanel />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("get_proxy_takeover_status"),
  );
  expect(screen.getByRole("button", { name: "queue codex" })).toBeDisabled();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(
        ([command]) =>
          command === "get_proxy_status" ||
          command === "get_proxy_takeover_status",
      ),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("故障转移工具"), {
    target: { value: "gemini" },
  });
  expect(
    screen.queryByRole("button", { name: "queue codex" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "threshold gemini" }),
  ).toBeDisabled();
});
it("enables existing queue and threshold management only for a running taken-over tool", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "get_proxy_status"
      ? { running: true }
      : { codex: true, gemini: false },
  );
  mount(<FailoverSettingsPanel />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "queue codex" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("故障转移工具"), {
    target: { value: "gemini" },
  });
  expect(screen.getByRole("button", { name: "queue gemini" })).toBeDisabled();
});
