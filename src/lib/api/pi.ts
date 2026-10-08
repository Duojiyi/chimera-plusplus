import { invoke } from "@tauri-apps/api/core";

export type PiDocumentKind = "settings" | "mcp";
export interface PiDocument {
  value: Record<string, unknown>;
  revision: string;
  path: string;
}
export const piApi = {
  read: (kind: PiDocumentKind) =>
    invoke<PiDocument>("get_pi_document", { kind }),
  save: (
    kind: PiDocumentKind,
    value: Record<string, unknown>,
    expectedRevision: string,
  ) =>
    invoke<PiDocument>("save_pi_document", { kind, value, expectedRevision }),
};
