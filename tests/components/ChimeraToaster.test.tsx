import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";

const mocks = vi.hoisted(() => ({ render: vi.fn(), theme: "dark" }));
vi.mock("sonner", () => ({
  Toaster: (props: unknown) => {
    mocks.render(props);
    return null;
  },
}));
vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: mocks.theme }),
}));

describe("Chimera notifications", () => {
  it("owns the notification layout without default Sonner styling", () => {
    render(<Toaster />);
    expect(mocks.render).toHaveBeenCalledWith(
      expect.objectContaining({
        position: "bottom-right",
        offset: 24,
        closeButton: true,
        visibleToasts: 3,
        theme: "dark",
        toastOptions: expect.objectContaining({
          unstyled: true,
          duration: 4000,
          classNames: expect.objectContaining({
            closeButton: "chimera-toast-close",
            toast: "chimera-toast",
          }),
        }),
      }),
    );
  });
});
