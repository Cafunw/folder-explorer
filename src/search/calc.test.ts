import { describe, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { calculate, evaluate, formatNumber, tokenize } from "./calc";

describe("tokenize", () => {
  it("reads numbers with either decimal mark", () => {
    expect(tokenize("1,5 + .25")).toEqual([
      { t: "num", v: 1.5 },
      { t: "op", v: "+" },
      { t: "num", v: 0.25 },
    ]);
  });
  it("maps × ÷ ** π √", () => {
    expect(tokenize("2×3÷4**2")?.filter((t) => t.t === "op").map((t) => (t as { v: string }).v)).toEqual(["*", "/", "^"]);
    expect(tokenize("π√")).toEqual([
      { t: "id", v: "pi" },
      { t: "id", v: "sqrt" },
    ]);
  });
  it("rejects other characters", () => {
    expect(tokenize("2 & 3")).toBeNull();
  });
});

describe("evaluate", () => {
  it("follows precedence and parentheses", () => {
    expect(evaluate("2+3*4")).toBe(14);
    expect(evaluate("(2+3)*4")).toBe(20);
    expect(evaluate("10/4")).toBe(2.5);
    expect(evaluate("2*(3+(4-1))")).toBe(12);
  });
  it("powers are right-associative and bind tighter than unary minus", () => {
    expect(evaluate("2^3^2")).toBe(512);
    expect(evaluate("-2^2")).toBe(-4);
    expect(evaluate("2^-1")).toBe(0.5);
    expect(evaluate("--3")).toBe(3);
  });
  it("percent and modulo", () => {
    expect(evaluate("15%")).toBeCloseTo(0.15);
    expect(evaluate("200*15%")).toBeCloseTo(30);
    expect(evaluate("200+10%")).toBeCloseTo(220);
    expect(evaluate("200-10%")).toBeCloseTo(180);
    expect(evaluate("10 % 3")).toBe(1);
    expect(evaluate("(200+10%)")).toBeCloseTo(220);
  });
  it("constants, functions and implicit multiplication", () => {
    expect(evaluate("pi")).toBeCloseTo(Math.PI);
    expect(evaluate("2pi")).toBeCloseTo(2 * Math.PI);
    expect(evaluate("3(1+2)")).toBe(9);
    expect(evaluate("sqrt(16)")).toBe(4);
    expect(evaluate("sqrt 16 + 9")).toBe(13);
    expect(evaluate("√2^2")).toBeCloseTo(2);
    expect(evaluate("ln(e)")).toBeCloseTo(1);
    expect(evaluate("log(1000)")).toBeCloseTo(3);
    expect(evaluate("abs(-4.5)")).toBe(4.5);
    expect(evaluate("round(2.5)")).toBe(3);
    expect(evaluate("sin(0)+cos(0)+tan(0)")).toBe(1);
    expect(evaluate("SQRT(9)")).toBe(3);
  });
  it("decimal commas", () => {
    expect(evaluate("1,5*2")).toBe(3);
    expect(evaluate("0,1+0,2")).toBeCloseTo(0.3);
  });
  it("returns null for anything that is not a complete expression", () => {
    for (const s of ["", "abc", "7-zip", "1 2", "(", "2+", "foo(2)", "2)", "1/0", "sqrt(-1)", "1.000,5"]) {
      expect(evaluate(s)).toBeNull();
    }
  });
});

describe("formatNumber", () => {
  it("hides float noise and can use a decimal comma", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(2.25, true)).toBe("2,25");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(1 / 3)).toBe("0.333333333333");
  });
});

describe("calculate", () => {
  it("answers calculations", () => {
    expect(calculate("2+2")).toEqual({ value: 4, text: "4" });
    expect(calculate("= 6/4")?.text).toBe("1.5");
    expect(calculate("1,25+1")?.text).toBe("2.25");
    expect(calculate("sqrt 2")?.value).toBeCloseTo(Math.SQRT2);
    expect(calculate("15%")?.value).toBeCloseTo(0.15);
    expect(calculate("-5+3")?.value).toBe(-2);
  });
  it("keeps a decimal comma the query used, in Turkish only", () => {
    setLanguage("tr");
    try {
      expect(calculate("1,25+1")?.text).toBe("2,25");
      expect(calculate("1.25+1")?.text).toBe("2.25");
      expect(calculate("10/4")?.text).toBe("2.5");
    } finally {
      setLanguage("en");
    }
  });
  it("ignores plain searches and bare numbers", () => {
    for (const s of ["rapor", "e", "pi", "42", "-5", "(5)", "7-zip", "mp3", "windows 11", "2024 rapor", "1/0"]) {
      expect(calculate(s)).toBeNull();
    }
  });
});
