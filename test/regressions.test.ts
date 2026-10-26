import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const root = join(import.meta.dirname, "..");
const sourceFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));

describe("regressions", () => {
  it("never writes to stdout, which carries the MCP protocol", () => {
    for (const file of sourceFiles) {
      const code = readFileSync(join(root, "src", file), "utf8");
      expect(code, file).not.toMatch(/console\.(log|info|debug|warn|error)\(|process\.stdout/);
    }
  });

  it("reports the package version everywhere", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
  });

  it("only ever talks to Google through the SDK (no hand-built URLs with the key)", () => {
    for (const file of sourceFiles) {
      expect(readFileSync(join(root, "src", file), "utf8"), file).not.toMatch(/[?&]key=\$\{|fetch\(/);
    }
  });
});

describe("install from GitHub", () => {
  it("has no script that makes npm install dev dependencies and rebuild on `npx github:...`", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies?: object };
    for (const name of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) {
      expect(pkg.scripts, name).not.toHaveProperty(name);
    }
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
