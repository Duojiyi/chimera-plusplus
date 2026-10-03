import { invoke } from "@tauri-apps/api/core";

export interface ConfigHealthIssue {
  id: string;
  severity: "critical" | "warning";
  title: string;
  location: string;
  impact: string;
  solution: string;
  repairable: boolean;
}
export interface ConfigHealthReport {
  issues: ConfigHealthIssue[];
  checkedAt: string;
  readOnly: boolean;
  repairToken?: string;
}
export const configHealthApi = {
  repairOwnedInstructions: (
    expectedToken: string,
  ): Promise<ConfigHealthReport> =>
    invoke("repair_codex_owned_instruction_refs", { expectedToken }),
  check: (): Promise<ConfigHealthReport> => invoke("check_codex_config_health"),
};
