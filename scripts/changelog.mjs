// CHANGELOG.md (Keep a Changelog) helpers for releasing.
//   node scripts/changelog.mjs release <version> [YYYY-MM-DD]   move [Unreleased] into a new version section
//   node scripts/changelog.mjs notes <version> <installer sha256> print the GitHub release notes
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FILE = "CHANGELOG.md";
const lf = (t) => t.replace(/\r\n/g, "\n");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The changelog with [Unreleased]'s entries under `## [version] - date`, and the compare links updated. */
export function release(text, version, date) {
  text = lf(text);
  if (text.includes(`## [${version}]`)) throw new Error(`${FILE} already has a section for ${version}`);
  const head = /^## \[Unreleased\]\n([\s\S]*?)(?=^## \[|^\[Unreleased\]:)/m.exec(text);
  if (!head) throw new Error(`${FILE}: no "## [Unreleased]" section`);
  if (!head[1].trim()) throw new Error(`${FILE}: nothing under [Unreleased] to release`);
  const link = /^\[Unreleased\]: (\S+)\/compare\/v(\S+)\.\.\.HEAD$/m.exec(text);
  if (!link) throw new Error(`${FILE}: no "[Unreleased]: …/compare/vX...HEAD" link`);
  const [, repo, prev] = link;
  return text
    .replace(head[0], `## [Unreleased]\n\n## [${version}] - ${date}\n${head[1]}`)
    .replace(link[0], `[Unreleased]: ${repo}/compare/v${version}...HEAD\n[${version}]: ${repo}/compare/v${prev}...v${version}`);
}

/** The entries of `version`'s section, without its heading. */
export function section(text, version) {
  const m = new RegExp(`^## \\[${escape(version)}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]: )`, "m").exec(lf(text));
  if (!m || !m[1].trim()) throw new Error(`${FILE}: no entries for ${version}`);
  return m[1].trim();
}

/** GitHub release notes: how to install, the version's changelog entries and the installer's checksum. */
export function releaseNotes(text, version, sha256) {
  return `Phone-style folders for your Windows 11 desktop: drop one icon on another to make a group. Groups are virtual, so your files never move, and Windows' own desktop comes back as soon as you quit.

## Install

1. Download **Folder.Explorer_${version}_x64-setup.exe** below and run it. It installs for your user only, no administrator rights needed.
2. The installer isn't code-signed yet, so Windows may show *"Windows protected your PC"*: click **More info → Run anyway**.

Requires Windows 11 (x64). Upgrading: install over the old version; your layout and settings stay.

## Changes

${section(text, version)}

SHA-256 of the installer: \`${sha256}\`
`;
}

const today = () => new Date().toISOString().slice(0, 10);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, version, extra] = process.argv.slice(2);
  if (cmd === "release" && version) {
    writeFileSync(FILE, release(readFileSync(FILE, "utf8"), version, extra ?? today()));
  } else if (cmd === "notes" && version && extra) {
    process.stdout.write(releaseNotes(readFileSync(FILE, "utf8"), version, extra));
  } else {
    console.error("usage: changelog.mjs release <version> [date] | notes <version> <sha256>");
    process.exit(1);
  }
}
