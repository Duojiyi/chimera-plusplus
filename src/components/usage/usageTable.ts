/**
 * The one alignment rule for every usage table: text left, numbers right, each
 * header aligned like its cells, tabular figures in number columns. Header and
 * cells share the horizontal padding, so the first and last columns line up.
 */
export const usageTable = {
  th: "h-10 px-3 text-left text-xs whitespace-nowrap",
  thNum: "h-10 px-3 text-right text-xs whitespace-nowrap",
  td: "px-3 py-2.5 text-left",
  tdNum: "px-3 py-2.5 text-right tabular-nums whitespace-nowrap",
  /** Loading placeholder; a token colour so dark mode never flashes white. */
  skeleton:
    "h-[400px] animate-pulse rounded bg-[var(--bg-subtle)] motion-reduce:animate-none",
} as const;
