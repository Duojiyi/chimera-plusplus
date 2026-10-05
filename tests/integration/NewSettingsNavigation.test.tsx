import { ThemeProvider } from "@/components/theme-provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({}) }));
vi.mock("@/lib/api/liveBackups", () => ({
  liveBackupsApi: { list: vi.fn(async () => []) },
}));
import { NewSettingsView } from "@/views/NewSettingsView";

// Section tops inside the scrolled page. The page can scroll 1000px, so the
// two trailing sections can never reach the top edge.
const offsets: Record<string, number> = {
  "settings-backups": 0,
  "settings-connections": 400,
  "settings-directories": 560,
  "settings-general": 680,
  "settings-codex": 1080,
  "settings-updates": 1260,
};
const maxScroll = 1000;
const viewportTop = 100;
let scroller: HTMLElement | undefined;

beforeEach(() => {
  scroller = undefined;
  window.history.replaceState(null, "", window.location.pathname);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top =
        this === scroller
          ? viewportTop
          : Object.hasOwn(offsets, this.id)
            ? viewportTop + offsets[this.id] - (scroller?.scrollTop ?? 0)
            : 0;
      return { top, bottom: top, left: 0, right: 0 } as DOMRect;
    },
  );
});
afterEach(() => vi.restoreAllMocks());

function mount(liveBackupsEnabled = false) {
  const view = render(
    <ThemeProvider>
      <NewSettingsView liveBackupsEnabled={liveBackupsEnabled} />
    </ThemeProvider>,
  );
  const element = screen.getByLabelText("设置内容");
  let position = 0;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => position,
    set: (value: number) => {
      position = Math.max(0, Math.min(maxScroll, value));
    },
  });
  scroller = element;
  return { view, scroller: element };
}
const current = () =>
  screen
    .getByRole("navigation", { name: "设置目录" })
    .querySelector('[aria-current="location"]')?.textContent;
const open = (name: string) =>
  fireEvent.click(screen.getByRole("link", { name }));
const userScrollTo = (element: HTMLElement, top: number) => {
  element.scrollTop = top;
  fireEvent.scroll(element);
};

it("keeps the clicked section current when the page cannot scroll it to the top", () => {
  const { scroller } = mount();
  open("Codex 偏好");
  expect(scroller.scrollTop).toBe(maxScroll);
  // The browser reports the jump as a scroll event at the bottom of the page.
  fireEvent.scroll(scroller);
  expect(current()).toBe("Codex 偏好");
  open("应用更新");
  fireEvent.scroll(scroller);
  expect(current()).toBe("应用更新");
});

it("follows the user's scrolling afterwards without jumping at the bottom", () => {
  const { scroller } = mount();
  open("Codex 偏好");
  fireEvent.scroll(scroller);
  userScrollTo(scroller, 700);
  expect(current()).toBe("通用设置");
  userScrollTo(scroller, 380);
  expect(current()).toBe("代理与故障转移");
  userScrollTo(scroller, maxScroll);
  expect(current()).toBe("通用设置");
});

it("moves focus to the chosen section for keyboard users", () => {
  mount();
  open("通用设置");
  expect(document.getElementById("settings-general")).toHaveFocus();
});

it("opens at the top again after leaving Settings", () => {
  const { view } = mount();
  open("通用设置");
  expect(window.location.hash).toBe("#settings-general");
  view.unmount();
  mount();
  expect(current()).toBe("工具");
  expect(window.location.hash).toBe("");
});

it("keeps the reset action in the scroll flow so it never covers a row", () => {
  const { scroller } = mount();
  open("应用更新");
  const reset = screen.getByRole("button", { name: "恢复默认设置" });
  expect(scroller).toContainElement(reset);
  expect(reset.closest("footer")).toHaveTextContent("主题与开机自启动保持不变");
});

it("puts the backup heading before its controls and the database row after them", async () => {
  mount(true);
  open("备份与恢复");
  const heading = screen.getByRole("heading", { name: "备份与恢复" });
  const picker = screen.getByLabelText("备份的工具");
  const database = screen.getByRole("button", { name: "应用数据库" });
  await screen.findByText("暂无 Codex 配置备份。");
  expect(
    heading.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    picker.compareDocumentPosition(database) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(database).toHaveAttribute("aria-expanded", "false");
});
