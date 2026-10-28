import { afterAll, expect, it } from "vitest";
import { en } from "./i18n.en";
import { setLanguage, t, type Dict } from "./i18n";

setLanguage("tr");
const tr: Dict = t;
afterAll(() => setLanguage("en"));

// the same in both languages on purpose: names, symbols, key names
const SAME = new Set([
  "appName",
  "cm.hintRename",
  "cm.hintOpen",
  "groupWeb",
  "styleIos",
  "styleAndroid",
  "wpWindows",
  "themeNeon",
  "themeMinimal",
  "themeMac",
  "grp.displays.panel",
  "grp.types.video",
  "grp.extPlaceholder",
  "grp.useHello",
]);
// functions whose arguments are text; every other one gets numbers (and a boolean second)
const TEXT_ARGS = new Set(["openWithApp", "webSearch", "ql.fileOfType", "grp.helloMessage"]);
const samples = (path: string): unknown[][] =>
  TEXT_ARGS.has(path) ? [["pdf"], [""]] : [[0, false], [1, true], [2, false], [12, true]];

type Leaf = { path: string; en: string; tr: string };
function leaves(a: unknown, b: unknown, path: string, out: Leaf[]): Leaf[] {
  if (typeof a === "function") {
    for (const args of samples(path)) {
      out.push({ path: `${path}(${args.join(", ")})`, en: a(...args), tr: (b as (...x: unknown[]) => string)(...args) });
    }
  } else if (a && typeof a === "object") {
    for (const k of Object.keys(a)) leaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  } else out.push({ path, en: a as string, tr: b as string });
  return out;
}

it("translates every Turkish string into English", () => {
  const all = leaves(en, tr, "", []);
  expect(all.length).toBeGreaterThan(500);
  for (const { path, en: e, tr: s } of all) {
    expect(typeof e === "string" && e.trim().length > 0, `${path} is empty`).toBe(true);
    const base = path.replace(/\(.*\)$/, "");
    if (!SAME.has(base)) expect(e, `${path} is still the Turkish text`).not.toBe(s);
  }
});
