import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoveProviderFromLiveMutation } from "@/lib/query/mutations";

const apiMocks = vi.hoisted(() => ({
  removeFromLiveConfig: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  providersApi: {
    removeFromLiveConfig: (...args: unknown[]) =>
      apiMocks.removeFromLiveConfig(...args),
  },
  sessionsApi: {},
  settingsApi: {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  apiMocks.removeFromLiveConfig.mockReset().mockResolvedValue(true);
});

describe("useRemoveProviderFromLiveMutation", () => {
  it("removes a Pi line from live config without deleting the saved line", async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useRemoveProviderFromLiveMutation("pi"),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync("example");
    });
    expect(apiMocks.removeFromLiveConfig).toHaveBeenCalledWith("example", "pi");
  });
});
