// Runs as npm's "version" hook: tauri.conf.json reads package.json itself, but the Rust crate keeps its own copy.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const crateVersion = /(name = "folder-explorer"\r?\nversion = ")[^"]*/;

for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
  const text = readFileSync(file, "utf8");
  if (!crateVersion.test(text)) throw new Error(`${file}: folder-explorer version line not found`);
  writeFileSync(file, text.replace(crateVersion, `$1${version}`));
}
