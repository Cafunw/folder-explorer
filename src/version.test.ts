import { describe, expect, it } from "vitest";
import { parseBuild, versionText } from "./version";

describe("build info", () => {
  it("knows a released build", () => {
    const b = parseBuild("0.3.0", "v0.3.0-0-gcb2321b\n");
    expect(b).toEqual({ version: "0.3.0", commit: "cb2321b", ahead: 0, released: true });
    expect(versionText(b)).toBe("0.3.0");
  });

  it("counts commits after the release", () => {
    const b = parseBuild("0.3.0", "v0.3.0-5-g7c22a4f");
    expect(b.released).toBe(false);
    expect(versionText(b)).toBe("0.3.0+5");
  });

  it("a changed working tree is never the release", () => {
    expect(parseBuild("0.3.0", "v0.3.0-0-gcb2321b-dirty")).toMatchObject({ commit: "cb2321b-dirty", released: false });
  });

  it("a bumped version before its tag drops the old tag's count", () => {
    const b = parseBuild("0.3.1", "v0.3.0-6-gabc1234");
    expect(b).toMatchObject({ ahead: null, released: false });
    expect(versionText(b)).toBe("0.3.1");
  });

  it("works without tags or git", () => {
    expect(parseBuild("0.3.0", "7c22a4f-dirty")).toMatchObject({ commit: "7c22a4f-dirty", ahead: null, released: false });
    expect(parseBuild("0.3.0", "")).toMatchObject({ commit: "", released: false });
  });
});
