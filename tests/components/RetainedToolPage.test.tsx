import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RetainedToolPage } from "@/components/RetainedToolPage";
import { ConfirmDialog } from "@/components/ConfirmDialog";

describe("retained tool pages", () => {
  it("does not mount an unvisited page", () => {
    const mount = vi.fn();
    function Page() {
      mount();
      return <p>page</p>;
    }
    const { rerender } = render(
      <RetainedToolPage active={false}>
        <Page />
      </RetainedToolPage>,
    );
    expect(mount).not.toHaveBeenCalled();
    rerender(
      <RetainedToolPage active>
        <Page />
      </RetainedToolPage>,
    );
    expect(screen.getByText("page")).toBeVisible();
    rerender(
      <RetainedToolPage active={false}>
        <Page />
      </RetainedToolPage>,
    );
    expect(screen.getByText("page")).not.toBeVisible();
  });

  it("hides portalled confirmations on navigation without executing them", () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const page = (active: boolean) => (
      <RetainedToolPage active={active}>
        <ConfirmDialog
          isOpen
          title="Install plugin?"
          message="Trust the source first"
          onConfirm={confirm}
          onCancel={cancel}
          confirmText="Install"
        />
      </RetainedToolPage>
    );
    const { rerender } = render(page(true));
    expect(screen.getByRole("dialog")).toBeVisible();
    rerender(page(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    rerender(page(true));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(confirm).toHaveBeenCalledOnce();
  });
});
