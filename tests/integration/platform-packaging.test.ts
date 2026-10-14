import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Static contracts over packaging sources (not installer or bundle runtime tests).
const repoRoot = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(repoRoot, file), "utf8");
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));

const wixTemplates = readdirSync(path.join(repoRoot, "src-tauri/wix"))
  .filter((name) => name.endsWith(".wxs"))
  .map((name) => `src-tauri/wix/${name}`);
const configuredTemplate = path.posix.join(
  "src-tauri",
  String(tauriConfig.bundle.windows.wix.template),
);

const desktopFolderBody = (wix: string): string =>
  wix.match(
    /<Directory Id="DesktopFolder"[^>]*>([\s\S]*?)<\/Directory>/,
  )?.[1] ?? "";

describe("MSI upgrades respect a deleted desktop shortcut", () => {
  it("checks the template the bundler is configured to use", () => {
    expect(wixTemplates).toContain(configuredTemplate);
  });

  it.each(wixTemplates)(
    "%s only creates the desktop shortcut on a fresh install or when it still exists",
    (file) => {
      const wix = read(file);
      const desktop = desktopFolderBody(wix);
      if (!desktop.includes("<Shortcut")) {
        // Only a template without a desktop shortcut may skip these checks.
        expect(file).not.toBe(configuredTemplate);
        return;
      }

      const components = [
        ...desktop.matchAll(/<Component\b[^>]*>([\s\S]*?)<\/Component>/g),
      ].map((match) => match[1]);
      expect(components).toHaveLength(1);
      const [component] = components;
      expect(component).toContain(
        "<Condition><![CDATA[NOT WIX_UPGRADE_DETECTED OR DESKTOPSHORTCUTEXISTS]]></Condition>",
      );

      // The search must look for the file the shortcut actually writes
      // (Windows Installer adds `.lnk` to the shortcut name).
      const shortcutName = component.match(
        /<Shortcut\b[^>]*\sName="([^"]+)"/,
      )?.[1];
      expect(shortcutName).toBe("{{product_name}}");
      const property = wix.match(
        /<Property Id="DESKTOPSHORTCUTEXISTS"[^>]*>([\s\S]*?)<\/Property>/,
      )?.[1];
      expect(property).toMatch(
        /<DirectorySearch Id="[^"]+" Path="\[DesktopFolder\]" Depth="0">\s*<FileSearch Id="[^"]+" Name="([^"]+)" \/>\s*<\/DirectorySearch>/,
      );
      expect(property?.match(/<FileSearch\b[^>]*\sName="([^"]+)"/)?.[1]).toBe(
        `${shortcutName}.lnk`,
      );

      // WIX_UPGRADE_DETECTED is set by FindRelatedProducts for MajorUpgrade.
      expect(wix).toMatch(/<MajorUpgrade\b/);
    },
  );
});

describe("macOS Info.plist overrides", () => {
  const plist = read("src-tauri/Info.plist");

  it("describes why local network access is requested", () => {
    expect(plist).toMatch(
      /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>Chimera\+\+ 需要访问本地网络，以连接你填写的局域网 API 地址。<\/string>/,
    );
  });

  it("leaves deep-link schemes to the deep-link plugin config", () => {
    // Top-level keys here replace the bundler's generated ones, so a URL type
    // list here would hide schemes declared in tauri.conf.json.
    expect(plist).not.toContain("<key>CFBundleURLTypes</key>");
    expect(plist).not.toContain("CC Switch");
    expect(tauriConfig.plugins["deep-link"].desktop.schemes).toEqual([
      "chimera",
      "ccswitch",
    ]);
  });
});
