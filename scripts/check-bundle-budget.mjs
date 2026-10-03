import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const indexPath = path.join(dist, "index.html");

const limits = {
  entryBytes: 720 * 1024,
  startupBytes: 1500 * 1024,
  chunkBytes: 850 * 1024,
  cssBytes: 200 * 1024,
  fontBytes: 12 * 1024 * 1024,
};

if (!fs.existsSync(indexPath)) {
  throw new Error("dist/index.html is missing; run the renderer build first");
}

const html = fs.readFileSync(indexPath, "utf8");
const referenced = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(
  (match) => match[1],
);
const startupAssets = [...new Set(referenced)].filter((asset) =>
  /\.(?:js|css)$/.test(asset),
);

function sizeOf(relativePath) {
  const absolute = path.join(dist, relativePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`referenced startup asset is missing: ${relativePath}`);
  }
  return fs.statSync(absolute).size;
}

const entryScript = startupAssets.find((asset) => asset.endsWith(".js"));
if (!entryScript) {
  throw new Error(
    "unable to locate the renderer entry script in dist/index.html",
  );
}

const assetsDir = path.join(dist, "assets");
const chunks = fs
  .readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => ({ name: `assets/${name}`, bytes: sizeOf(`assets/${name}`) }))
  .sort((a, b) => b.bytes - a.bytes);
const css = fs
  .readdirSync(assetsDir)
  .filter((name) => name.endsWith(".css"))
  .map((name) => ({ name: `assets/${name}`, bytes: sizeOf(`assets/${name}`) }))
  .sort((a, b) => b.bytes - a.bytes);

const fonts = fs
  .readdirSync(assetsDir)
  .filter((name) => /\.(?:woff2?|ttf|otf)$/.test(name))
  .map((name) => ({ name: `assets/${name}`, bytes: sizeOf(`assets/${name}`) }));
const fontBytes = fonts.reduce((total, font) => total + font.bytes, 0);
const entryBytes = sizeOf(entryScript);
const startupBytes = startupAssets.reduce(
  (total, asset) => total + sizeOf(asset),
  0,
);
const failures = [];

if (fontBytes > limits.fontBytes) {
  failures.push(`fonts total ${fontBytes} bytes (limit ${limits.fontBytes})`);
}
for (const family of ["Overpass", "OverpassMono", "NotoSansSC"]) {
  if (
    !fonts.some((font) => path.basename(font.name).startsWith(`${family}-`))
  ) {
    failures.push(`bundled font missing: ${family}`);
  }
  if (!fs.existsSync(path.join(dist, "licenses", `${family}-OFL.txt`))) {
    failures.push(`font license missing: ${family}`);
  }
}
if (entryBytes > limits.entryBytes) {
  failures.push(
    `entry ${entryScript} is ${entryBytes} bytes (limit ${limits.entryBytes})`,
  );
}
if (startupBytes > limits.startupBytes) {
  failures.push(
    `startup assets total ${startupBytes} bytes (limit ${limits.startupBytes})`,
  );
}
for (const chunk of chunks) {
  if (chunk.bytes > limits.chunkBytes) {
    failures.push(
      `chunk ${chunk.name} is ${chunk.bytes} bytes (limit ${limits.chunkBytes})`,
    );
  }
}
for (const stylesheet of css) {
  if (stylesheet.bytes > limits.cssBytes) {
    failures.push(
      `stylesheet ${stylesheet.name} is ${stylesheet.bytes} bytes (limit ${limits.cssBytes})`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      entry: { name: entryScript, bytes: entryBytes },
      startupBytes,
      fontBytes,
      fonts,
      largestChunks: chunks.slice(0, 8),
      stylesheets: css,
      limits,
    },
    null,
    2,
  ),
);

if (failures.length) {
  throw new Error(`bundle budget exceeded:\n- ${failures.join("\n- ")}`);
}
