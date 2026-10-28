// npm's "version" hook (`npm version 0.3.1 -m "Release %s"`), run after package.json is bumped and
// before npm commits and tags: copies the version into the Rust crate (tauri.conf.json reads
// package.json itself), turns CHANGELOG.md's [Unreleased] into the new version, and stages both so
// they land in the release commit.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { release } from "./changelog.mjs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const crateVersion = /(name = "folder-explorer"\r?\nversion = ")[^"]*/;

for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
  const text = readFileSync(file, "utf8");
  if (!crateVersion.test(text)) throw new Error(`${file}: folder-explorer version line not found`);
  writeFileSync(file, text.replace(crateVersion, `$1${version}`));
}
writeFileSync("CHANGELOG.md", release(readFileSync("CHANGELOG.md", "utf8"), version, new Date().toISOString().slice(0, 10)));

try {
  execSync("git add src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md", { stdio: "ignore" });
} catch {
  // not a git checkout, or `--no-git-tag-version`: nothing to stage
}
