import { render, screen, fireEvent } from "@testing-library/react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("FullScreenPanel", () => {
  it("names the back button and restores the previous scroll lock", () => {
    const onClose = vi.fn();
    document.body.style.overflow = "scroll";
    const { unmount } = render(
      <FullScreenPanel isOpen title="Edit MCP" onClose={onClose}>
        Content
      </FullScreenPanel>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });
  it("does not unlock the body when a closed panel unmounts", () => {
    document.body.style.overflow = "hidden";
    const { unmount } = render(
      <FullScreenPanel isOpen={false} title="Closed" onClose={() => {}}>
        Content
      </FullScreenPanel>,
    );
    unmount();
    expect(document.body.style.overflow).toBe("hidden");
    document.body.style.overflow = "";
  });
});
