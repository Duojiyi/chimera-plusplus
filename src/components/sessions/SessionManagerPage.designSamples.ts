/**
 * Browser design-preview fixtures for the 会话 page (L12).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so the
 * layout can be reviewed without a backend. Real sessions always come from
 * `sessionsApi`; nothing here is written anywhere.
 */
import type { SessionMessage, SessionMeta } from "@/types";

export const isSessionsDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

const now = Date.now();
const minutes = (value: number) => now - value * 60_000;

const codex = (
  id: string,
  title: string,
  projectDir: string,
  ageMinutes: number,
): SessionMeta => ({
  providerId: "codex",
  sessionId: id,
  title,
  projectDir,
  createdAt: minutes(ageMinutes + 72),
  lastActiveAt: minutes(ageMinutes),
  sourcePath: `~/.codex/sessions/2026/11/10/rollout-${id}.jsonl`,
  resumeCommand: `codex resume ${id}`,
});

export const SESSIONS_DESIGN_SAMPLE: SessionMeta[] = [
  codex(
    "thr_7f3a91",
    "修复 Windows 上 IPv6 半瘫导致的连接超时",
    "~/chimera-plusplus",
    3,
  ),
  codex("thr_52c0de", "把线路表改成可排序的分组视图", "~/chimera-plusplus", 64),
  codex(
    "thr_19aa40",
    "审查 merge-plan 里的三个补丁",
    "~/chimera-plusplus",
    128,
  ),
  codex("thr_c4e7b2", "给账号卡加额度进度条", "~/chimera-plusplus", 1_480),
  codex(
    "thr_0b8f13",
    "排查 Skills 哈希为什么重复导入",
    "~/chimera-plusplus",
    1_640,
  ),
  codex("thr_6d21e9", "设计稿 L02 的排版反馈", "~/designs", 4_100),
  {
    providerId: "claude",
    sessionId: "c8a1f0e2",
    title: "重构 usage_stats 的过滤器",
    projectDir: "~/chimera-plusplus",
    createdAt: minutes(5_800),
    lastActiveAt: minutes(5_720),
    sourcePath: "~/.claude/projects/chimera-plusplus/c8a1f0e2.jsonl",
    resumeCommand: "claude --resume c8a1f0e2",
  },
];

export const SESSION_MESSAGES_DESIGN_SAMPLE: SessionMessage[] = [
  {
    role: "user",
    content:
      "连接 DeepSeek 时偶尔要等 40 秒才失败，日志里是 TcpStream::connect 卡住。",
    ts: minutes(75),
  },
  {
    role: "assistant",
    content:
      "看到了。现在 hyper_client 里先试 IPv6，再串行试 IPv4，没有连接级超时，所以半瘫时只能等系统默认的 20 秒两次。建议改成两族并发、先成功的胜出。",
    ts: minutes(74),
  },
  {
    role: "user",
    content: "并发会不会让代理服务器看到两次连接？",
    ts: minutes(70),
  },
  {
    role: "assistant",
    content:
      "会。所以只在多地址时才竞速，并且失败方立即 cancel；单地址仍然走原来的路径。改完在 hyper_client.rs 附近加一个连不上的单测。",
    ts: minutes(69),
  },
];
