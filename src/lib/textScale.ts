export type TextScale = "standard" | "comfortable";

export const TEXT_SCALE_STORAGE_KEY = "chimera-text-scale";

export const TEXT_SCALE_OPTIONS: ReadonlyArray<
  readonly [TextScale, string, string]
> = [
  [
    "standard",
    "标准清晰",
    "默认高可读字阶（≥ 13px–15px），兼顾信息密度与清晰度",
  ],
  [
    "comfortable",
    "舒适大字",
    "增大全局正文、路径与辅助说明字号（≥ 14.5px–17px），改善弱视力与高分屏阅读体验",
  ],
];

export function normalizeTextScale(
  value: string | null | undefined,
): TextScale {
  return value === "comfortable" ? "comfortable" : "standard";
}

export function readTextScale(): TextScale {
  try {
    return normalizeTextScale(
      window.localStorage.getItem(TEXT_SCALE_STORAGE_KEY),
    );
  } catch {
    return "standard";
  }
}

export function applyTextScale(scale: TextScale): void {
  if (typeof document === "undefined") return;
  if (scale === "comfortable") {
    document.documentElement.dataset.textScale = "comfortable";
  } else {
    delete document.documentElement.dataset.textScale;
  }
}

export function setTextScale(scale: TextScale): void {
  applyTextScale(scale);
  try {
    window.localStorage.setItem(TEXT_SCALE_STORAGE_KEY, scale);
  } catch {
    // Ignore storage quota or restricted context errors.
  }
}

export function initTextScale(): () => void {
  applyTextScale(readTextScale());
  const onStorage = (event: StorageEvent) => {
    if (event.key === TEXT_SCALE_STORAGE_KEY) {
      applyTextScale(normalizeTextScale(event.newValue));
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
