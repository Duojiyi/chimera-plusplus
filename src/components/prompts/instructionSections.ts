export type InstructionSection = {
  kind: "user" | "managed" | "foreign";
  text: string;
};

const BLOCKS = [
  {
    kind: "managed",
    begin: "<!-- CHIMERA:INSTRUCTIONS:BEGIN -->",
    end: "<!-- CHIMERA:INSTRUCTIONS:END -->",
  },
  {
    kind: "foreign",
    begin: "<!-- CODEX-X:INSTRUCTIONS:BEGIN -->",
    end: "<!-- CODEX-X:INSTRUCTIONS:END -->",
  },
] as const;

const count = (text: string, marker: string) => text.split(marker).length - 1;

/**
 * Split AGENTS.md into the user's text and the managed blocks, in file order.
 * Returns null when markers are incomplete, repeated or nested: the backend
 * refuses to write such a file, so the page shows it unsplit.
 */
export function splitInstructionFile(
  text: string,
): InstructionSection[] | null {
  const ranges: { kind: "managed" | "foreign"; start: number; end: number }[] =
    [];
  for (const { kind, begin, end } of BLOCKS) {
    const begins = count(text, begin);
    const ends = count(text, end);
    if (begins === 0 && ends === 0) continue;
    const start = text.indexOf(begin);
    const finish = text.indexOf(end);
    if (begins !== 1 || ends !== 1 || finish < start) return null;
    ranges.push({ kind, start, end: finish + end.length });
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.length === 2 && ranges[1].start < ranges[0].end) return null;
  const sections: InstructionSection[] = [];
  const pushUser = (part: string) => {
    // Blank lines around a block belong to the layout, not to the user's text.
    const trimmed = part.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
    // String#trim also drops a byte-order mark.
    if (trimmed.trim()) sections.push({ kind: "user", text: trimmed });
  };
  let cursor = 0;
  for (const range of ranges) {
    pushUser(text.slice(cursor, range.start));
    sections.push({
      kind: range.kind,
      text: text.slice(range.start, range.end),
    });
    cursor = range.end;
  }
  pushUser(text.slice(cursor));
  return sections;
}
