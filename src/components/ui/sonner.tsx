import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/components/theme-provider";
import {
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";

export function Toaster() {
  const { theme } = useTheme();

  // 将应用主题映射到 Sonner 的主题
  // 如果是 "system"，Sonner 会自己处理
  const sonnerTheme = theme === "system" ? "system" : theme;

  return (
    <SonnerToaster
      className="chimera-toaster"
      position="bottom-right"
      offset={24}
      gap={10}
      closeButton
      visibleToasts={3}
      theme={sonnerTheme}
      icons={{
        success: <CircleCheck aria-hidden="true" />,
        info: <Info aria-hidden="true" />,
        warning: <TriangleAlert aria-hidden="true" />,
        error: <CircleAlert aria-hidden="true" />,
        loading: (
          <LoaderCircle className="chimera-toast-spinner" aria-hidden="true" />
        ),
        close: <X aria-hidden="true" />,
      }}
      toastOptions={{
        unstyled: true,
        duration: 4000,
        classNames: {
          toast: "chimera-toast",
          content: "chimera-toast-content",
          icon: "chimera-toast-icon",
          title: "chimera-toast-title",
          description: "chimera-toast-description",
          closeButton: "chimera-toast-close",
          actionButton: "chimera-toast-action",
          cancelButton: "chimera-toast-cancel",
        },
      }}
    />
  );
}
