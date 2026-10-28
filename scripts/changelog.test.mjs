import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { release, releaseNotes, section, updateManifest } from "./changelog.mjs";

const SAMPLE = `# Changelog

Intro.

## [Unreleased]

### Fixed

- A fix.

## [0.3.0] - 2026-10-28

### Added

- A feature.

[Unreleased]: https://github.com/o/r/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/o/r/compare/v0.2.0...v0.3.0
`;

describe("changelog", () => {
  it("moves [Unreleased] into the new version and updates the links", () => {
    const out = release(SAMPLE, "0.3.1", "2026-11-02");
    expect(out).toContain("## [Unreleased]\n\n## [0.3.1] - 2026-11-02\n\n### Fixed\n\n- A fix.\n\n## [0.3.0]");
    expect(out).toContain("[Unreleased]: https://github.com/o/r/compare/v0.3.1...HEAD\n[0.3.1]: https://github.com/o/r/compare/v0.3.0...v0.3.1\n");
    expect(section(out, "0.3.1")).toBe("### Fixed\n\n- A fix.");
  });

  it("refuses an empty or repeated release", () => {
    const done = release(SAMPLE, "0.3.1", "2026-11-02");
    expect(() => release(done, "0.3.2", "2026-11-03")).toThrow(/nothing under \[Unreleased\]/);
    expect(() => release(SAMPLE, "0.3.0", "2026-11-03")).toThrow(/already has a section/);
  });

  it("builds release notes from a section", () => {
    const notes = releaseNotes(SAMPLE.replace(/\n/g, "\r\n"), "0.3.0", "abc123");
    expect(notes).toContain("Folder.Explorer_0.3.0_x64-setup.exe");
    expect(notes).toContain("## Changes\n\n### Added\n\n- A feature.\n");
    expect(notes).toContain("`abc123`");
  });

  it("builds the updater's latest.json", () => {
    const json = JSON.parse(updateManifest(SAMPLE, "0.3.0", "https://example.com/setup.exe", "c2ln\r\n", "2026-10-28T12:00:00.000Z"));
    expect(json).toEqual({
      version: "0.3.0",
      notes: "### Added\n\n- A feature.",
      pub_date: "2026-10-28T12:00:00.000Z",
      platforms: { "windows-x86_64": { signature: "c2ln", url: "https://example.com/setup.exe" } },
    });
  });

  // the version lives in package.json; the crate, the lock file and the changelog follow it
  it("the repository's versions agree", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    const crate = (file) => /name = "folder-explorer"\r?\nversion = "([^"]+)"/.exec(readFileSync(file, "utf8"))?.[1];
    expect(crate("src-tauri/Cargo.toml")).toBe(version);
    expect(crate("src-tauri/Cargo.lock")).toBe(version);
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    expect(section(changelog, version)).not.toBe("");
    expect(changelog).toMatch(new RegExp(`^\\[Unreleased\\]: \\S+/compare/v${version.replace(/\./g, "\\.")}\\.\\.\\.HEAD\\r?$`, "m"));
  });
});
