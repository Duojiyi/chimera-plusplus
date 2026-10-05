// Browser-preview markup of the sidebar and titlebar. Moving these regions
// into their own modules must not change a single attribute; a deliberate
// visual change updates the snapshot in the same commit.
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import ChimeraApp from "@/ChimeraApp";
import { createTestQueryClient } from "../utils/testQueryClient";

const sidebar = () => document.querySelector('[data-pencil-name="侧栏"]');
const titlebar = () => document.querySelector('[data-pencil-name="标题栏"]');

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
  expect(titlebar()).toMatchSnapshot("titlebar while editing a line");
});
