import {
  createContext,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export const ToolPageActiveContext = createContext(true);

// Visit lazily, then retain drafts and native job results across navigation.
export function RetainedToolPage({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return active || visited ? (
    <ToolPageActiveContext.Provider value={active}>
      <div hidden={!active} className="h-full min-h-0">
        <Suspense fallback={<div className="route-loading">正在加载…</div>}>
          {children}
        </Suspense>
      </div>
    </ToolPageActiveContext.Provider>
  ) : null;
}
