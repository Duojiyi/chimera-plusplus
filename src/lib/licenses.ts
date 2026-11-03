// Source-offer data shown under Settings → 应用更新. The commit must stay equal
// to the revision Cargo.lock locks for chimera-runtime, chimera-platform and
// chimera-domain (checked by scripts/release-workflow-guards.test.mjs).
export const REPOSITORY_URL = "https://github.com/Duojiyi/chimera-plusplus";
export const AGPL_SOURCE_COMMIT = "a3dac60c48bd6ff466e93a8a072450a153915b15";

export function licenseLinks(version: string) {
  const tag = /^\d+\.\d+\.\d+/.test(version) ? `v${version}` : null;
  return [
    {
      label: "当前版本源码",
      url: tag ? `${REPOSITORY_URL}/tree/${tag}` : REPOSITORY_URL,
    },
    {
      label: "AGPL 组件源码",
      url: `${REPOSITORY_URL}/tree/${AGPL_SOURCE_COMMIT}`,
    },
    {
      label: "第三方声明",
      url: tag
        ? `${REPOSITORY_URL}/blob/${tag}/THIRD_PARTY_NOTICES.md`
        : `${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md`,
    },
  ] as const;
}
