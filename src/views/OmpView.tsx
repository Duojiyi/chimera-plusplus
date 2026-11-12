import { useContext, useState } from "react";
import { ToolPageActiveContext } from "@/components/RetainedToolPage";
import { PiPluginMarket } from "./PiPluginMarket";
import { OmpProviders } from "./OmpProviders";
import {
  TOOL_SECTIONS,
  ToolSectionNav,
  resolveSection,
} from "./ToolSectionNav";
import "./ToolView.css";
import "@/theme/v3/tool-views.css";

const sections = TOOL_SECTIONS.omp;

const subtitles: Record<string, string> = {
  routes: "oh-my-pi · 独立配置 · 管理 OMP 自定义线路与模型，不影响 Pi",
  plugins: "oh-my-pi 的插件与市场源",
  install: "oh-my-pi 的安装、版本与环境检查",
};

export default function OmpView({
  native,
  section,
  onSectionChange,
}: {
  native: boolean;
  /** Section shown, driven by the shell sidebar; uncontrolled when omitted. */
  section?: string;
  onSectionChange?: (id: string) => void;
}) {
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const [ownSection, setOwnSection] = useState("routes");
  const controlled = Boolean(onSectionChange);
  const tab = resolveSection(
    sections,
    controlled ? section : ownSection,
    "routes",
  );
  const [marketVisited, setMarketVisited] = useState(tab !== "routes");
  if (tab !== "routes" && !marketVisited) setMarketVisited(true);
  const active = useContext(ToolPageActiveContext);
  const label = sections.find((item) => item.id === tab)?.label ?? "oh-my-pi";
  return (
    <div className="tool-view">
      <header className="tool-header">
        <div className="tool-title">
          <h1>{label}</h1>
          <p>{subtitles[tab]}</p>
        </div>
        <div
          ref={setActionsHost}
          className="tool-actions"
          hidden={tab !== "routes"}
          role="group"
          aria-label="oh-my-pi 工具操作"
        />
      </header>
      {!controlled && (
        <ToolSectionNav
          label="oh-my-pi 管理导航"
          sections={sections}
          current={tab}
          onChange={(id) => {
            setOwnSection(id);
            onSectionChange?.(id);
          }}
        />
      )}
      <div className="tool-section-content">
        <ToolPageActiveContext.Provider value={active && tab === "routes"}>
          <div hidden={tab !== "routes"}>
            <OmpProviders native={native} actionsHost={actionsHost} />
          </div>
        </ToolPageActiveContext.Provider>
        {marketVisited && (
          <ToolPageActiveContext.Provider value={active && tab !== "routes"}>
            <div hidden={tab === "routes"}>
              <PiPluginMarket
                native={native}
                runtime="omp"
                panel={tab === "install" ? "runtime" : "plugins"}
              />
            </div>
          </ToolPageActiveContext.Provider>
        )}
      </div>
    </div>
  );
}
