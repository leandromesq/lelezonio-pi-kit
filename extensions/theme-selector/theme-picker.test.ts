/**
 * Unit tests for theme discovery, var resolution, current-theme detection,
 * and preview theme building.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildPreviewTheme,
  discoverThemes,
  getCurrentThemeName,
  resolveVarRefs,
  type ThemeJson,
} from "./theme-picker.ts";

const MINIMAL_THEME: ThemeJson = {
  name: "test-theme",
  vars: { accent: "#ffb597", surface: "#2b1e16" },
  colors: {
    accent: "accent",
    selectedBg: "#45342a",
    userMessageBg: "surface",
    thinkingXhigh: "#ffd1cb",
  },
};

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-theme-selector-"));
  return dir;
}

describe("resolveVarRefs", () => {
  it("resolves var references to their values", () => {
    const resolved = resolveVarRefs(
      { accent: "primary", muted: "gray" },
      { primary: "#00aaff", gray: 242 },
    );
    assert.equal(resolved.accent, "#00aaff");
    assert.equal(resolved.muted, 242);
  });

  it("resolves vars that reference other vars", () => {
    const resolved = resolveVarRefs({ accent: "a" }, { a: "b", b: "#123456" });
    assert.equal(resolved.accent, "#123456");
  });

  it("leaves unknown references untouched", () => {
    const resolved = resolveVarRefs({ accent: "missing" }, { primary: "#fff" });
    assert.equal(resolved.accent, "missing");
  });

  it("terminates on cyclic var references", () => {
    const resolved = resolveVarRefs({ accent: "a" }, { a: "b", b: "a" });
    assert.equal(resolved.accent, "a");
  });
});

describe("discoverThemes", () => {
  it("discovers themes from agent and project dirs, dedupes, and skips invalid files", () => {
    const dir = makeTmpDir();
    try {
      const agentThemes = join(dir, "agent", "themes");
      const projectThemes = join(dir, "project", ".pi", "themes");
      mkdirSync(agentThemes, { recursive: true });
      mkdirSync(projectThemes, { recursive: true });

      writeFileSync(
        join(agentThemes, "alpha.json"),
        JSON.stringify({ name: "alpha", colors: { accent: "#fff" } }),
      );
      writeFileSync(
        join(agentThemes, "beta.json"),
        JSON.stringify({ name: "beta", colors: { accent: "#fff" } }),
      );
      // Duplicate name — should be skipped in favor of the agent-dir one.
      writeFileSync(
        join(projectThemes, "alpha.json"),
        JSON.stringify({ name: "alpha", colors: { accent: "#000" } }),
      );
      // Invalid: missing name.
      writeFileSync(
        join(agentThemes, "broken.json"),
        JSON.stringify({ colors: {} }),
      );
      // Invalid: not JSON.
      writeFileSync(join(agentThemes, "junk.json"), "not json{");

      const themes = discoverThemes({
        agentDir: join(dir, "agent"),
        packageDir: join(dir, "pkg"),
        cwd: join(dir, "project"),
        projectTrusted: true,
        configDirName: "pi",
      });

      const names = themes.map((t) => t.name);
      assert.deepEqual(names, ["alpha", "beta"]);
      // First definition wins.
      assert.equal(
        JSON.parse(
          JSON.stringify(themes.find((t) => t.name === "alpha")?.json.colors),
        ).accent,
        "#fff",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits project themes when the project is not trusted", () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "project", ".pi", "themes"), { recursive: true });
      writeFileSync(
        join(dir, "project", ".pi", "themes", "proj.json"),
        JSON.stringify({ name: "proj", colors: { accent: "#fff" } }),
      );
      const themes = discoverThemes({
        agentDir: join(dir, "agent"),
        packageDir: join(dir, "pkg"),
        cwd: join(dir, "project"),
        projectTrusted: false,
        configDirName: "pi",
      });
      assert.deepEqual(
        themes.map((t) => t.name),
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads built-in themes when the package ships them", () => {
    const dir = makeTmpDir();
    try {
      const pkgThemes = join(
        dir,
        "pkg",
        "dist",
        "modes",
        "interactive",
        "theme",
      );
      mkdirSync(pkgThemes, { recursive: true });
      writeFileSync(
        join(pkgThemes, "dark.json"),
        JSON.stringify({ name: "dark", colors: { accent: "#fff" } }),
      );
      writeFileSync(
        join(pkgThemes, "light.json"),
        JSON.stringify({ name: "light", colors: { accent: "#000" } }),
      );
      const themes = discoverThemes({
        agentDir: join(dir, "agent"),
        packageDir: join(dir, "pkg"),
        cwd: dir,
        projectTrusted: false,
        configDirName: "pi",
      });
      assert.deepEqual(
        themes.map((t) => t.name),
        ["dark", "light"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getCurrentThemeName", () => {
  it("reads a plain theme setting", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ theme: "noctalia" }),
      );
      assert.equal(getCurrentThemeName(dir), "noctalia");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves an auto light/dark setting to the dark theme", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ theme: "paper/dark" }),
      );
      assert.equal(getCurrentThemeName(dir), "dark");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when no theme is configured", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: 42 }));
      assert.equal(getCurrentThemeName(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when settings.json is missing", () => {
    const dir = makeTmpDir();
    assert.equal(getCurrentThemeName(dir), undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildPreviewTheme", () => {
  it("builds a Theme with fg/bg ANSI helpers", () => {
    const theme = buildPreviewTheme(MINIMAL_THEME);
    assert.equal(theme.name, "test-theme");
    assert.match(theme.fg("accent", "x"), /\u001b\[/);
    assert.match(theme.bg("userMessageBg", "x"), /\u001b\[/);
    assert.match(theme.fg("accent", "x"), /#ffb597|48;|38;/);
  });
});
