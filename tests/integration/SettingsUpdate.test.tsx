import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewSettingsView } from "@/views/NewSettingsView";

const { checkUpdateMock, installUpdateMock, toastInfoMock, useUpdateMock } =
  vi.hoisted(() => ({
    checkUpdateMock: vi.fn(),
    installUpdateMock: vi.fn(),
    toastInfoMock: vi.fn(),
    useUpdateMock: vi.fn(),
  }));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => useUpdateMock(),
}));

vi.mock("sonner", () => ({
  toast: {
    info: toastInfoMock,
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("settings application update", () => {
  beforeEach(() => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      updateInfo: {
        currentVersion: "2.0.12",
        availableVersion: "2.0.13",
        notes: "First fix\nSecond fix",
      },
      isChecking: false,
      error: null,
      lastCheckedAt: Date.now(),
      stagedVersion: null,
      isStaging: false,
      checkUpdate: checkUpdateMock,
      installUpdate: installUpdateMock,
      isInstalling: false,
      downloadProgress: null,
    });
  });

  it("starts the download and install flow directly from the update button", async () => {
    installUpdateMock.mockResolvedValueOnce(false);
    render(<NewSettingsView />);

    expect(screen.getByText(/First fix/)).toHaveTextContent(
      "First fix Second fix",
    );
    fireEvent.click(
      screen.getByRole("button", { name: /\u4e0b\u8f7d\u5e76\u5b89\u88c5/ }),
    );

    await waitFor(() => {
      expect(installUpdateMock).toHaveBeenCalledTimes(1);
    });
    expect(toastInfoMock).toHaveBeenCalledWith(
      "\u8be5\u66f4\u65b0\u5df2\u4e0d\u53ef\u7528",
      {
        description: "\u5df2\u91cd\u65b0\u68c0\u67e5\u66f4\u65b0",
      },
    );
  });

  it("changes the primary action after the package has been staged", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      updateInfo: {
        currentVersion: "2.0.12",
        availableVersion: "2.0.13",
        notes: "First fix",
      },
      isChecking: false,
      error: null,
      lastCheckedAt: Date.now(),
      stagedVersion: "2.0.13",
      isStaging: false,
      checkUpdate: checkUpdateMock,
      installUpdate: installUpdateMock,
      isInstalling: false,
      downloadProgress: null,
    });
    render(<NewSettingsView />);

    expect(
      screen.getByRole("button", { name: /\u5b89\u88c5\u5e76\u91cd\u542f/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "\u66f4\u65b0\u5305\u5df2\u4e0b\u8f7d\u5e76\u901a\u8fc7\u9a8c\u8bc1\uff0c\u5b89\u88c5\u540e\u5e94\u7528\u5c06\u81ea\u52a8\u91cd\u542f",
      ),
    ).toBeInTheDocument();
  });

  it("shows progress from the shared update context", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      updateInfo: {
        currentVersion: "2.0.12",
        availableVersion: "2.0.13",
        notes: "First fix",
      },
      isChecking: false,
      error: null,
      lastCheckedAt: Date.now(),
      stagedVersion: null,
      isStaging: false,
      checkUpdate: checkUpdateMock,
      installUpdate: installUpdateMock,
      isInstalling: true,
      downloadProgress: { downloaded: 50, total: 100 },
    });
    render(<NewSettingsView />);

    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(
      screen.getByText("\u6b63\u5728\u4e0b\u8f7d\u66f4\u65b0 50%"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /\u6b63\u5728\u66f4\u65b0\u2026/ }),
    ).toBeDisabled();
  });
});
