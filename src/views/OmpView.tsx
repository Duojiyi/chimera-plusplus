import { useContext, useState } from "react";
import { ToolPageActiveContext } from "@/components/RetainedToolPage";
import { PiPluginMarket } from "./PiPluginMarket";
import { OmpProviders } from "./OmpProviders";
import "./ToolView.css";

const tabs = [
  ["routes", "模型线路"],
  ["plugins", "插件市场"],
  ["runtime", "安装与更新"],
] as const;
type Tab = (typeof tabs)[number][0];

export default function OmpView({ native }: { native: boolean }) {
  const [tab, setTab] = useState<Tab>("routes");
  const [marketVisited, setMarketVisited] = useState(false);
  const active = useContext(ToolPageActiveContext);
  return (
    <div className="tool-view text-[var(--text-1)] box-border w-full h-full flex flex-col bg-[var(--bg-surface)] overflow-y-auto">
      <header className="px-6 pt-5 shrink-0">
        <h1 className="m-0 text-2xl font-bold">oh-my-pi</h1>
        <p className="mt-1 text-sm text-[var(--text-3)]">独立配置与插件管理</p>
        <nav
          aria-label="oh-my-pi 管理导航"
          className="mt-5 flex gap-6 border-b"
        >
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "page" : undefined}
              className={`pb-3 text-sm border-b-2 transition-colors ${tab === id ? "border-primary text-[var(--text-1)] font-semibold" : "border-transparent text-[var(--text-3)] hover:text-[var(--text-1)]"}`}
              onClick={() => {
                setTab(id);
                if (id !== "routes") setMarketVisited(true);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <div className="w-full max-w-5xl p-6">
        <ToolPageActiveContext.Provider value={active && tab === "routes"}>
          <div hidden={tab !== "routes"}>
            <OmpProviders native={native} />
          </div>
        </ToolPageActiveContext.Provider>
        {marketVisited && (
          <ToolPageActiveContext.Provider value={active && tab !== "routes"}>
            <div hidden={tab === "routes"}>
              <PiPluginMarket
                native={native}
                runtime="omp"
                panel={tab === "runtime" ? "runtime" : "plugins"}
              />
            </div>
          </ToolPageActiveContext.Provider>
        )}
      </div>
    </div>
  );
}
