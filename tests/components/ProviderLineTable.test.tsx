import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderLineTable } from "@/components/ProviderLineTable";
import { vscodeApi, type EndpointLatencyResult } from "@/lib/api/vscode";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import type { Provider } from "@/types";
import { CANONICAL_LINES, CANONICAL_PROVIDERS } from "@/data/canonicalData";
vi.mock("@/lib/api/vscode", () => ({
  vscodeApi: { testApiEndpoints: vi.fn() },
}));
const providers: Provider[] = [
  {
    id: "real-a",
    name: "Alpha",
    settingsConfig: {
      config:
        'model = "model-a"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://example.test/v1"\nwire_api = "responses"',
    },
  },
  {
    id: "real-b",
    name: "Beta",
    settingsConfig: {
      config:
        'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://example.test/v1"',
    },
  },
  { id: "real-official", name: "Official", settingsConfig: {} },
];
const labels = new Map(
  providers.map((p) => [
    p.id,
    {
      name: p.name,
      source: "Real source",
      mark: p.name[0],
      official: p.id === "real-official",
    },
  ]),
);
const props = () => ({
  providers,
  labels,
  currentId: "real-a",
  switchingId: null,
  deletingProviderId: null,
  onSwitch: vi.fn().mockResolvedValue(undefined),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
});
beforeEach(() => vi.clearAllMocks());
describe("connected provider line table", () => {
  it("renders controls in the supplied page heading and keeps management reachable after filtering", () => {
    const heading = document.createElement("div");
    document.body.appendChild(heading);
    const onManage = vi.fn();
    const view = render(
      <ProviderLineTable
        {...props()}
        toolbarContainer={heading}
        onManage={onManage}
      />,
    );
    try {
      expect(
        within(heading).getByRole("textbox", { name: "筛选线路" }),
      ).toBeVisible();
      expect(
        within(heading).getByRole("button", { name: "全部测速" }),
      ).toBeVisible();
      expect(screen.getAllByRole("button", { name: "管理线路" })).toHaveLength(
        1,
      );
      expect(
        within(screen.getAllByRole("rowgroup")[0]).getByRole("button", {
          name: "管理线路",
        }),
      ).toBeVisible();
      fireEvent.change(within(heading).getByRole("textbox"), {
        target: { value: "not-a-provider" },
      });
      fireEvent.click(screen.getByRole("button", { name: "管理线路" }));
      expect(onManage).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      heading.remove();
    }
  });

  it("keeps design preview filterable without switching, editing, deleting or probing", () => {
    const callbacks = props();
    render(<ProviderLineTable {...callbacks} readOnly />);
    for (const name of ["全部测速", "切换到Beta", "编辑Beta", "删除Beta"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(callbacks.onSwitch).not.toHaveBeenCalled();
    expect(callbacks.onEdit).not.toHaveBeenCalled();
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(vscodeApi.testApiEndpoints).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "筛选线路" }), {
      target: { value: "Beta" },
    });
    expect(screen.getByText("Beta")).toBeVisible();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("uses readable protocol labels with the configured upstream format taking precedence", () => {
    const p = props();
    render(
      <ProviderLineTable
        {...p}
        providers={[
          { ...providers[0], meta: { apiFormat: "anthropic" } },
          providers[1],
        ]}
      />,
    );
    expect(screen.getByText("Anthropic")).toBeVisible();
    expect(screen.queryByText("anthropic")).not.toBeInTheDocument();
  });

  it("renders config and delegates the actual provider objects", async () => {
    const user = userEvent.setup();
    const p = props();
    render(<ProviderLineTable {...p} />);
    const table = screen.getByRole("table", { name: "线路切换" });
    expect(within(table).getByText("model-a")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "切换到Beta" }));
    expect(p.onSwitch).toHaveBeenCalledWith(providers[1]);
    fireEvent.click(screen.getByRole("button", { name: "编辑Beta" }));
    expect(p.onEdit).toHaveBeenCalledWith(providers[1]);
    await user.click(screen.getByRole("button", { name: "删除Beta" }));

    expect(p.onDelete).toHaveBeenCalledExactlyOnceWith(providers[1]);
    const activeDelete = screen.getByRole("button", { name: "删除Alpha" });
    expect(activeDelete).toBeDisabled();
    expect(activeDelete).toHaveAttribute(
      "title",
      "当前线路正在使用，请先切换到其他线路",
    );
    await user.click(activeDelete);
    expect(p.onDelete).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: /更多.*操作/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "删除Official" }),
    ).not.toBeInTheDocument();
  });
  it("filters by real config and focuses search with Ctrl F", () => {
    render(<ProviderLineTable {...props()} />);
    fireEvent.keyDown(window, { ctrlKey: true, key: "f" });
    const search = screen.getByRole("textbox", { name: "筛选线路" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "model-a" } });
    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "not-configured" } });
    expect(screen.getByText("没有匹配的线路。")).toBeVisible();
  });
  it("deduplicates configured endpoints and preserves zero latency", async () => {
    vi.mocked(vscodeApi.testApiEndpoints).mockResolvedValue([
      { url: "https://example.test/v1", latency: 0 },
    ]);
    render(<ProviderLineTable {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "全部测速" }));
    await waitFor(() => expect(screen.getAllByText("0 ms")).toHaveLength(2));
    expect(vscodeApi.testApiEndpoints).toHaveBeenCalledWith(
      ["https://example.test/v1"],
      { timeoutSecs: 12 },
    );
  });
  it("discards a late response after providers change", async () => {
    let resolve!: (rows: EndpointLatencyResult[]) => void;
    vi.mocked(vscodeApi.testApiEndpoints).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p = props();
    const { rerender } = render(<ProviderLineTable {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "全部测速" }));
    rerender(<ProviderLineTable {...p} providers={[providers[2]]} />);
    await act(async () =>
      resolve([{ url: "https://example.test/v1", latency: 42 }]),
    );
    expect(screen.queryByText("42 ms")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部测速" })).toBeDisabled();
  });
  it("shows a failed request without fabricated measurements and permits retry", async () => {
    vi.mocked(vscodeApi.testApiEndpoints).mockRejectedValue(
      new Error("endpoint timeout"),
    );
    render(<ProviderLineTable {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "全部测速" }));
    await waitFor(() => expect(screen.getAllByText("失败")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "全部测速" })).toBeEnabled();
  });
  it("blocks deletion while another deletion is pending", () => {
    const p = props();
    render(<ProviderLineTable {...p} deletingProviderId="real-a" />);
    const button = screen.getByRole("button", { name: "删除Beta" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(p.onDelete).not.toHaveBeenCalled();
  });
  it("blocks row mutations during an in-flight switch", () => {
    render(<ProviderLineTable {...props()} switchingId="real-b" />);
    for (const button of within(screen.getByRole("table")).getAllByRole(
      "button",
    ))
      expect(button).toBeDisabled();
  });
});

function DialogFixture() {
  const ref = useDialogFocus<HTMLDivElement>(() => {});
  return (
    <div ref={ref} role="dialog">
      <input aria-label="弹层输入" />
    </div>
  );
}
it("does not steal Ctrl F from an active modal", () => {
  render(
    <>
      <ProviderLineTable {...props()} />
      <DialogFixture />
    </>,
  );
  const input = screen.getByRole("textbox", { name: "弹层输入" });
  input.focus();
  fireEvent.keyDown(window, { ctrlKey: true, key: "f" });
  expect(input).toHaveFocus();
});

describe("Pencil populated table states", () => {
  const sampleProps = () => ({
    ...props(),
    providers: CANONICAL_PROVIDERS,
    currentId: "canonical-deepseek",
    labels: new Map(
      CANONICAL_LINES.map((line) => [
        line.id,
        {
          name: line.name,
          source: "自定义线路",
          mark: "?",
          official: !!line.isOfficial,
        },
      ]),
    ),
    designSamples: CANONICAL_LINES,
  });
  it("shows account, expired, slow and timeout examples only in read-only preview", () => {
    render(<ProviderLineTable {...sampleProps()} readOnly />);
    expect(screen.getByText("li***@gmail.com · Pro")).toBeVisible();
    expect(screen.getByText("登录已过期，需要重新登录")).toHaveClass(
      "is-expired",
    );
    expect(screen.getByText("重新登录")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "编辑OpenAI 官方 · 主力" }),
    ).toBeDisabled();
    expect(screen.getByText("1200 ms")).toBeVisible();
    expect(screen.getByText("超时")).toBeVisible();
    expect(screen.getByText("DS")).toBeVisible();
    expect(screen.getByText("OR")).toBeVisible();
    expect(screen.getAllByText("自动 · Chat")).toHaveLength(3);
    expect(vscodeApi.testApiEndpoints).not.toHaveBeenCalled();
  });
  it("does not show sample credentials or measurements in an interactive table", () => {
    render(<ProviderLineTable {...sampleProps()} />);
    expect(screen.queryByText("li***@gmail.com · Pro")).not.toBeInTheDocument();
    expect(screen.queryByText("182 ms")).not.toBeInTheDocument();
    expect(screen.queryByText("超时")).not.toBeInTheDocument();
  });
});

it("keeps management visible but inert in read-only tables, including empty search", () => {
  const onManage = vi.fn();
  render(<ProviderLineTable {...props()} readOnly onManage={onManage} />);
  const assertInert = () => {
    const buttons = screen.getAllByRole("button", { name: "管理线路" });
    for (const button of buttons) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onManage).not.toHaveBeenCalled();
  };
  assertInert();
  fireEvent.change(screen.getByRole("textbox", { name: "筛选线路" }), {
    target: { value: "no matching provider" },
  });
  assertInert();
});
