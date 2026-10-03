import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsMcpView } from "@/views/SkillsMcpView";
import { skillsApi, type InstalledSkill } from "@/lib/api/skills";
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
    openclaw: false,
    hermes: false,
  },
};
beforeEach(() => {
  vi.resetAllMocks();
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

  it("switches resource context and does not offer unsupported OpenClaw MCP", async () => {
    render(<SkillsMcpView />);
    await screen.findByText("Real Skill");
    fireEvent.click(screen.getByRole("button", { name: "MCP 0" }));
    fireEvent.change(screen.getByRole("combobox", { name: "目标工具" }), {
      target: { value: "openclaw" },
    });
    expect(screen.getByRole("button", { name: "MCP 0" })).toBeDisabled();
    expect(screen.getByText(/暂不支持受管 MCP/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("switch", { name: "启用 Skill Real Skill" }),
    );
    await waitFor(() =>
      expect(skillsApi.toggleApp).toHaveBeenCalledWith(
        skill.id,
        "openclaw",
        true,
      ),
    );
    expect(mcpApi.toggleApp).not.toHaveBeenCalled();
  });

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
      "hermes",
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
    expect(screen.getByText(exportScope)).toBeVisible();
    expect(exportButton).toHaveAccessibleDescription(exportScope);
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
      expect(
        screen.getByText(String(enabled ? 1 : 0) + " 个已启用服务"),
      ).toBeVisible();
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
      expect(
        screen.getByText(String(enabled ? 1 : 0) + " 个已启用服务"),
      ).toBeVisible();
      expect(server.apps.codex).toBe(true);
    }
    expect(mcpApi.getAllServers).toHaveBeenCalledTimes(4);
  });

  it.each(["claude", "gemini", "grokbuild", "opencode", "hermes"] as const)(
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
        expect(
          screen.getByText(`${enabled ? 1 : 0} 个已启用服务`),
        ).toBeVisible();
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
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Real Skill")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
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
  it("scans only on request and imports selected skills only to the chosen target after confirmation", async () => {
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue([
      {
        directory: "local",
        name: "Local",
        path: "mock/local",
        foundIn: ["codex", "claude"],
      },
    ]);
    vi.mocked(skillsApi.importFromApps).mockResolvedValue([skill]);
    render(<SkillsMcpView initialApp="gemini" />);
    await screen.findByRole("switch");
    expect(skillsApi.scanUnmanaged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "扫描未纳管 Skills" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "纳管 Local" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "纳管所选 Skills" }));
    expect(skillsApi.importFromApps).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() =>
      expect(skillsApi.importFromApps).toHaveBeenCalledExactlyOnceWith([
        {
          directory: "local",
          apps: {
            claude: false,
            codex: false,
            gemini: true,
            grokbuild: false,
            opencode: false,
            openclaw: false,
            hermes: false,
          },
        },
      ]),
    );
  });
  it("blocks ambiguous unmanaged directories", async () => {
    vi.mocked(skillsApi.scanUnmanaged).mockResolvedValue(
      ["one", "two"].map((path) => ({
        directory: "same",
        name: path,
        path,
        foundIn: ["codex"],
      })),
    );
    render(<SkillsMcpView />);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "扫描未纳管 Skills" }));
    expect(
      await screen.findByRole("checkbox", { name: "纳管 one" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "纳管所选 Skills" }),
    ).toBeDisabled();
  });
  it("restores to the selected target, retains failure state and retries", async () => {
    vi.mocked(skillsApi.getBackups).mockResolvedValue([backup]);
    vi.mocked(skillsApi.restoreBackup)
      .mockRejectedValueOnce(new Error("private path"))
      .mockResolvedValue(skill);
    render(<SkillsMcpView initialApp="hermes" />);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "查看可恢复备份" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "恢复 Real Skill" }),
    );
    expect(skillsApi.restoreBackup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("private path")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(skillsApi.restoreBackup).toHaveBeenLastCalledWith(
      "backup-1",
      "hermes",
    );
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
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("updates only after confirmation and keeps a failed update retryable", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
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
      },
    ]);
    const view = render(<SkillsMcpView refreshVersion={0} />);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "扫描未纳管 Skills" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "纳管 Local" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "纳管所选 Skills" }),
      ).toBeEnabled(),
    );
    const calls = vi.mocked(skillsApi.getInstalled).mock.calls.length;
    view.rerender(<SkillsMcpView refreshVersion={1} />);
    await waitFor(() =>
      expect(skillsApi.getInstalled).toHaveBeenCalledTimes(calls + 1),
    );
    expect(screen.getByRole("checkbox", { name: "纳管 Local" })).toBeChecked();
    expect(skillsApi.scanUnmanaged).toHaveBeenCalledTimes(1);
  });
});

describe("A06 repository management", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
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
    expect(await screen.findByRole("alert")).toHaveTextContent("操作失败");
    fireEvent.click(screen.getByRole("button", { name: "管理仓库" }));
    expect(await screen.findByLabelText("skills.repo.url")).toBeInTheDocument();
  });
});
