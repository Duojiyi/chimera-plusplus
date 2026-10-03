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

vi.mock("@/hooks/useHermes", () => ({
  invalidateHermesProviderCaches: vi.fn(),
}));

vi.mock("@/hooks/useOpenClaw", () => ({
  openclawKeys: {
    liveProviderIds: ["openclaw", "liveProviderIds"],
  },
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
  it("refetches MiniMax Code providers after removal (cc-switch #7578)", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useRemoveProviderFromLiveMutation("mcode"),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync("custom");
    });

    expect(apiMocks.removeFromLiveConfig).toHaveBeenCalledWith(
      "custom",
      "mcode",
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["providers", "mcode"],
    });
  });
});
