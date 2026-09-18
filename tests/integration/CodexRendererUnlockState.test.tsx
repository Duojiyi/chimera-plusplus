import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  NewProvidersView,
  type CodexProcessStatus,
  type CodexRendererUnlockProbe,
} from "@/ChimeraApp";
import type { Provider } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";

const { useUpdateMock } = vi.hoisted(() => ({
  useUpdateMock: vi.fn().mockReturnValue({
    hasUpdate: false,
    isDismissed: false,
    updateInfo: null,
    dismissUpdate: vi.fn(),
    installUpdate: vi.fn(),
    isInstalling: false,
    downloadProgress: null,
  }),
}));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => useUpdateMock(),
}));

const mockProvider: Provider = {
  id: "relay-1",
  name: "ChimeraHub Relay",
  settingsConfig: {
    config:
      'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.chimerahub.org/v1"\n',
  },
  category: "third_party",
  sortIndex: 0,
  createdAt: Date.now(),
};

function renderView(props: {
  codexProcess?: CodexProcessStatus | null;
  rendererUnlock?: CodexRendererUnlockProbe | null;
}) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <NewProvidersView
        providers={[mockProvider]}
        currentId={mockProvider.id}
        currentSource="live"
        connection={{ kind: "connected", message: "", modelCount: 1 }}
        loading={false}
        codexProcess={props.codexProcess ?? null}
        rendererUnlock={props.rendererUnlock ?? null}
        launchingCodex={false}
        restartRequired={false}
        onOpenCodex={vi.fn().mockResolvedValue(undefined)}
        onSwitch={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(true)}
        deletingProviderId={null}
        onEdit={vi.fn()}
        onAdd={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("Codex renderer unlock state mappings (A05)", () => {
  it("renders '正在检测 Codex' when codexProcess is null", () => {
    renderView({ codexProcess: null });
    expect(screen.getByText("正在检测 Codex")).toBeInTheDocument();
  });

  it("renders 'macOS 暂不支持快速启动' when unsupported", () => {
    renderView({
      codexProcess: {
        installed: true,
        running: false,
        supported: false,
        officialLoginAvailable: false,
      },
    });
    expect(screen.getByText("macOS 暂不支持快速启动")).toBeInTheDocument();
  });

  it("renders '未检测到 Codex' when not installed", () => {
    renderView({
      codexProcess: {
        installed: false,
        running: false,
        supported: true,
        officialLoginAvailable: false,
      },
    });
    expect(screen.getByText("未检测到 Codex")).toBeInTheDocument();
  });

  it("renders 'Codex 已就绪' when installed and stopped", () => {
    renderView({
      codexProcess: {
        installed: true,
        running: false,
        supported: true,
        officialLoginAvailable: false,
      },
    });
    expect(screen.getByText("Codex 已就绪")).toBeInTheDocument();
  });

  it("renders unconfirmed unlock state when attachable is false", () => {
    renderView({
      codexProcess: {
        installed: true,
        running: true,
        supported: true,
        officialLoginAvailable: false,
      },
      rendererUnlock: {
        attachable: false,
        injected: false,
        modelCount: 0,
        error: "connection refused",
      },
    });
    expect(
      screen.getByText("Codex 运行中 · 解锁状态未确认"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/暂时无法确认模型列表解锁状态，正在重新检测/),
    ).toBeInTheDocument();
  });

  it("renders '调试连接可用，模型解锁未确认' when attachable=true and injected=false without false promises", () => {
    renderView({
      codexProcess: {
        installed: true,
        running: true,
        supported: true,
        officialLoginAvailable: false,
      },
      rendererUnlock: {
        attachable: true,
        injected: false,
        modelCount: 0,
        error: null,
      },
    });
    expect(
      screen.getByText("Codex 运行中 · 调试连接可用，模型解锁未确认"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("调试连接可用，模型解锁未确认/未安装。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/正在等待 Codex 刷新模型列表/),
    ).not.toBeInTheDocument();
  });

  it("renders 'Codex 正在运行' without warning hint when injected=true", () => {
    renderView({
      codexProcess: {
        installed: true,
        running: true,
        supported: true,
        officialLoginAvailable: false,
      },
      rendererUnlock: {
        attachable: true,
        injected: true,
        modelCount: 5,
        error: null,
      },
    });
    expect(screen.getByText("Codex 正在运行")).toBeInTheDocument();
    expect(screen.queryByText(/模型解锁/)).not.toBeInTheDocument();
  });
});
