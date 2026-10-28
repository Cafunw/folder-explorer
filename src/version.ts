// Where a build sits relative to the release tags, from `git describe` at build time (vite.config.ts).

export type BuildInfo = {
  version: string;
  /** short commit, with "-dirty" when the working tree had changes; "" outside a git checkout */
  commit: string;
  /** commits after the release tag of this version; null when that tag isn't known */
  ahead: number | null;
  /** built exactly from the tag `v<version>` with a clean tree: the released build */
  released: boolean;
};

/** `describe` is `git describe --tags --long --dirty --always --match "v[0-9]*"`: "v0.3.0-5-g7c22a4f", "7c22a4f-dirty" or "". */
export function parseBuild(version: string, describe: string): BuildInfo {
  const d = describe.trim();
  const tagged = /^v(.+)-(\d+)-g([0-9a-f]+)(-dirty)?$/.exec(d);
  if (tagged) {
    const [, tag, n, hash, dirty] = tagged;
    // after `npm version` bumped package.json but before its tag exists, the count belongs to the old tag
    const ahead = tag === version ? Number(n) : null;
    return { version, commit: hash + (dirty ?? ""), ahead, released: ahead === 0 && !dirty };
  }
  return { version, commit: /^[0-9a-f]{7,}(-dirty)?$/.test(d) ? d : "", ahead: null, released: false };
}

/** "0.3.0" for a release, "0.3.0+5" for five commits after it. */
export const versionText = (b: BuildInfo) => (b.ahead ? `${b.version}+${b.ahead}` : b.version);
