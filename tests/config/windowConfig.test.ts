import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("resizable desktop window", () => {
  it("keeps the design size as default while allowing resize and maximize", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
    ) as {
      app?: {
        windows?: Array<{
          width?: number;
          height?: number;
          minWidth?: number;
          minHeight?: number;
          maxWidth?: number;
          maxHeight?: number;
          resizable?: boolean;
          maximizable?: boolean;
          fullscreen?: boolean;
        }>;
      };
    };
    const main = config.app?.windows?.find((window) => window.width === 1140);

    expect(main).toMatchObject({
      width: 1140,
      height: 816,
      minWidth: 960,
      minHeight: 640,
      resizable: true,
      maximizable: true,
      fullscreen: false,
    });
    expect(main?.maxWidth).toBeUndefined();
    expect(main?.maxHeight).toBeUndefined();
  });
});
