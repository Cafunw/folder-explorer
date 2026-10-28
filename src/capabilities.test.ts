import { expect, it } from "vitest";

// Each window may call only the app commands its capability allows (src-tauri/build.rs makes the
// allow-<command> permissions): a call the view can reach but the capability misses fails at runtime.
const sources = import.meta.glob<string>("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
type Capability = { windows?: string[]; permissions: (string | { identifier: string })[] };
const capabilities = import.meta.glob<Capability>("../src-tauri/capabilities/*.json", { import: "default", eager: true });

// window label → the view main.tsx loads in it
const VIEWS: Record<string, string> = {
  desktop: "./desktop/DesktopView.tsx",
  search: "./search/SearchView.tsx",
  settings: "./settings/SettingsView.tsx",
};

/** `api.<name>` → the command it invokes, read from `api` in api.ts. */
function apiCommands(): Map<string, string> {
  const text = sources["./api.ts"];
  const start = text.indexOf("export const api = {");
  const body = text.slice(start, text.indexOf("\n};", start));
  const map = new Map<string, string>();
  for (const chunk of body.split(/\n {2}(?=\w+:)/).slice(1)) {
    map.set(/^(\w+):/.exec(chunk)![1], /invoke(?:<[\s\S]*?>)?\("(\w+)"/.exec(chunk)?.[1] ?? "");
  }
  expect(map.size).toBe(body.match(/\binvoke\s*[<(]/g)?.length);
  return map;
}

/** Every module statically or dynamically imported from `entry`, not entering `skip`. */
function reachable(entry: string, skip = new Set<string>()): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const key = stack.pop()!;
    if (seen.has(key) || skip.has(key) || !(key in sources)) continue;
    seen.add(key);
    for (const [, spec] of sources[key].matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g)) {
      const base = "." + new URL(spec, `file:///${key.slice(2)}`).pathname;
      stack.push(...[base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].filter((k) => k in sources));
    }
  }
  return seen;
}

it("allows every window the app commands its view can call", () => {
  const commands = apiCommands();
  const shared = reachable("./main.tsx", new Set(Object.values(VIEWS)));
  for (const [label, entry] of Object.entries(VIEWS)) {
    expect(sources[entry], entry).toBeDefined();
    const used = new Set<string>();
    for (const key of new Set([...shared, ...reachable(entry)])) {
      for (const [, name] of sources[key].matchAll(/\bapi\s*\??\.\s*(\w+)/g)) {
        const cmd = commands.get(name);
        if (cmd) used.add(cmd);
      }
    }
    expect(used.size, label).toBeGreaterThan(0);
    const allowed = new Set(
      Object.values(capabilities)
        .filter((c) => c.windows?.includes(label) || c.windows?.includes("*"))
        .flatMap((c) => c.permissions.map((p) => (typeof p === "string" ? p : p.identifier))),
    );
    const missing = [...used].filter((c) => !allowed.has(`allow-${c.replace(/_/g, "-")}`));
    expect(missing, `src-tauri/capabilities: window "${label}" lacks`).toEqual([]);
  }
});
