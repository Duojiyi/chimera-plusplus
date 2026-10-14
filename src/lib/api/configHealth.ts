import { invoke } from "@tauri-apps/api/core";

export interface ConfigHealthIssue {
  id: string;
  severity: "critical" | "warning";
  title: string;
  /** The file the issue is in, e.g. "config.toml". */
  location: string;
  impact: string;
  solution: string;
  repairable: boolean;
  /** 1-based line; absent when the parameter has no line in the file. */
  line?: number;
  /** 1-based column in Unicode characters. */
  column?: number;
  /** Codex parameter name; never a user-defined table name or a value. */
  field?: string;
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
