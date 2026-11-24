// Browser-preview markup of the sidebar and titlebar. Moving these regions
// into their own modules must not change a single attribute; a deliberate
// visual change updates the snapshot in the same commit.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterAll, expect, it, vi } from "vitest";
import ChimeraApp from "@/ChimeraApp";
import { createTestQueryClient } from "../utils/testQueryClient";

// Drag-region attributes are computed when the shell imports the platform module.
const { userAgent, platform } = vi.hoisted(() => ({
  userAgent: vi
    .spyOn(window.navigator, "userAgent", "get")
    .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
  platform: vi
    .spyOn(window.navigator, "platform", "get")
    .mockReturnValue("Win32"),
}));

afterAll(() => {
  userAgent.mockRestore();
  platform.mockRestore();
});

const sidebar = () => document.querySelector('[data-pencil-name="侧栏"]');
const titlebar = ({ expectSearch = true } = {}) => {
  const bar = document.querySelector<HTMLElement>(
    '[data-pencil-name="标题栏"]',
  );
  expect(bar).not.toBeNull();
  if (expectSearch) {
    // The simplified titlebar keeps command access, without the old mini signboard.
    expect(
      within(bar!).getByRole("button", { name: "搜索线路、页面或命令" }),
    ).toBeEnabled();
  } else {
    expect(
      within(bar!).getByRole("button", { name: "返回线路" }),
    ).toBeEnabled();
  }
  expect(
    within(bar!).queryByRole("button", { name: /^当前线路：/ }),
  ).not.toBeInTheDocument();
  return bar;
};

it("keeps the shell markup stable across views and the line editor", async () => {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ChimeraApp />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "开始配置" });
  expect(sidebar()).toMatchSnapshot("sidebar on the line overview");
  expect(titlebar()).toMatchSnapshot("titlebar on the line overview");

  fireEvent.click(screen.getByRole("button", { name: "Codex 管理" }));
  await screen.findByRole("heading", { name: "Codex 管理", level: 1 });
  expect(sidebar()).toMatchSnapshot("sidebar on another page");
  expect(titlebar()).toMatchSnapshot("titlebar on another page");

  fireEvent.click(screen.getByRole("button", { name: "线路" }));
  fireEvent.click(await screen.findByRole("button", { name: "开始配置" }));
  await screen.findByRole("region", { name: "新建线路" });
  expect(sidebar()).toBeNull();
  expect(titlebar({ expectSearch: false })).toMatchSnapshot(
    "titlebar while editing a line",
  );
});
