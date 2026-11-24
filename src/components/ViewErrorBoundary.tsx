import React from "react";
import { Copy, RefreshCw, CircleAlert } from "lucide-react";
import {
  formatFrontendDiagnostics,
  reportFrontendError,
} from "@/lib/frontendLogger";
import { toast } from "sonner";
import "@/theme/v3/recovery.css";

interface ViewErrorBoundaryProps {
  viewKey: string;
  viewLabel?: string;
  children: React.ReactNode;
}

interface ViewErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

export class ViewErrorBoundary extends React.Component<
  ViewErrorBoundaryProps,
  ViewErrorBoundaryState
> {
  state: ViewErrorBoundaryState = { hasError: false, errorMessage: null };

  static getDerivedStateFromError(error: Error): ViewErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: formatFrontendDiagnostics(error),
    };
  }

  componentDidUpdate(prevProps: ViewErrorBoundaryProps): void {
    if (prevProps.viewKey !== this.props.viewKey && this.state.hasError) {
      this.setState({ hasError: false, errorMessage: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportFrontendError(
      `react.view_error_boundary.${this.props.viewKey}`,
      error,
      info.componentStack ?? undefined,
    );
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, errorMessage: null });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const diagnostics = this.state.errorMessage;
    return (
      <section role="alert" className="view-recovery">
        <header>
          <span className="view-recovery-icon" aria-hidden="true">
            <CircleAlert size={20} />
          </span>
          <div>
            <h2>
              {this.props.viewLabel ? `「${this.props.viewLabel}」` : "当前"}
              页面遇到渲染错误
            </h2>
            <code>{this.props.viewKey}</code>
          </div>
        </header>
        <p>
          异常已隔离在当前页面。你可以重新加载此页，也可以从侧栏切换至其他功能。
        </p>
        {diagnostics && (
          <div className="view-recovery-trace">
            <strong>诊断堆栈</strong>
            <pre>{diagnostics}</pre>
          </div>
        )}
        <footer>
          <button type="button" className="primary" onClick={this.handleRetry}>
            <RefreshCw size={15} />
            重新加载当前页面
          </button>
          {diagnostics && (
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(diagnostics);
                  toast.success("诊断堆栈已复制");
                } catch {
                  toast.error("复制失败，可选中诊断文本手动复制");
                }
              }}
            >
              <Copy size={15} />
              复制诊断堆栈
            </button>
          )}
        </footer>
      </section>
    );
  }
}
