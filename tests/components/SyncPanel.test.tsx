import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/types";

const mocks = vi.hoisted(() => ({
  api: {
    webdavSyncFetchRemoteInfo: vi.fn(),
    webdavSyncUpload: vi.fn(),
    webdavSyncDownload: vi.fn(),
    webdavSyncSaveSettings: vi.fn(),
    s3SyncFetchRemoteInfo: vi.fn(),
    s3SyncUpload: vi.fn(),
    s3SyncDownload: vi.fn(),
    s3SyncSaveSettings: vi.fn(),
    getCodexImportReview: vi.fn(),
    confirmCodexImportSync: vi.fn(),
  },
  invalidate: vi.fn(),
  refresh: vi.fn(),
  busy: vi.fn(),
}));
vi.mock("@/lib/api/settings", () => ({ settingsApi: mocks.api }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
import { SyncPanel } from "@/components/settings/SyncPanel";

const settings = {
  webdavSync: {
    enabled: true,
    autoSync: false,
    baseUrl: "https://private.invalid",
    password: "SECRET",
  },
  s3Sync: {
    enabled: true,
    autoSync: false,
    bucket: "private",
    secretAccessKey: "SECRET",
  },
} as Settings;
const mount = (value = settings) =>
  render(
    <SyncPanel
      settings={value}
      onRefresh={mocks.refresh}
      onBusyChange={mocks.busy}
    />,
  );
const confirm = () =>
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

beforeEach(() => {
  Object.values(mocks.api).forEach((fn) => fn.mockReset());
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.api.webdavSyncFetchRemoteInfo.mockResolvedValue({ compatible: true });
  mocks.api.s3SyncFetchRemoteInfo.mockResolvedValue({ compatible: true });
  mocks.api.webdavSyncUpload.mockResolvedValue({ status: "success" });
  mocks.api.s3SyncUpload.mockResolvedValue({ status: "success" });
  mocks.api.webdavSyncDownload.mockResolvedValue({ status: "success" });
  mocks.api.s3SyncDownload.mockResolvedValue({ status: "success" });
  mocks.api.getCodexImportReview.mockResolvedValue(null);
});

describe("manual cloud sync", () => {
  it("does nothing on mount, including persisted autoSync, and disables missing configs", () => {
    const view = mount({
      ...settings,
      webdavSync: { ...settings.webdavSync, autoSync: true },
      s3Sync: undefined,
    });
    Object.values(mocks.api).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "WebDAV 手动上传" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "S3 下载并覆盖" }),
    ).toBeDisabled();
    expect(view.container.textContent).not.toContain("SECRET");
    expect(view.container.textContent).not.toContain("private.invalid");
  });

  it.each(["WebDAV", "S3"])(
    "requires confirmation and supports cancellation for %s",
    (label) => {
      mount();
      fireEvent.click(
        screen.getByRole("button", { name: `${label} 下载并覆盖` }),
      );
      expect(screen.getByText(/下载将覆盖当前应用数据库/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      Object.values(mocks.api).forEach((fn) =>
        expect(fn).not.toHaveBeenCalled(),
      );
    },
  );

  it.each(["WebDAV", "S3"])(
    "uploads %s only after explicit overwrite confirmation",
    async (label) => {
      mount();
      fireEvent.click(
        screen.getByRole("button", { name: `${label} 手动上传` }),
      );
      expect(screen.getByText(/可能覆盖远端快照/)).toBeInTheDocument();
      expect(mocks.api.webdavSyncUpload).not.toHaveBeenCalled();
      expect(mocks.api.s3SyncUpload).not.toHaveBeenCalled();
      confirm();
      await screen.findByText("手动上传已完成。");
      expect(
        label === "WebDAV"
          ? mocks.api.webdavSyncUpload
          : mocks.api.s3SyncUpload,
      ).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["WebDAV", "S3"])(
    "downloads %s, refreshes, then requires separate import approval",
    async (label) => {
      mocks.api.getCodexImportReview.mockResolvedValue({
        providers: [
          {
            id: "p",
            name: "provider",
            stripped: ["hooks"],
            needsConfirmation: ["CUSTOM_ENV"],
          },
        ],
      });
      mount();
      fireEvent.click(
        screen.getByRole("button", { name: `${label} 下载并覆盖` }),
      );
      confirm();
      await screen.findByText(/待确认 CUSTOM_ENV/);
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
      expect(
        label === "WebDAV"
          ? mocks.api.webdavSyncDownload
          : mocks.api.s3SyncDownload,
      ).toHaveBeenCalledTimes(1);
      expect(mocks.invalidate).toHaveBeenCalledTimes(1);
      expect(mocks.api.confirmCodexImportSync).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "确认审核并同步 Codex" }),
        ).toBeEnabled(),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "确认审核并同步 Codex" }),
      );
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
      expect(mocks.api.confirmCodexImportSync).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ empty: true }, { compatible: false }])(
    "refuses missing or incompatible snapshots: %j",
    async (info) => {
      mocks.api.webdavSyncFetchRemoteInfo.mockResolvedValue(info);
      mount();
      fireEvent.click(
        screen.getByRole("button", { name: "WebDAV 下载并覆盖" }),
      );
      confirm();
      await screen.findByText("远端没有可下载的兼容快照，未执行下载。");
      expect(mocks.api.webdavSyncDownload).not.toHaveBeenCalled();
    },
  );

  it("shows sanitized errors and retries review without repeating download", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.api.getCodexImportReview.mockRejectedValueOnce(
      new Error("SECRET https://private.invalid"),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: "WebDAV 下载并覆盖" }));
    confirm();
    await screen.findByText(/操作未完整完成/);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "WebDAV 下载并覆盖" }),
    ).toBeDisabled();
    expect(document.body.textContent).not.toContain("SECRET");
    expect(log).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试审核与刷新" }));
    await screen.findByText("审核与本地数据已刷新。");
    expect(mocks.api.webdavSyncDownload).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCodexImportReview).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("keeps warnings visible and supports refresh failure recovery", async () => {
    mocks.api.s3SyncDownload.mockResolvedValue({
      status: "success",
      warning: "SECRET",
    });
    mocks.refresh.mockRejectedValueOnce(new Error("SECRET"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "S3 下载并覆盖" }));
    confirm();
    await screen.findByText(/操作未完整完成/);
    expect(screen.getByText(/工具配置同步有警告/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("SECRET");
    fireEvent.click(screen.getByRole("button", { name: "重试审核与刷新" }));
    await screen.findByText("审核与本地数据已刷新。");
    expect(mocks.api.s3SyncDownload).toHaveBeenCalledTimes(1);
  });

  it.each(["WebDAV", "S3"])(
    "turns off %s autoSync locally without testing or transferring",
    async (label) => {
      mocks.api.webdavSyncSaveSettings.mockResolvedValue({ success: true });
      mocks.api.s3SyncSaveSettings.mockResolvedValue({ success: true });
      mount({
        ...settings,
        webdavSync: { ...settings.webdavSync, autoSync: true },
        s3Sync: { ...settings.s3Sync, autoSync: true },
      });
      fireEvent.click(
        screen.getByRole("button", { name: `关闭 ${label} 自动同步` }),
      );
      await screen.findByText("自动同步已关闭，未发起连接测试或同步。");
      expect(
        label === "WebDAV"
          ? mocks.api.webdavSyncSaveSettings
          : mocks.api.s3SyncSaveSettings,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ autoSync: false }),
        false,
      );
      expect(mocks.api.webdavSyncFetchRemoteInfo).not.toHaveBeenCalled();
      expect(mocks.api.s3SyncFetchRemoteInfo).not.toHaveBeenCalled();
      expect(mocks.api.webdavSyncUpload).not.toHaveBeenCalled();
      expect(mocks.api.s3SyncDownload).not.toHaveBeenCalled();
    },
  );
});

it("shows upload failure without reporting success or leaking remote errors", async () => {
  mocks.api.s3SyncUpload.mockRejectedValue(new Error("SECRET"));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "S3 手动上传" }));
  confirm();
  await screen.findByText(/操作未完整完成/);
  expect(screen.queryByText("手动上传已完成。")).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("SECRET");
});
it("locks repeated operations until a pending transfer completes", async () => {
  let finish!: (value: { status: string }) => void;
  mocks.api.webdavSyncUpload.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mount();
  fireEvent.click(screen.getByRole("button", { name: "WebDAV 手动上传" }));
  confirm();
  expect(screen.getByRole("button", { name: "S3 手动上传" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "S3 手动上传" }));
  expect(mocks.api.webdavSyncUpload).toHaveBeenCalledTimes(1);
  expect(mocks.api.s3SyncUpload).not.toHaveBeenCalled();
  finish({ status: "success" });
  await screen.findByText("手动上传已完成。");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "S3 手动上传" })).toBeEnabled(),
  );
});

it.each(["WebDAV", "S3"])(
  "creates %s configuration locally, reloads it and unlocks manual sync",
  async (label) => {
    const view = mount({} as Settings);
    const save =
      label === "WebDAV"
        ? mocks.api.webdavSyncSaveSettings
        : mocks.api.s3SyncSaveSettings;
    save.mockResolvedValue({ success: true });
    mocks.refresh.mockImplementation(async () => {
      const saved = save.mock.calls[0][0];
      view.rerender(
        <SyncPanel
          settings={
            {
              [label === "WebDAV" ? "webdavSync" : "s3Sync"]: saved,
            } as Settings
          }
          onRefresh={mocks.refresh}
          onBusyChange={mocks.busy}
        />,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: `配置 ${label}` }));
    expect(save).not.toHaveBeenCalled();
    const values =
      label === "WebDAV"
        ? {
            "服务器 URL": "https://dav.invalid",
            用户名: "user",
            密码: "NEW_SECRET",
          }
        : {
            "Endpoint（AWS 可留空）": "https://s3.invalid",
            Region: "auto",
            Bucket: "bucket",
            "Access Key ID": "id",
            "Secret Access Key": "NEW_SECRET",
          };
    for (const [field, value] of Object.entries(values))
      fireEvent.change(screen.getByLabelText(`${label} ${field}`), {
        target: { value },
      });
    const password = screen.getByLabelText(
      `${label} ${label === "WebDAV" ? "密码" : "Secret Access Key"}`,
    );
    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: `保存 ${label} 配置` }));
    await screen.findByText(
      "配置已保存并重新读取，可手动同步；自动同步关闭，未测试连接。",
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        autoSync: false,
        remoteRoot: "cc-switch-sync",
        profile: "default",
        [label === "WebDAV" ? "password" : "secretAccessKey"]: "NEW_SECRET",
      }),
      true,
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: `${label} 手动上传` }),
    ).toBeEnabled();
    expect(mocks.api.webdavSyncUpload).not.toHaveBeenCalled();
    expect(mocks.api.s3SyncUpload).not.toHaveBeenCalled();
    expect(mocks.api.webdavSyncFetchRemoteInfo).not.toHaveBeenCalled();
    expect(mocks.api.s3SyncFetchRemoteInfo).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `配置 ${label}` }));
    expect(
      screen.getByLabelText(
        `${label} ${label === "WebDAV" ? "密码" : "Secret Access Key"}`,
      ),
    ).toHaveValue("");
  },
);

it.each(["WebDAV", "S3"])(
  "never prefills %s secrets and preserves unchanged credentials on save",
  async (label) => {
    const save =
      label === "WebDAV"
        ? mocks.api.webdavSyncSaveSettings
        : mocks.api.s3SyncSaveSettings;
    save.mockResolvedValue({ success: true });
    mount({
      ...settings,
      webdavSync: { ...settings.webdavSync, username: "user", autoSync: true },
      s3Sync: {
        ...settings.s3Sync,
        region: "auto",
        accessKeyId: "id",
        autoSync: true,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: `配置 ${label}` }));
    const secret = label === "WebDAV" ? "password" : "secretAccessKey";
    expect(
      screen.getByLabelText(
        `${label} ${label === "WebDAV" ? "密码" : "Secret Access Key"}`,
      ),
    ).toHaveValue("");
    expect(screen.queryByDisplayValue("SECRET")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `保存 ${label} 配置` }));
    await screen.findByText(
      "配置已保存并重新读取，可手动同步；自动同步关闭，未测试连接。",
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ [secret]: "", autoSync: false }),
      false,
    );
  },
);

it("shows save failures without secrets, and does not claim a completed refresh", async () => {
  mocks.api.webdavSyncSaveSettings.mockRejectedValue(new Error("NEW_SECRET"));
  mount({} as Settings);
  fireEvent.click(screen.getByRole("button", { name: "配置 WebDAV" }));
  fireEvent.change(screen.getByLabelText("WebDAV 服务器 URL"), {
    target: { value: "https://dav.invalid" },
  });
  fireEvent.change(screen.getByLabelText("WebDAV 用户名"), {
    target: { value: "user" },
  });
  fireEvent.change(screen.getByLabelText("WebDAV 密码"), {
    target: { value: "NEW_SECRET" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存 WebDAV 配置" }));
  await screen.findByText(/操作未完整完成/);
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(screen.getByLabelText("WebDAV 密码")).toHaveValue("");
  expect(document.body.textContent).not.toContain("NEW_SECRET");
  expect(screen.queryByText(/配置已保存并重新读取/)).not.toBeInTheDocument();
});
