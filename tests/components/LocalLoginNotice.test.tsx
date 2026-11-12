import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalLoginNotice } from "@/components/claude-accounts/LocalLoginNotice";
import { claudeAccountsApi } from "@/lib/api/claudeAccounts";

vi.mock("@/lib/api/claudeAccounts", () => ({
  DEFAULT_DESKTOP_ID: "default",
  claudeAccountsApi: {
    desktopSwapStatus: vi.fn(),
    desktopQuota: vi.fn(),
    listCode: vi.fn(),
  },
}));

const api = vi.mocked(claudeAccountsApi, true);

const swap = (overrides: Record<string, unknown> = {}) => ({
  supported: true,
  running: false,
  signedIn: true,
  accountUuid: "uuid-1",
  currentAccountId: null,
  snapshots: [],
  ...overrides,
});

describe("LocalLoginNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names a Desktop sign-in that is not saved and opens the accounts page", async () => {
    api.desktopSwapStatus.mockResolvedValue(swap());
    api.desktopQuota.mockResolvedValue({
      email: "me@example.com",
    } as Awaited<ReturnType<typeof claudeAccountsApi.desktopQuota>>);
    const onOpen = vi.fn();
    render(<LocalLoginNotice mode="desktop" native onOpen={onOpen} />);
    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "去导入" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the Desktop sign-in is already saved", async () => {
    api.desktopSwapStatus.mockResolvedValue(
      swap({ currentAccountId: "saved" }),
    );
    render(<LocalLoginNotice mode="desktop" native onOpen={vi.fn()} />);
    await waitFor(() => expect(api.desktopSwapStatus).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
    expect(api.desktopQuota).not.toHaveBeenCalled();
  });

  it("reports an unsaved Claude Code login, and nothing outside the desktop app", async () => {
    api.listCode.mockResolvedValue({
      supported: true,
      live: { signedIn: true, email: "cc@example.com", savedId: null },
      accounts: [],
    } as unknown as Awaited<ReturnType<typeof claudeAccountsApi.listCode>>);
    const { unmount } = render(
      <LocalLoginNotice mode="code" native onOpen={vi.fn()} />,
    );
    expect(await screen.findByText("cc@example.com")).toBeInTheDocument();
    unmount();

    vi.clearAllMocks();
    render(<LocalLoginNotice mode="code" native={false} onOpen={vi.fn()} />);
    expect(api.listCode).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
