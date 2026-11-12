import type { VisibleApps } from "@/types";
import {
  additionalToolNames,
  nativeToolNames,
} from "@/utils/toolProviderConfig";

export const toolDisplayNames: Record<keyof VisibleApps, string> = {
  codex: "Codex",
  ...nativeToolNames,
  ...additionalToolNames,
  omp: "oh-my-pi",
};
