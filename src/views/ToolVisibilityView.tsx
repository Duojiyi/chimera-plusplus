import { lazy, Suspense } from "react";

// ChimeraApp imports this view eagerly. Loading the page itself on demand
// keeps its script and stylesheet out of the startup bundle, like the
// neighbouring views.
const ToolVisibilityPage = lazy(() =>
  import("@/components/settings/ToolVisibilityPage").then((module) => ({
    default: module.ToolVisibilityPage,
  })),
);

export function ToolVisibilityView({ native }: { native: boolean }) {
  return (
    <Suspense
      fallback={
        <div className="route-loading" role="status">
          正在加载模块…
        </div>
      }
    >
      <ToolVisibilityPage native={native} />
    </Suspense>
  );
}
