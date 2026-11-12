const path = require("node:path");

// v3.0 液态玻璃：把 v2.8 遗留样式统一收进 `@layer legacy`。
// 未分层的样式在级联里永远压过分层样式（与选择器特异性、引入顺序无关），
// 所以 liquid-glass-v3.css 保持未分层即可稳定覆盖旧层；旧层彼此之间的
// 先后与特异性关系不变（同在一个 layer 里）。
// 例外：
//   - liquid-glass-v3.css 与 theme/v3/**：v3 主体与逐页 v3 样式，必须未分层；
//   - sonner.css：覆盖 sonner 运行时注入的（未分层）样式，进 layer 会反输。
// 旧层清理完成后，这个插件连同 legacy layer 一起删除。
const UNLAYERED = new Set(["theme/liquid-glass-v3.css", "components/ui/sonner.css"]);
const isUnlayered = (rel) => UNLAYERED.has(rel) || rel.startsWith("theme/v3/");
const SRC = path.resolve(__dirname, "src");

const wrapLegacyLayer = () => ({
  postcssPlugin: "chimera-wrap-legacy-layer",
  OnceExit(root, { AtRule }) {
    const from = root.source?.input?.file;
    if (!from) return;
    const rel = path.relative(SRC, from).replaceAll("\\", "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;
    if (isUnlayered(rel)) return;
    if (!root.nodes.length) return;
    const layer = new AtRule({ name: "layer", params: "legacy" });
    // @charset / @import 必须留在顶层（目前源码里没有，防御性处理）。
    const keep = root.nodes.filter(
      (n) => n.type === "atrule" && /^(charset|import)$/i.test(n.name),
    );
    root.nodes
      .filter((n) => !keep.includes(n))
      .forEach((n) => layer.append(n.remove()));
    root.append(layer);
  },
});
wrapLegacyLayer.postcss = true;

// v3.0 只有一套浅色主题（main.tsx 里 forceTheme="light"，根节点永远不会带
// .dark），Tailwind 为组件里的 `dark:` 写法生成的变体规则不会命中，删掉以免
// 白白进包。只删选择器全部带 .dark 的规则；混合选择器只去掉 .dark 那几项。
const DARK_SELECTOR = /(^|[\s>+~(,])\.dark(?![\w-])|:where\(\.dark\b/;
const dropDarkVariant = () => ({
  postcssPlugin: "chimera-drop-dark-variant",
  OnceExit(root) {
    root.walkRules((rule) => {
      const live = rule.selectors.filter((sel) => !DARK_SELECTOR.test(sel));
      if (!live.length) rule.remove();
      else if (live.length !== rule.selectors.length) rule.selectors = live;
    });
  },
});
dropDarkVariant.postcss = true;

module.exports = {
  plugins: [
    require("tailwindcss"),
    dropDarkVariant(),
    wrapLegacyLayer(),
    require("autoprefixer"),
  ],
};
