import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SkillsMcpView } from "@/views/SkillsMcpView";
import {
  skillsApi,
  type InstalledSkill,
  type UnmanagedSkill,
} from "@/lib/api/skills";
import { mcpApi } from "@/lib/api/mcp";
import { officialAccountsApi } from "@/lib/api/officialAccounts";
import { toast } from "sonner";
import type { McpServer } from "@/types";
vi.mock("@/components/mcp/McpFormModal", () => ({
  default: (props: {
    defaultEnabledApps: string[];
    visibleApps: string[];
    defaultFormat: string;
    initialData?: McpServer;
  }) => <div data-testid="mcp-editor">{JSON.stringify(props)}</div>,
}));
vi.mock("@/lib/api/skills", () => ({
  skillsApi: {
    getInstalled: vi.fn(),
    getRepos: vi.fn(),
    addRepo: vi.fn(),
    removeRepo: vi.fn(),
    scanUnmanaged: vi.fn(),
    scanUnmanagedWithSkipped: vi.fn(),
    importFromApps: vi.fn(),
    checkUpdates: vi.fn(),
    updateSkill: vi.fn(),
    getBackups: vi.fn(),
    restoreBackup: vi.fn(),
    deleteBackup: vi.fn(),
    uninstallUnified: vi.fn(),
    toggleApp: vi.fn(),
    openZipFileDialog: vi.fn(),
    installFromZip: vi.fn(),
    discoverAvailable: vi.fn(),
    installUnified: vi.fn(),
  },
}));
vi.mock("@/lib/api/mcp", () => ({
  mcpApi: {
    getAllServers: vi.fn(),
    toggleApp: vi.fn(),
    deleteUnifiedServer: vi.fn(),
  },
}));
vi.mock("@/lib/api/officialAccounts", () => ({
  officialAccountsApi: { getNotes: vi.fn(), setNotes: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
const skill: InstalledSkill = {
  id: "real-skill",
  name: "Real Skill",
  directory: "real",
  installedAt: 0,
  updatedAt: 0,
  apps: {
    claude: false,
    codex: false,
    gemini: false,
    opencode: false,
  },
};
const deferredScan = () => {
  let resolve!: (items: UnmanagedSkill[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<UnmanagedSkill[]>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([]);
  // The view asks for skipped folders too; most tests only stub the list.
  vi.mocked(skillsApi.scanUnmanagedWithSkipped).mockImplementation(
    async (app) => ({
      skills: await skillsApi.scanUnmanaged(app),
      skipped: [],
    }),
  );
  vi.mocked(skillsApi.getInstalled).mockResolvedValue([skill]);
  vi.mocked(mcpApi.getAllServers).mockResolvedValue({});
  vi.mocked(officialAccountsApi.getNotes).mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("connected Skills/MCP page", () => {
  it.each(["claude", "gemini", "opencode"] as const)(
    "toggles only %s and preserves other tools' resource state",
    async (app) => {
      let installed = { ...skill, apps: { ...skill.apps, codex: true } };
      let server: McpServer = {
        id: "real",
        name: "Real MCP",
        apps: { ...skill.apps, codex: true },
        server: { command: "npx" },
      };
      vi.mocked(skillsApi.getInstalled).mockImplementation(async () => [
        installed,
      ]);
      vi.mocked(skillsApi.toggleApp).mockImplementation(
        async (_id, target, enabled) => {
          installed = {
            ...installed,
            apps: { ...installed.apps, [target]: enabled },
          };
          return true;
        },
      );
      vi.mocked(mcpApi.getAllServers).mockImplementation(async () => ({
        real: server,
      }));
      vi.mocked(mcpApi.toggleApp).mockImplementation(
        async (_id, target, enabled) => {
          server = { ...server, apps: { ...server.apps, [target]: enabled } };
        },
      );
      render(<SkillsMcpView initialApp={app} />);
      expect(screen.getByRole("combobox", { name: "目标工具" })).toHaveValue(
        app,
      );
      const toggle = await screen.findByRole("switch", {
        name: "启用 Skill Real Skill",
      });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(skillsApi.toggleApp).toHaveBeenCalledWith(skill.id, app, true);
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(toggle).toBeEnabled();
      });
      expect(installed.apps.codex).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "MCP 1" }));
      const mcpToggle = screen.getByRole("switch", {
        name: "启用 MCP Real MCP",
      });
      expect(mcpToggle).toHaveAttribute("aria-checked", "false");
      fireEvent.click(mcpToggle);
      await waitFor(() =>
        expect(mcpToggle).toHaveAttribute("aria-checked", "true"),
      );
      expect(mcpApi.toggleApp).toHaveBeenCalledWith("real", app, true);
      expect(server.apps.codex).toBe(true);
    },
  );

  it.each(["claude", "gemini", "opencode"] as const)(
    "installs ZIP and repository skills for %s rather than Codex",
    async (app) => {
      const available = {
        key: "repo-skill",
        name: "Repo Skill",
        description: "Repository skill",
        directory: "repo-skill",
        repoOwner: "owner",
        repoName: "repo",
        repoBranch: "main",
      };
      vi.mocked(skillsApi.openZipFileDialog).mockResolvedValue("D:/skills.zip");
      vi.mocked(skillsApi.installFromZip).mockResolvedValue([skill]);
      vi.mocked(skillsApi.discoverAvailable).mockResolvedValue([available]);
      vi.mocked(skillsApi.installUnified).mockResolvedValue(skill);
      render(<SkillsMcpView initialApp={app} />);
      await screen.findByText("Real Skill");
      fireEvent.click(screen.getByRole("button", { name: "安装" }));
      fireEvent.click(screen.getByRole("button", { name: "从 ZIP 安装…" }));
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "目标工具" }),
        ).toBeEnabled(),
      );
      expect(skillsApi.installFromZip).toHaveBeenCalledWith(
        "D:/skills.zip",
        app,
      );
      fireEvent.click(screen.getByRole("button", { name: "读取已配置仓库" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "安装 Repo Skill" }),
      );
      await waitFor(() =>
        expect(skillsApi.installUnified).toHaveBeenCalledWith(available, app),
      );
    },
  );

  it("defaults new MCP to the selected tool and preserves all apps when editing", async () => {
    const server: McpServer = {
      id: "real",
      name: "Real MCP",
      apps: { ...skill.apps, codex: true, gemini: true },
      server: { command: "npx" },
    };
    vi.mocked(mcpApi.getAllServers).mockResolvedValue({ real: server });
    const { unmount } = render(<SkillsMcpView initialApp="claude" />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: "MCP 1" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 MCP" }));
    const props = JSON.parse(
      (await screen.findByTestId("mcp-editor")).textContent!,
    );
    expect(props.defaultEnabledApps).toEqual(["claude"]);
    expect(props.defaultFormat).toBe("json");
    expect(props.visibleApps).toEqual([
      "codex",
      "claude",
      "gemini",
      "grokbuild",
      "opencode",
    ]);
    expect(screen.getByRole("combobox", { name: "目标工具" })).toBeDisabled();
    unmount();
    render(<SkillsMcpView initialApp="claude" />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: "MCP 1" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 MCP Real MCP" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      JSON.parse((await screen.findByTestId("mcp-editor")).textContent!)
        .initialData.apps,
    ).toEqual(server.apps);
  });

  it("opens MCP details from a named button and reports the expanded state", async () => {
    vi.mocked(mcpApi.getAllServers).mockResolvedValue({
      real: {
        id: "real",
        name: "HTTP MCP",
        apps: skill.apps,
        server: { url: "https://example.invalid/mcp", type: "http" },
      },
    });
    render(<SkillsMcpView />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: "MCP 1" }));
    const trigger = screen.getByRole("button", { name: "查看 MCP HTTP MCP" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "MCP 详情" })).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("远程连接")).toBeVisible();
    expect(screen.queryByText("启动命令")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭 MCP 详情" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
  it("redacts credential maps in the downloaded MCP configuration without mutating live data", async () => {
    const server = {
      command: "npx",
      args: ["demo-mcp", "--token", "synthetic-arg-secret"],
      url: "https://example.invalid/?token=synthetic-url-secret",
      note: "synthetic-note-secret",
      extension: { token: "synthetic-extension-secret" },
      env: { TOKEN: "synthetic-env-secret", CUSTOM: "short" },
      headers: {
        Authorization: "Bearer synthetic-header-secret",
        "X-Private": "synthetic-private-header",
      },
      http_headers: { "X-API-Key": "synthetic-http-header-secret" },
    };
    const original = JSON.stringify(server);
    vi.mocked(mcpApi.getAllServers).mockResolvedValue({
      real: { id: "real", name: "Real MCP", apps: skill.apps, server },
      plain: {
        id: "plain",
        name: "Plain MCP",
        apps: skill.apps,
        server: { command: "plain-mcp" },
      },
    });
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:mcp-export");
        static revokeObjectURL = vi.fn();
      },
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    render(<SkillsMcpView />);
    await screen.findByText("Real Skill");
    const exportNotice =
      "环境变量与请求头已脱敏；分享前请检查地址、启动参数和备注";
    const exportScope = `导出全部工具的共享资源与启用状态。${exportNotice}`;
    const exportButton = screen.getByRole("button", { name: "导出" });
    expect(screen.getByText("导出前请检查敏感信息")).toBeVisible();
    expect(screen.queryByText(exportScope)).not.toBeInTheDocument();
    expect(exportButton).toHaveAccessibleDescription("导出前请检查敏感信息");
    expect(exportButton).toHaveAttribute("title", exportScope);
    expect(
      screen.getByRole("heading", { level: 1, name: "Codex · Skills 与 MCP" }),
    ).toBeVisible();
    expect(screen.queryByText(/密钥与令牌值已脱敏/)).not.toBeInTheDocument();
    fireEvent.click(exportButton);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/json;charset=utf-8");
    const payload = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    const exported = JSON.parse(payload);
    expect(exported.skills).toEqual([skill]);
    expect(exported.mcpServers[0].server).toEqual({
      command: "npx",
      args: ["demo-mcp", "--token", "synthetic-arg-secret"],
      url: "https://example.invalid/?token=synthetic-url-secret",
      note: "synthetic-note-secret",
      extension: { token: "synthetic-extension-secret" },
      env: { TOKEN: "[已设置]", CUSTOM: "[已设置]" },
      headers: { Authorization: "[已设置]", "X-Private": "[已设置]" },
      http_headers: { "X-API-Key": "[已设置]" },
    });
    expect(exported.mcpServers[1].server).toEqual({ command: "plain-mcp" });
    for (const secret of [
      ...Object.values(server.env),
      ...Object.values(server.headers),
      ...Object.values(server.http_headers),
    ])
      expect(payload).not.toContain(secret);
    expect(JSON.stringify(server)).toBe(original);
    expect(click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mcp-export");
    expect(toast.success).toHaveBeenCalledWith(`已导出配置。${exportNotice}`);
  });

  it.each([
    { registered: true, flag: undefined, enabled: true },
    { registered: true, flag: true, enabled: true },
    { registered: true, flag: false, enabled: false },
    { registered: false, flag: undefined, enabled: false },
    { registered: false, flag: true, enabled: false },
    { registered: false, flag: false, enabled: false },
  ])(
    "uses the effective MCP state for registration=$registered and enabled=$flag",
    async ({ registered, flag, enabled }) => {
      vi.mocked(mcpApi.getAllServers).mockResolvedValue({
        real: {
          id: "real",
          name: "Real MCP",
          apps: { ...skill.apps, codex: registered },
          server: { command: "npx", enabled: flag },
        },
      });
      render(<SkillsMcpView />);
      await screen.findByText("Real Skill");
      fireEvent.click(screen.getByRole("button", { name: /MCP 1/ }));
      expect(
        screen.getByRole("switch", { name: "启用 MCP Real MCP" }),
      ).toHaveAttribute("aria-checked", String(enabled));
      expect(screen.getByText(`${enabled ? 1 : 0} / 1`)).toBeVisible();
    },
  );

  it("round-trips a disabled Codex-only MCP through on, off and on after authoritative reloads", async () => {
    let server: McpServer = {
      id: "real",
      name: "Real MCP",
      apps: { ...skill.apps, codex: true },
      server: { command: "npx", enabled: false },
    };
    vi.mocked(mcpApi.getAllServers).mockImplementation(async () => ({
      real: server,
    }));
    vi.mocked(mcpApi.toggleApp).mockImplementation(
      async (_id, _app, enabled) => {
        server = {
          ...server,
          server: enabled
            ? { command: "npx" }
            : { command: "npx", enabled: false },
        };
      },
    );
    render(<SkillsMcpView />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: /MCP 1/ }));
    const toggle = screen.getByRole("switch", { name: "启用 MCP Real MCP" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    for (const [index, enabled] of [true, false, true].entries()) {
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(mcpApi.toggleApp).toHaveBeenNthCalledWith(
          index + 1,
          "real",
          "codex",
          enabled,
        );
        expect(toggle).toHaveAttribute("aria-checked", String(enabled));
        expect(toggle).toBeEnabled();
      });
      expect(screen.getByText(`${enabled ? 1 : 0} / 1`)).toBeVisible();
      expect(server.apps.codex).toBe(true);
    }
    expect(mcpApi.getAllServers).toHaveBeenCalledTimes(4);
  });

  it.each(["claude", "gemini", "grokbuild", "opencode"] as const)(
    "keeps Codex soft-disable isolated while toggling %s on and off",
    async (app) => {
      let server: McpServer = {
        id: "real",
        name: "Real MCP",
        apps: { ...skill.apps, grokbuild: false, codex: true },
        server: { command: "npx" },
      };
      vi.mocked(mcpApi.getAllServers).mockImplementation(async () => ({
        real: server,
      }));
      vi.mocked(mcpApi.toggleApp).mockImplementation(
        async (_id, target, enabled) => {
          server =
            target === "codex"
              ? { ...server, server: { ...server.server, enabled } }
              : { ...server, apps: { ...server.apps, [target]: enabled } };
        },
      );
      render(<SkillsMcpView />);
      await screen.findByText("Real Skill");
      fireEvent.click(screen.getByRole("button", { name: "MCP 1" }));
      const toggle = screen.getByRole("switch", { name: "启用 MCP Real MCP" });
      const target = screen.getByRole("combobox", { name: "目标工具" });
      expect(toggle).toHaveAttribute("aria-checked", "true");
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(mcpApi.toggleApp).toHaveBeenNthCalledWith(
          1,
          "real",
          "codex",
          false,
        );
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(target).toBeEnabled();
      });
      fireEvent.change(target, { target: { value: app } });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      for (const [index, enabled] of [true, false].entries()) {
        fireEvent.click(toggle);
        await waitFor(() => {
          expect(mcpApi.toggleApp).toHaveBeenNthCalledWith(
            index + 2,
            "real",
            app,
            enabled,
          );
          expect(toggle).toHaveAttribute("aria-checked", String(enabled));
          expect(toggle).toBeEnabled();
        });
        expect(screen.getByText(`${enabled ? 1 : 0} / 1`)).toBeVisible();
        expect(server.apps[app]).toBe(enabled);
        expect(server.apps.codex).toBe(true);
        expect(server.server.enabled).toBe(false);
        fireEvent.change(target, { target: { value: "codex" } });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        fireEvent.change(target, { target: { value: app } });
        expect(toggle).toHaveAttribute("aria-checked", String(enabled));
      }
      expect(mcpApi.getAllServers).toHaveBeenCalledTimes(4);
      expect(mcpApi.toggleApp).toHaveBeenCalledTimes(3);
    },
  );

  it("shows only real installed rows and no sample installer", async () => {
    render(<SkillsMcpView />);
    expect(await screen.findByText("Real Skill")).toBeInTheDocument();
    expect(screen.queryByText("skill-creator")).not.toBeInTheDocument();
    expect(screen.queryByText("安装 Skill")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeEnabled();
  });
  it("does not pretend a failed toggle succeeded", async () => {
    vi.mocked(skillsApi.toggleApp).mockRejectedValue(
      new Error("native failure"),
    );
    render(<SkillsMcpView />);
    const toggle = await screen.findByRole("switch", {
      name: "启用 Skill Real Skill",
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(skillsApi.toggleApp).toHaveBeenCalledWith(
      "real-skill",
      "codex",
      true,
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
  it("serializes pending mutations and reloads authoritative state", async () => {
    let resolve!: (value: boolean) => void;
    vi.mocked(skillsApi.toggleApp).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<SkillsMcpView />);
    const toggle = await screen.findByRole("switch", {
      name: "启用 Skill Real Skill",
    });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(skillsApi.toggleApp).toHaveBeenCalledTimes(1);
    expect(toggle).toBeDisabled();
    vi.mocked(skillsApi.getInstalled).mockResolvedValue([
      { ...skill, apps: { ...skill.apps, codex: true } },
    ]);
    await act(async () => resolve(true));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });
  it("reports load failure and retries without fixtures", async () => {
    vi.mocked(skillsApi.getInstalled).mockRejectedValueOnce(
      new Error("offline"),
    );
    render(<SkillsMcpView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    // A failed read claims nothing: no counts, summary card or empty state.
    expect(screen.getByRole("button", { name: "Skills" })).toBeInTheDocument();
    expect(screen.queryByText("已启用 Skills")).not.toBeInTheDocument();
    expect(
      screen.queryByText("尚未由 Chimera++ 管理 Skills"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Real Skill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skills 1" })).toBeVisible();
  });
  it("drops rows and counts when a later refresh fails", async () => {
    const view = render(<SkillsMcpView refreshVersion={0} />);
    await screen.findByText("Real Skill");
    vi.mocked(skillsApi.getInstalled).mockRejectedValueOnce(
      new Error("offline"),
    );
    view.rerender(<SkillsMcpView refreshVersion={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    expect(screen.queryByText("Real Skill")).not.toBeInTheDocument();
    expect(screen.queryByText("已启用 Skills")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skills" })).toBeInTheDocument();
  });
  it("uses the existing ZIP picker and installer", async () => {
    vi.mocked(skillsApi.openZipFileDialog).mockResolvedValue("D:/skills.zip");
    vi.mocked(skillsApi.installFromZip).mockResolvedValue([skill]);
    render(<SkillsMcpView />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    fireEvent.click(screen.getByRole("button", { name: "从 ZIP 安装…" }));
    await waitFor(() =>
      expect(skillsApi.installFromZip).toHaveBeenCalledWith(
        "D:/skills.zip",
        "codex",
      ),
    );
  });
  it("does not install when the picker is cancelled", async () => {
    vi.mocked(skillsApi.openZipFileDialog).mockResolvedValue(null);
    render(<SkillsMcpView />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    fireEvent.click(screen.getByRole("button", { name: "从 ZIP 安装…" }));
    await waitFor(() =>
      expect(skillsApi.getInstalled).toHaveBeenCalledTimes(2),
    );
    expect(skillsApi.installFromZip).not.toHaveBeenCalled();
  });
  it("keeps note editing open when persistence fails", async () => {
    vi.mocked(officialAccountsApi.setNotes).mockRejectedValue(
      new Error("missing row"),
    );
    render(<SkillsMcpView />);
    fireEvent.click(await screen.findByRole("button", { name: "添加备注" }));
    fireEvent.change(screen.getByRole("textbox", { name: "备注" }), {
      target: { value: "my note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(officialAccountsApi.setNotes).toHaveBeenCalledWith(
      "skills",
      "real-skill",
      "my note",
    );
    expect(screen.getByRole("textbox", { name: "备注" })).toHaveValue(
      "my note",
    );
  });
  it("does not carry a skill note into an MCP with the same ID", async () => {
    vi.mocked(mcpApi.getAllServers).mockResolvedValue({
      [skill.id]: {
        id: skill.id,
        name: "Real MCP",
        apps: skill.apps,
        server: { command: "npx" },
      },
    });
    render(<SkillsMcpView />);
    fireEvent.click(await screen.findByRole("button", { name: "添加备注" }));
    fireEvent.change(screen.getByRole("textbox", { name: "备注" }), {
      target: { value: "skill-only note" },
    });
    fireEvent.click(screen.getByRole("button", { name: /MCP 1/ }));
    expect(
      screen.queryByRole("textbox", { name: "备注" }),
    ).not.toBeInTheDocument();
    expect(officialAccountsApi.setNotes).not.toHaveBeenCalled();
  });

  it("requires confirmation and retains an MCP after failed deletion", async () => {
    vi.mocked(mcpApi.getAllServers).mockResolvedValue({
      real: {
        id: "real",
        name: "Real MCP",
        apps: skill.apps,
        server: { command: "npx" },
      },
    });
    vi.mocked(mcpApi.deleteUnifiedServer).mockResolvedValue(false);
    render(<SkillsMcpView />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: /MCP 1/ }));
    fireEvent.click(screen.getByText("Real MCP"));
    fireEvent.click(screen.getByRole("button", { name: "移除…" }));
    expect(mcpApi.deleteUnifiedServer).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "移除" }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(mcpApi.deleteUnifiedServer).toHaveBeenCalledWith("real");
    expect(screen.getAllByText("Real MCP").length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not leak command arguments, env values or URL tokens in details", async () => {
    vi.mocked(mcpApi.getAllServers).mockResolvedValue({
      real: {
        id: "real",
        name: "Real MCP",
        apps: skill.apps,
        server: {
          command: "private-command",
          args: ["--token", "secret-args"],
          env: { TOKEN: "secret-env" },
          url: "https://example.com/?token=secret-url",
        },
      },
    });
    render(<SkillsMcpView />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: /MCP 1/ }));
    fireEvent.click(screen.getByText("Real MCP"));
    expect(screen.getByText("[已设置]")).toBeInTheDocument();
    for (const secret of [
      "secret-args",
      "secret-env",
      "secret-url",
      "private-command",
    ])
      expect(document.body.textContent).not.toContain(secret);
  });
});

describe("A06 resource lifecycle and A07 refresh", () => {
  const backup = {
    backupId: "backup-1",
    backupPath: "mock/backup",
    createdAt: 1,
    skill,
  };
  it.each(["codex", "claude", "gemini", "grokbuild", "opencode"] as const)(
    "scans only %s by default and imports the confirmed source snapshot to that tool",
    async (app) => {
      const local: UnmanagedSkill = {
        directory: "local",
        name: "Local",
        path: `D:/${app}/skills/local`,
        foundIn: [app],
        contentHash: "local-snapshot",
      };
      vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([local]);
      vi.mocked(skillsApi.importFromApps).mockResolvedValue([skill]);
      render(<SkillsMcpView initialApp={app} />);
      const checkbox = await screen.findByRole("checkbox", {
        name: "添加 Local",
      });
      const scopeCheckbox = screen.getByRole("checkbox", {
        name: "同时发现其他工具的 Skills",
      });
      const targetSelect = screen.getByRole("combobox", { name: "目标工具" });
      expect(skillsApi.scanUnmanaged).toHaveBeenCalledExactlyOnceWith(app);
      expect(scopeCheckbox).not.toBeChecked();
      expect(skillsApi.importFromApps).not.toHaveBeenCalled();
      fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "添加所选 Skills" }));
      expect(skillsApi.importFromApps).not.toHaveBeenCalled();
      expect(targetSelect).toBeDisabled();
      expect(scopeCheckbox).toBeDisabled();
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "添加 1 个",
        }),
      );
      await waitFor(() =>
        expect(skillsApi.importFromApps).toHaveBeenCalledExactlyOnceWith([
          {
            directory: local.directory,
            sourcePath: local.path,
            contentHash: local.contentHash,
            apps: {
              claude: false,
              codex: false,
              gemini: false,
              grokbuild: false,
              opencode: false,
              [app]: true,
            },
          },
        ]),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(
        screen.getByRole("checkbox", { name: "添加 Local" }),
      ).not.toBeChecked();
    },
  );

  it("names local Skill folders the scan had to skip", async () => {
    vi.mocked(skillsApi.scanUnmanagedWithSkipped).mockResolvedValue({
      skills: [],
      skipped: [
        {
          directory: "broken",
          foundIn: ["codex", "agents"],
          reason: "无法读取目录或文件",
        },
      ],
    });
    render(<SkillsMcpView initialApp="codex" />);
    const notice = await screen.findByTestId("skills-scan-skipped");
    expect(notice).toHaveTextContent(
      "1 个本地 Skill 目录无法读取或校验，已跳过：broken（无法读取目录或文件，来源：Codex、通用目录 .agents）。",
    );
    expect(screen.getByText("未发现可添加的本地 Skills。")).toBeVisible();
  });

  it("accepts one backend-merged row for identical copies across tool directories", async () => {
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([
      {
        directory: "same",
        name: "Shared",
        path: "D:/shared/same",
        foundIn: ["codex", "gemini", "agents"],
        contentHash: "identical-complete-content",
      },
    ]);
    render(<SkillsMcpView />);
    const checkbox = await screen.findByRole("checkbox", {
      name: "添加 Shared",
    });
    expect(checkbox).toBeEnabled();
    expect(screen.getAllByRole("checkbox", { name: /^添加 / })).toHaveLength(1);
    expect(
      screen.getByText("来源：Codex、Gemini CLI、通用目录 .agents"),
    ).toBeVisible();
    expect(screen.queryByText(/同名但内容不同/)).not.toBeInTheDocument();
    fireEvent.click(checkbox);
    expect(screen.getByText("1 个发现 · 已选 1 个")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeEnabled();
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
  });

  it("selects a single differing source per directory without clearing other directories", async () => {
    const shared: UnmanagedSkill = {
      directory: "same",
      name: "Shared",
      path: "D:/shared/same",
      foundIn: ["claude", "agents"],
      contentHash: "shared-content",
    };
    const other: UnmanagedSkill = {
      directory: "same",
      name: "Other",
      path: "D:/codex/skills/same",
      foundIn: ["codex"],
      contentHash: "other-content",
    };
    const unrelated: UnmanagedSkill = {
      directory: "unrelated",
      name: "Unrelated",
      path: "D:/codex/skills/unrelated",
      foundIn: ["codex"],
      contentHash: "unrelated-content",
    };
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([
      shared,
      other,
      unrelated,
    ]);
    vi.mocked(skillsApi.importFromApps).mockResolvedValue([skill]);
    render(<SkillsMcpView />);
    const first = await screen.findByRole("checkbox", { name: "添加 Shared" });
    const second = screen.getByRole("checkbox", { name: "添加 Other" });
    const third = screen.getByRole("checkbox", { name: "添加 Unrelated" });
    expect(first).toBeEnabled();
    expect(second).toBeEnabled();
    expect(
      screen.getAllByText(
        "同名但内容不同，请选择一个来源；不会覆盖目标中的不同内容。",
      ),
    ).toHaveLength(2);
    fireEvent.click(first);
    fireEvent.click(third);
    expect(screen.getByText("3 个发现 · 已选 2 个")).toBeVisible();
    fireEvent.click(second);
    expect(first).not.toBeChecked();
    expect(second).toBeChecked();
    expect(third).toBeChecked();
    expect(screen.getByText("3 个发现 · 已选 2 个")).toBeVisible();
    expect(first.closest("label")).toHaveAttribute("data-selected", "false");
    expect(second.closest("label")).toHaveAttribute("data-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "添加所选 Skills" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("不会覆盖已有目录");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "添加 2 个",
      }),
    );
    await waitFor(() =>
      expect(skillsApi.importFromApps).toHaveBeenCalledExactlyOnceWith(
        [other, unrelated].map((source) => ({
          directory: source.directory,
          sourcePath: source.path,
          contentHash: source.contentHash,
          apps: {
            claude: false,
            codex: true,
            gemini: false,
            grokbuild: false,
            opencode: false,
          },
        })),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("lets users replace and deselect same-name sources without importing on selection", async () => {
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue(
      ["one", "two"].map((name) => ({
        directory: "same",
        name,
        path: `D:/codex/skills/${name}`,
        contentHash: `${name}-snapshot`,
        foundIn: ["codex"],
      })),
    );
    render(<SkillsMcpView />);
    const first = await screen.findByRole("checkbox", { name: "添加 one" });
    const second = screen.getByRole("checkbox", { name: "添加 two" });
    fireEvent.click(first);
    fireEvent.click(second);
    expect(first).not.toBeChecked();
    expect(second).toBeChecked();
    fireEvent.click(first);
    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
    expect(screen.getByText("2 个发现 · 已选 1 个")).toBeVisible();
    fireEvent.click(first);
    expect(first).not.toBeChecked();
    expect(screen.getByText("2 个发现 · 已选 0 个")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeDisabled();
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
  });

  it("requires confirmation for backup deletion and handles false results", async () => {
    vi.mocked(skillsApi.getBackups).mockResolvedValue([backup]);
    vi.mocked(skillsApi.deleteBackup).mockResolvedValue(false);
    render(<SkillsMcpView />);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "查看可恢复备份" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "删除备份 Real Skill" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(skillsApi.deleteBackup).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "删除备份 Real Skill" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "删除备份",
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("offers the update check only once a Skill came from a repository", async () => {
    render(<SkillsMcpView />);
    await screen.findByRole("switch");
    expect(
      screen.queryByRole("button", { name: "检查 Skills 更新" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理仓库" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "查看可恢复备份" }),
    ).toBeEnabled();
    expect(skillsApi.checkUpdates).not.toHaveBeenCalled();
  });
  it("updates only after confirmation and keeps a failed update retryable", async () => {
    // Only repository-installed Skills can be checked, so the fixture needs a source.
    vi.mocked(skillsApi.getInstalled).mockResolvedValue([
      { ...skill, repoOwner: "team", repoName: "skills" },
    ]);
    vi.mocked(skillsApi.checkUpdates).mockResolvedValue([
      { id: skill.id, name: skill.name, remoteHash: "new" },
    ]);
    render(<SkillsMcpView />);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "检查 Skills 更新" }));
    const updateButton = await screen.findByRole("button", {
      name: `更新 ${skill.name}`,
    });
    expect(skillsApi.updateSkill).not.toHaveBeenCalled();
    fireEvent.click(updateButton);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(skillsApi.updateSkill).not.toHaveBeenCalled();
    vi.mocked(skillsApi.updateSkill)
      .mockRejectedValueOnce(new Error("ambiguous source"))
      .mockResolvedValueOnce(skill);
    fireEvent.click(updateButton);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "更新" }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "更新",
        }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "更新" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(skillsApi.updateSkill).toHaveBeenNthCalledWith(1, skill.id);
    expect(skillsApi.updateSkill).toHaveBeenNthCalledWith(2, skill.id);
    expect(
      screen.queryByRole("button", { name: `更新 ${skill.name}` }),
    ).not.toBeInTheDocument();
  });
  it("refreshes installed data without losing scan selections", async () => {
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([
      {
        directory: "local",
        name: "Local",
        path: "mock/local",
        foundIn: ["codex"],
        contentHash: "unchanged-snapshot",
      },
    ]);
    const view = render(<SkillsMcpView refreshVersion={0} />);
    await screen.findByRole("switch");
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "添加 Local" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "添加所选 Skills" }),
      ).toBeEnabled(),
    );
    const calls = vi.mocked(skillsApi.getInstalled).mock.calls.length;
    view.rerender(<SkillsMcpView refreshVersion={1} />);
    await waitFor(() =>
      expect(skillsApi.getInstalled).toHaveBeenCalledTimes(calls + 1),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "本地 Skills 扫描" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.getByRole("checkbox", { name: "添加 Local" })).toBeChecked();
    expect(skillsApi.scanUnmanaged).toHaveBeenCalledTimes(2);
  });
});

describe("A06 repository management", () => {
  // The panel is a lazy chunk; transforming it cold can exceed the 5 s budget
  // of the behaviour checks below on a loaded machine.
  beforeAll(async () => {
    await import("@/components/skills/RepoManagerPanel");
  }, 60_000);
  it("adds a repository through the reused form, preserves its draft on refresh and confirms removal", async () => {
    vi.mocked(skillsApi.getRepos).mockResolvedValue([
      { owner: "team", name: "skills", branch: "main", enabled: true },
    ]);
    vi.mocked(skillsApi.addRepo).mockResolvedValue(true);
    vi.mocked(skillsApi.removeRepo).mockResolvedValue(true);
    const view = render(<SkillsMcpView refreshVersion={0} />);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "管理仓库" }));
    const url = await screen.findByLabelText(
      "skills.repo.url",
      {},
      { timeout: 5000 },
    );
    fireEvent.change(url, {
      target: { value: "https://github.com/new/repository" },
    });
    view.rerender(<SkillsMcpView refreshVersion={1} />);
    expect(url).toHaveValue("https://github.com/new/repository");
    fireEvent.change(screen.getByLabelText("skills.repo.branch"), {
      target: { value: "dev" },
    });
    fireEvent.click(screen.getByRole("button", { name: "skills.repo.add" }));
    await waitFor(() =>
      expect(skillsApi.addRepo).toHaveBeenCalledExactlyOnceWith({
        owner: "new",
        name: "repository",
        branch: "dev",
        enabled: true,
      }),
    );
    await waitFor(() => expect(url).toHaveValue(""));
    fireEvent.click(screen.getByTitle("common.delete"));
    expect(skillsApi.removeRepo).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "移除仓库",
      }),
    );
    await waitFor(() =>
      expect(skillsApi.removeRepo).toHaveBeenCalledExactlyOnceWith(
        "team",
        "skills",
      ),
    );
  });
  it("reports repository load failure and allows retry", async () => {
    vi.mocked(skillsApi.getRepos)
      .mockRejectedValueOnce(new Error("private"))
      .mockResolvedValue([]);
    render(<SkillsMcpView />);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "管理仓库" }));
    // Reads report what could not be read; they do not claim a partial write.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法读取仓库列表",
    );
    fireEvent.click(screen.getByRole("button", { name: "管理仓库" }));
    expect(await screen.findByLabelText("skills.repo.url")).toBeInTheDocument();
  });
});

describe("empty and loading states", () => {
  beforeEach(() => {
    vi.mocked(skillsApi.getInstalled).mockResolvedValue([]);
  });
  it("offers two install paths, quiet maintenance and no zero summary", async () => {
    vi.mocked(skillsApi.openZipFileDialog).mockResolvedValue("D:/skills.zip");
    vi.mocked(skillsApi.installFromZip).mockResolvedValue([skill]);
    render(<SkillsMcpView />);
    expect(
      await screen.findByRole("heading", {
        name: "尚未由 Chimera++ 管理 Skills",
      }),
    ).toBeVisible();
    expect(screen.queryByText("已启用 Skills")).not.toBeInTheDocument();
    expect(screen.queryByText(/0 个来源/)).not.toBeInTheDocument();
    // The empty state owns the add action; the header does not repeat it.
    expect(
      screen.queryByRole("button", { name: "安装" }),
    ).not.toBeInTheDocument();
    for (const name of ["管理仓库", "刷新扫描", "查看可恢复备份"])
      expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "检查 Skills 更新" }),
    ).not.toBeInTheDocument();
    const fromRepo = screen.getByRole("button", { name: /从仓库安装/ });
    fireEvent.click(fromRepo);
    const panel = screen.getByRole("region", { name: "安装 Skill" });
    expect(panel).toHaveFocus();
    expect(fromRepo).toHaveAttribute("aria-expanded", "true");
    vi.mocked(skillsApi.getInstalled).mockResolvedValue([skill]);
    fireEvent.click(screen.getByRole("button", { name: /导入 ZIP/ }));
    await waitFor(() =>
      expect(skillsApi.installFromZip).toHaveBeenCalledWith(
        "D:/skills.zip",
        "codex",
      ),
    );
    expect(await screen.findByText("Real Skill")).toBeVisible();
    expect(screen.getByRole("button", { name: "安装" })).toBeVisible();
  });
  it("says so when the configured repositories offer nothing", async () => {
    vi.mocked(skillsApi.discoverAvailable).mockResolvedValue([]);
    render(<SkillsMcpView />);
    fireEvent.click(await screen.findByRole("button", { name: /从仓库安装/ }));
    fireEvent.click(screen.getByRole("button", { name: "读取已配置仓库" }));
    // No enabled repository is configured, so the hint points to adding one.
    expect(await screen.findByText(/还没有启用的仓库/)).toBeVisible();
  });
  it("gives the MCP tab its own empty state with one add action", async () => {
    render(<SkillsMcpView initialApp="claude" />);
    await screen.findByRole("heading", {
      name: "尚未由 Chimera++ 管理 Skills",
    });
    fireEvent.click(screen.getByRole("button", { name: "MCP 0" }));
    expect(
      screen.getByRole("heading", { name: "还没有 MCP 服务" }),
    ).toBeVisible();
    expect(screen.getAllByRole("button", { name: "添加 MCP" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "添加 MCP" }));
    const props = JSON.parse(
      (await screen.findByTestId("mcp-editor")).textContent!,
    );
    expect(props.defaultEnabledApps).toEqual(["claude"]);
  });
  it("shows one status line and no counts until the first read finishes", async () => {
    let finish!: (value: InstalledSkill[]) => void;
    vi.mocked(skillsApi.getInstalled).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<SkillsMcpView />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "正在读取 Skills 与 MCP…",
    );
    expect(screen.getByRole("button", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
    expect(
      screen.queryByText("尚未由 Chimera++ 管理 Skills"),
    ).not.toBeInTheDocument();
    await act(async () => finish([skill]));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skills 1" })).toBeVisible();
    expect(screen.getByText("已启用 Skills")).toBeVisible();
  });
});

describe("automatic local Skills discovery", () => {
  const local = {
    directory: "local",
    name: "Local",
    path: "D:/a-long-directory/local",
    foundIn: ["codex"],
    contentHash: "local-snapshot",
  };

  it("widens discovery only by opt-in and clears selections on both scope transitions", async () => {
    const allSources = deferredScan();
    const scopedAgain = deferredScan();
    const foreign: UnmanagedSkill = {
      directory: "foreign",
      name: "Foreign",
      path: "D:/gemini/skills/foreign",
      contentHash: "foreign-snapshot",
      foundIn: ["gemini"],
    };
    vi.mocked(skillsApi.scanUnmanaged)
      .mockResolvedValueOnce([local])
      .mockReturnValueOnce(allSources.promise)
      .mockReturnValueOnce(scopedAgain.promise);
    render(<SkillsMcpView />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "添加 Local" }),
    );
    const scope = screen.getByRole("checkbox", {
      name: "同时发现其他工具的 Skills",
    });
    expect(skillsApi.scanUnmanaged).toHaveBeenCalledExactlyOnceWith("codex");
    expect(
      screen.getByText("仅查看 Codex 与通用 .agents 目录。"),
    ).toBeVisible();
    fireEvent.click(scope);
    expect(scope).toBeChecked();
    expect(skillsApi.scanUnmanaged).toHaveBeenNthCalledWith(2, undefined);
    expect(
      screen.queryByRole("checkbox", { name: "添加 Local" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeDisabled();
    await act(async () => allSources.resolve([local, foreign]));
    expect(
      screen.getByText("正在查看所有工具与共享目录；相同内容的副本会合并。"),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "添加 Local" }),
    ).not.toBeChecked();
    expect(screen.getByText("2 个发现 · 已选 0 个")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "添加 Local" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "添加 Foreign" }));
    expect(screen.getByText("2 个发现 · 已选 2 个")).toBeVisible();
    fireEvent.click(scope);
    expect(scope).not.toBeChecked();
    expect(skillsApi.scanUnmanaged).toHaveBeenNthCalledWith(3, "codex");
    expect(
      screen.queryByRole("checkbox", { name: "添加 Foreign" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeDisabled();
    await act(async () => scopedAgain.resolve([local]));
    expect(
      screen.getByRole("checkbox", { name: "添加 Local" }),
    ).not.toBeChecked();
    expect(screen.getByText("1 个发现 · 已选 0 个")).toBeVisible();
    expect(vi.mocked(skillsApi.scanUnmanaged).mock.calls).toEqual([
      ["codex"],
      [undefined],
      ["codex"],
    ]);
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
    expect(skillsApi.toggleApp).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "clears the old target selection even when the source snapshot is unchanged (all sources: %s)",
    async (allSources) => {
      const nextScan = deferredScan();
      const aliased = { ...local, foundIn: ["codex", "claude"] };
      vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([aliased]);
      vi.mocked(skillsApi.importFromApps).mockResolvedValue([skill]);
      render(<SkillsMcpView />);
      await screen.findByRole("checkbox", { name: "添加 Local" });
      if (allSources) {
        fireEvent.click(
          screen.getByRole("checkbox", { name: "同时发现其他工具的 Skills" }),
        );
        await waitFor(() =>
          expect(
            screen.getByRole("region", { name: "本地 Skills 扫描" }),
          ).toHaveAttribute("aria-busy", "false"),
        );
      }
      fireEvent.click(screen.getByRole("checkbox", { name: "添加 Local" }));
      expect(
        screen.getByRole("button", { name: "添加所选 Skills" }),
      ).toBeEnabled();
      vi.mocked(skillsApi.scanUnmanaged).mockReturnValueOnce(nextScan.promise);
      fireEvent.change(screen.getByRole("combobox", { name: "目标工具" }), {
        target: { value: "claude" },
      });
      expect(skillsApi.scanUnmanaged).toHaveBeenLastCalledWith(
        allSources ? undefined : "claude",
      );
      expect(
        screen.queryByRole("checkbox", { name: "添加 Local" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "添加所选 Skills" }),
      ).toBeDisabled();
      await act(async () => nextScan.resolve([aliased]));
      const checkbox = screen.getByRole("checkbox", { name: "添加 Local" });
      expect(checkbox).not.toBeChecked();
      expect(screen.getByText("1 个发现 · 已选 0 个")).toBeVisible();
      expect(skillsApi.importFromApps).not.toHaveBeenCalled();
      fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "添加所选 Skills" }));
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "启用到 Claude Code",
      );
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "添加 1 个",
        }),
      );
      await waitFor(() =>
        expect(skillsApi.importFromApps).toHaveBeenCalledExactlyOnceWith([
          {
            directory: aliased.directory,
            sourcePath: aliased.path,
            contentHash: aliased.contentHash,
            apps: {
              claude: true,
              codex: false,
              gemini: false,
              grokbuild: false,
              opencode: false,
            },
          },
        ]),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    },
  );

  it.each([
    { change: "content hash", patch: { contentHash: "changed-content" } },
    { change: "canonical source path", patch: { path: "D:/another/local" } },
    { change: "directory", patch: { directory: "renamed" } },
    { change: "missing fingerprint", patch: { contentHash: undefined } },
    { change: "removed source", patch: null },
  ])(
    "clears an outdated selection after a refreshed $change",
    async ({ patch }) => {
      const refresh = deferredScan();
      vi.mocked(skillsApi.scanUnmanaged)
        .mockResolvedValueOnce([local])
        .mockReturnValueOnce(refresh.promise);
      render(<SkillsMcpView />);
      const checkbox = await screen.findByRole("checkbox", {
        name: "添加 Local",
      });
      fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "刷新扫描" }));
      expect(checkbox).toBeChecked();
      expect(checkbox).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "添加所选 Skills" }),
      ).toBeDisabled();
      await act(async () =>
        refresh.resolve(patch === null ? [] : [{ ...local, ...patch }]),
      );
      for (const row of screen.queryAllByRole("checkbox", { name: /^添加 / })) {
        expect(row).not.toBeChecked();
        expect(row).toBeEnabled();
      }
      expect(
        screen.getByText(`${patch === null ? 0 : 1} 个发现 · 已选 0 个`),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "添加所选 Skills" }),
      ).toBeDisabled();
      expect(skillsApi.importFromApps).not.toHaveBeenCalled();
    },
  );

  it("keeps the same snapshot selected after row reordering and display metadata changes", async () => {
    const unrelated: UnmanagedSkill = {
      ...local,
      directory: "unrelated",
      name: "Unrelated",
      path: "D:/codex/skills/unrelated",
      contentHash: "unrelated-content",
    };
    vi.mocked(skillsApi.scanUnmanaged)
      .mockResolvedValueOnce([local, unrelated])
      .mockResolvedValueOnce([
        unrelated,
        {
          ...local,
          name: "Renamed display label",
          description: "Updated description",
          foundIn: ["codex", "agents"],
        },
      ]);
    render(<SkillsMcpView />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "添加 Local" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新扫描" }));
    const retained = await screen.findByRole("checkbox", {
      name: "添加 Renamed display label",
    });
    expect(retained).toBeChecked();
    expect(retained).toBeEnabled();
    expect(
      screen.getByRole("checkbox", { name: "添加 Unrelated" }),
    ).not.toBeChecked();
    expect(screen.getByText("2 个发现 · 已选 1 个")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeEnabled();
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
  });

  it("imports the new fingerprint only after the changed source is selected again", async () => {
    const changed = { ...local, contentHash: "updated-snapshot" };
    vi.mocked(skillsApi.scanUnmanaged)
      .mockResolvedValueOnce([local])
      .mockResolvedValue([changed]);
    vi.mocked(skillsApi.importFromApps).mockResolvedValue([skill]);
    render(<SkillsMcpView />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "添加 Local" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新扫描" }));
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "本地 Skills 扫描" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    const checkbox = screen.getByRole("checkbox", { name: "添加 Local" });
    expect(checkbox).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeDisabled();
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "添加所选 Skills" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "添加 1 个",
      }),
    );
    await waitFor(() =>
      expect(skillsApi.importFromApps).toHaveBeenCalledExactlyOnceWith([
        {
          directory: changed.directory,
          sourcePath: changed.path,
          contentHash: changed.contentHash,
          apps: {
            claude: false,
            codex: true,
            gemini: false,
            grokbuild: false,
            opencode: false,
          },
        },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it.each([
    { change: "scope", result: "success" },
    { change: "scope", result: "failure" },
    { change: "target", result: "success" },
    { change: "target", result: "failure" },
  ] as const)(
    "ignores an older $result after the new $change scan succeeds",
    async ({ change, result }) => {
      const older = deferredScan();
      const latest = deferredScan();
      const current = {
        ...local,
        name: "Current",
        path: "D:/current/local",
        contentHash: "current-content",
      };
      vi.mocked(skillsApi.scanUnmanaged)
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(latest.promise);
      render(<SkillsMcpView />);
      await screen.findByRole("switch");
      if (change === "scope") {
        fireEvent.click(
          screen.getByRole("checkbox", { name: "同时发现其他工具的 Skills" }),
        );
      } else {
        fireEvent.change(screen.getByRole("combobox", { name: "目标工具" }), {
          target: { value: "claude" },
        });
      }
      expect(skillsApi.scanUnmanaged).toHaveBeenNthCalledWith(
        2,
        change === "scope" ? undefined : "claude",
      );
      await act(async () => latest.resolve([current]));
      fireEvent.click(screen.getByRole("checkbox", { name: "添加 Current" }));
      await act(async () => {
        if (result === "success") older.resolve([local]);
        else older.reject(new Error("old scan failed"));
      });
      expect(
        screen.queryByRole("checkbox", { name: "添加 Local" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", { name: "添加 Current" }),
      ).toBeChecked();
      expect(screen.getByText("1 个发现 · 已选 1 个")).toBeVisible();
      expect(
        screen.getByRole("region", { name: "本地 Skills 扫描" }),
      ).toHaveAttribute("aria-busy", "false");
      expect(
        screen.getByRole("button", { name: "添加所选 Skills" }),
      ).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(skillsApi.importFromApps).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "failure"] as const)(
    "keeps the latest scan pending when an older request finishes with %s",
    async (result) => {
      const older = deferredScan();
      const latest = deferredScan();
      vi.mocked(skillsApi.scanUnmanaged)
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(latest.promise);
      render(<SkillsMcpView />);
      await screen.findByRole("switch");
      fireEvent.click(
        screen.getByRole("checkbox", { name: "同时发现其他工具的 Skills" }),
      );
      await act(async () => {
        if (result === "success") older.resolve([local]);
        else older.reject(new Error("old scan failed"));
      });
      expect(
        screen.getByRole("region", { name: "本地 Skills 扫描" }),
      ).toHaveAttribute("aria-busy", "true");
      expect(screen.getByRole("button", { name: "正在扫描…" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "添加所选 Skills" }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("checkbox", { name: "添加 Local" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => latest.resolve([local]));
      expect(
        screen.getByRole("checkbox", { name: "添加 Local" }),
      ).toBeEnabled();
      expect(
        screen.getByRole("checkbox", { name: "添加 Local" }),
      ).not.toBeChecked();
    },
  );

  it("does not hide the latest scan failure when a superseded scan succeeds", async () => {
    const older = deferredScan();
    const latest = deferredScan();
    vi.mocked(skillsApi.scanUnmanaged)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise)
      .mockResolvedValue([local]);
    render(<SkillsMcpView />);
    await screen.findByRole("switch");
    fireEvent.change(screen.getByRole("combobox", { name: "目标工具" }), {
      target: { value: "gemini" },
    });
    await act(async () => latest.reject(new Error("current scan failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("扫描失败");
    await act(async () => older.resolve([local]));
    expect(screen.getByRole("alert")).toHaveTextContent("扫描失败");
    expect(
      screen.queryByRole("checkbox", { name: "添加 Local" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试扫描" }));
    expect(skillsApi.scanUnmanaged).toHaveBeenNthCalledWith(3, "gemini");
    expect(
      await screen.findByRole("checkbox", { name: "添加 Local" }),
    ).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
  });

  it("keeps only the latest request across rapid scope and target changes", async () => {
    const codex = deferredScan();
    const allBeforeTarget = deferredScan();
    const allAfterTarget = deferredScan();
    const claude = deferredScan();
    const current = {
      ...local,
      name: "Current",
      path: "D:/claude/skills/local",
      foundIn: ["claude"],
    };
    vi.mocked(skillsApi.scanUnmanaged)
      .mockReturnValueOnce(codex.promise)
      .mockReturnValueOnce(allBeforeTarget.promise)
      .mockReturnValueOnce(allAfterTarget.promise)
      .mockReturnValueOnce(claude.promise);
    render(<SkillsMcpView />);
    await screen.findByRole("switch");
    const scope = screen.getByRole("checkbox", {
      name: "同时发现其他工具的 Skills",
    });
    fireEvent.click(scope);
    fireEvent.change(screen.getByRole("combobox", { name: "目标工具" }), {
      target: { value: "claude" },
    });
    fireEvent.click(scope);
    expect(vi.mocked(skillsApi.scanUnmanaged).mock.calls).toEqual([
      ["codex"],
      [undefined],
      [undefined],
      ["claude"],
    ]);
    await act(async () => claude.resolve([current]));
    fireEvent.click(screen.getByRole("checkbox", { name: "添加 Current" }));
    await act(async () => {
      allAfterTarget.resolve([local]);
      codex.reject(new Error("superseded Codex scan"));
      allBeforeTarget.resolve([]);
    });
    expect(screen.getByRole("combobox", { name: "目标工具" })).toHaveValue(
      "claude",
    );
    expect(scope).not.toBeChecked();
    expect(
      screen.queryByRole("checkbox", { name: "添加 Local" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "添加 Current" }),
    ).toBeChecked();
    expect(screen.getByText("1 个发现 · 已选 1 个")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "本地 Skills 扫描" }),
    ).toHaveAttribute("aria-busy", "false");
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
  });

  it("reports a malformed scan response without crashing", async () => {
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue(
      {} as Awaited<ReturnType<typeof skillsApi.scanUnmanaged>>,
    );
    render(<SkillsMcpView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("扫描失败");
    expect(screen.getByRole("button", { name: "重试扫描" })).toBeEnabled();
    expect(screen.getByRole("switch")).toBeEnabled();
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
  });

  it("reports an initial scan failure separately and retries without writing", async () => {
    vi.mocked(skillsApi.scanUnmanaged)
      .mockRejectedValueOnce(new Error("private path"))
      .mockResolvedValue([local]);
    render(<SkillsMcpView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("扫描失败");
    expect(
      screen.queryByText("未发现可添加的本地 Skills。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试扫描" }));
    expect(
      await screen.findByRole("checkbox", { name: "添加 Local" }),
    ).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
    expect(skillsApi.toggleApp).not.toHaveBeenCalled();
  });

  it("keeps old results visible but unavailable during refresh and after failure", async () => {
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([local]);
    render(<SkillsMcpView />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "添加 Local" }),
    );
    let rejectScan!: (error: Error) => void;
    vi.mocked(skillsApi.scanUnmanaged).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectScan = reject;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新扫描" }));
    expect(screen.getByRole("status")).toHaveTextContent("上次扫描结果");
    expect(screen.getByRole("button", { name: "正在扫描…" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "添加 Local" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeDisabled();
    await act(async () => rejectScan(new Error("unreadable")));
    expect(screen.getByRole("alert")).toHaveTextContent("暂不可添加");
    expect(screen.getByRole("checkbox", { name: "添加 Local" })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeDisabled();
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "重试扫描" }));
    expect(
      await screen.findByText("未发现可添加的本地 Skills。"),
    ).toBeVisible();
    expect(
      screen.queryByRole("checkbox", { name: /^添加 / }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "同时发现其他工具的 Skills" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "添加所选 Skills" }),
    ).toBeDisabled();
  });

  it("ignores an older scan that finishes after an external refresh", async () => {
    let finish!: (items: (typeof local)[]) => void;
    vi.mocked(skillsApi.scanUnmanaged)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([]);
    const view = render(<SkillsMcpView />);
    await screen.findByRole("switch");
    view.rerender(<SkillsMcpView refreshVersion={1} />);
    await screen.findByText("未发现可添加的本地 Skills。");
    await act(async () => finish([local]));
    expect(
      screen.queryByRole("checkbox", { name: "添加 Local" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("未发现可添加的本地 Skills。")).toBeVisible();
  });
});

describe("resource visual hierarchy", () => {
  it("names the current tool in the heading and summary and exposes the active resource", async () => {
    render(<SkillsMcpView />);
    await screen.findByRole("region", { name: "Codex 资源概览" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Codex · Skills 与 MCP" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Skills 1", pressed: true }),
    ).toBeVisible();
    expect(screen.getByText("0 / 1")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "目标工具" }), {
      target: { value: "claude" },
    });
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Claude Code · Skills 与 MCP",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Claude Code 资源概览" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "MCP 0" }));
    expect(
      screen.getByRole("button", { name: "MCP 0", pressed: true }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "还没有 MCP 服务" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Claude Code 资源概览" }),
    ).not.toBeInTheDocument();
  });

  it("shows discovered and selected counts beside the scan heading without importing", async () => {
    const path = "D:/" + "long-folder/".repeat(30) + "local";
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([
      { directory: "local", name: "Local", path, foundIn: ["codex"] },
    ]);
    render(<SkillsMcpView />);
    const checkbox = await screen.findByRole("checkbox", {
      name: "添加 Local",
    });
    expect(screen.getByText("1 个发现 · 已选 0 个")).toBeVisible();
    expect(screen.getByTitle(path)).toHaveTextContent(path);
    fireEvent.click(checkbox);
    expect(screen.getByText("1 个发现 · 已选 1 个")).toBeVisible();
    expect(checkbox.closest("label")).toHaveAttribute("data-selected", "true");
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
  });
});
