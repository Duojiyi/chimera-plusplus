import type {
  OfficialAccountDto,
  OfficialQuota,
} from "@/lib/api/officialAccounts";

/**
 * Browser design-preview fixtures for the official accounts page (L02/L03/L38).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`.
 * Counts follow the shared fake-data baseline (design system §6): 5 accounts,
 * alpha / beta / team usable, third needs a new sign-in, old is disabled.
 * Every write is refused while these are on screen.
 */
export const isAccountsDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const base = (
  key: string,
  email: string,
  planType: string,
  extra: Partial<OfficialAccountDto> = {},
): OfficialAccountDto => ({
  key,
  accountId: `sample-${key}`,
  displayName: `ChatGPT · ${email}`,
  email,
  planType,
  lineName: `ChatGPT · ${email}`,
  capturedAt: "2026-10-28",
  isCurrent: false,
  isSelected: false,
  needsRelogin: false,
  providerId: `sample-line-${key}`,
  liveState: "matched",
  tags: [],
  disabled: false,
  ...extra,
});

export function sampleAccounts(now: number): OfficialAccountDto[] {
  return [
    base("alpha", "alpha@studio.dev", "plus", {
      isCurrent: true,
      isSelected: true,
      tags: ["主力", "工作"],
      groupName: "工作",
      lastUsedAt: now - 12 * MINUTE,
    }),
    base("beta", "beta@studio.dev", "pro", {
      tags: ["备用"],
      groupName: "工作",
      lastUsedAt: now - 3 * HOUR,
    }),
    base("third", "third@gmail.com", "plus", {
      needsRelogin: true,
      tags: ["个人"],
      groupName: "个人",
      lastUsedAt: now - 2 * DAY,
    }),
    base("team", "team@research.io", "team", {
      tags: ["团队", "共享"],
      groupName: "团队",
      lastUsedAt: now - 26 * MINUTE,
    }),
    base("old", "old@personal.me", "plus", {
      disabled: true,
      tags: ["归档"],
      lastUsedAt: now - 21 * DAY,
    }),
  ];
}

const reading = (
  now: number,
  fiveHour: number,
  fiveReset: number,
  week: number,
  weekReset: number,
): OfficialQuota => ({
  tool: "codex",
  credentialStatus: "valid",
  credentialMessage: null,
  success: true,
  tiers: [
    {
      name: "five_hour",
      utilization: fiveHour,
      resetsAt: new Date(now + fiveReset).toISOString(),
    },
    {
      name: "seven_day",
      utilization: week,
      resetsAt: new Date(now + weekReset).toISOString(),
    },
  ],
  extraUsage: null,
  error: null,
  queriedAt: now - 2 * MINUTE,
});

export function sampleQuotas(now: number): Record<string, OfficialQuota> {
  return {
    alpha: reading(now, 62, 2 * HOUR + 14 * MINUTE, 41, 4 * DAY),
    beta: reading(now, 18, HOUR + 2 * MINUTE, 73, 3 * DAY),
    team: reading(now, 88, 4 * HOUR + 40 * MINUTE, 12, 6 * DAY),
    old: reading(now, 0, 5 * HOUR, 5, 2 * DAY),
  };
}
