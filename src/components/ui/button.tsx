import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[4px] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // 主按钮：蓝底白字（对应旧版 primary）
        default:
          "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] hover:bg-[var(--btn-primary-bg-hover)] active:bg-[var(--btn-primary-bg-pressed)]",
        // 危险按钮：红底白字（对应旧版 danger）
        destructive:
          "bg-[var(--btn-danger-bg)] text-[var(--btn-danger-fg)] hover:bg-[var(--btn-danger-bg-hover)]",
        // 轮廓按钮
        outline:
          "border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--text-2)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-1)]",
        // 次按钮：灰色（对应旧版 secondary）
        secondary:
          "bg-[var(--bg-subtle)] text-[var(--text-2)] hover:bg-[var(--bg-selected)]",
        // 幽灵按钮（对应旧版 ghost）
        ghost:
          "text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-subtle)]",
        // MCP 专属按钮：祖母绿
        mcp: "bg-emerald-500 text-white hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-700",
        // 链接按钮
        link: "text-[var(--brand)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-[4px] px-3 text-xs",
        lg: "h-10 rounded-[4px] px-8",
        icon: "h-9 w-9 p-1.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
