// Calculator for the search window: a tokenizer and a recursive-descent parser (no eval).
// + - * / ^ %, parentheses, unary minus, decimals with "." or ",", pi / e,
// sqrt sin cos tan log ln abs round, implicit multiplication before "(" / names ("2pi", "3(1+2)").
// A trailing % is a percentage: "200 + 10%" = 220, "15%" = 0.15; between operands it is modulo.

import { language } from "../i18n";

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "lp" } | { t: "rp" } | { t: "id"; v: string };

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log10,
  ln: Math.log,
  abs: Math.abs,
  round: Math.round,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const OP_ALIAS: Record<string, string> = { "×": "*", "·": "*", "÷": "/", "−": "-" };

export function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(?:\d+(?:[.,]\d+)?|[.,]\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0].replace(",", ".")) });
      i += num[0].length;
      continue;
    }
    if ("+-*/^%".includes(ch) || OP_ALIAS[ch]) {
      if (ch === "*" && src[i + 1] === "*") {
        out.push({ t: "op", v: "^" });
        i += 2;
        continue;
      }
      out.push({ t: "op", v: OP_ALIAS[ch] ?? ch });
      i++;
      continue;
    }
    if (ch === "(") {
      out.push({ t: "lp" });
      i++;
      continue;
    }
    if (ch === ")") {
      out.push({ t: "rp" });
      i++;
      continue;
    }
    if (ch === "π") {
      out.push({ t: "id", v: "pi" });
      i++;
      continue;
    }
    if (ch === "√") {
      out.push({ t: "id", v: "sqrt" });
      i++;
      continue;
    }
    const id = /^[a-z]+/i.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    return null;
  }
  return out;
}

type Val = { v: number; pct: boolean };

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  parse(): number | null {
    if (!this.toks.length) return null;
    const r = this.expr();
    if (!r || this.i !== this.toks.length) return null;
    return r.v;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  private isOp(v: string, tok = this.peek()) {
    return tok?.t === "op" && tok.v === v;
  }

  /** The token can start an operand (so a % before it is modulo, not a percentage). */
  private startsOperand(tok: Tok | undefined) {
    return !!tok && (tok.t === "num" || tok.t === "id" || tok.t === "lp");
  }

  private expr(): Val | null {
    let left = this.term();
    while (left && (this.isOp("+") || this.isOp("-"))) {
      const sign = this.isOp("+") ? 1 : -1;
      this.i++;
      const right = this.term();
      if (!right) return null;
      left = { v: right.pct ? left.v + sign * left.v * right.v : left.v + sign * right.v, pct: false };
    }
    return left;
  }

  private term(): Val | null {
    let left = this.unary();
    while (left) {
      const tok = this.peek();
      if (this.isOp("*") || this.isOp("/") || (this.isOp("%") && this.startsOperand(this.toks[this.i + 1]))) {
        const op = (tok as { v: string }).v;
        this.i++;
        const right = this.unary();
        if (!right) return null;
        left = { v: op === "*" ? left.v * right.v : op === "/" ? left.v / right.v : left.v % right.v, pct: false };
      } else if (tok && (tok.t === "lp" || tok.t === "id")) {
        const right = this.unary();
        if (!right) return null;
        left = { v: left.v * right.v, pct: false };
      } else break;
    }
    return left;
  }

  private unary(): Val | null {
    if (this.isOp("-") || this.isOp("+")) {
      const neg = this.isOp("-");
      this.i++;
      const r = this.unary();
      return r && { v: neg ? -r.v : r.v, pct: r.pct };
    }
    return this.power();
  }

  private power(): Val | null {
    const base = this.postfix();
    if (!base || !this.isOp("^")) return base;
    this.i++;
    const exp = this.unary();
    return exp && { v: Math.pow(base.v, exp.v), pct: false };
  }

  private postfix(): Val | null {
    let r = this.primary();
    while (r && this.isOp("%") && !this.startsOperand(this.toks[this.i + 1])) {
      this.i++;
      r = { v: r.v / 100, pct: true };
    }
    return r;
  }

  private primary(): Val | null {
    const tok = this.peek();
    if (!tok) return null;
    if (tok.t === "num") {
      this.i++;
      return { v: tok.v, pct: false };
    }
    if (tok.t === "lp") {
      this.i++;
      const r = this.expr();
      if (!r || this.peek()?.t !== "rp") return null;
      this.i++;
      return { v: r.v, pct: false };
    }
    if (tok.t === "id") {
      this.i++;
      if (tok.v in CONSTS) return { v: CONSTS[tok.v], pct: false };
      const f = FUNCS[tok.v];
      if (!f) return null;
      const arg = this.peek()?.t === "lp" ? this.primary() : this.unary();
      return arg && { v: f(arg.v), pct: false };
    }
    return null;
  }
}

export function evaluate(src: string): number | null {
  const toks = tokenize(src);
  if (!toks) return null;
  const v = new Parser(toks).parse();
  return v === null || !Number.isFinite(v) ? null : v;
}

/** 12 significant digits (no float noise like 0.30000000000000004), decimal comma on request. */
export function formatNumber(v: number, decimalComma = false): string {
  const n = Object.is(v, -0) ? 0 : Number(v.toPrecision(12));
  const s = String(n);
  return decimalComma ? s.replace(".", ",") : s;
}

/**
 * The calculator row for a search query, or null when the query is not a calculation: it needs a
 * digit and an operator or a name ("2+2", "sqrt 2", "15%"), and a bare signed number does not count.
 */
export function calculate(query: string): { value: number; text: string } | null {
  const q = query.trim().replace(/^=/, "");
  const toks = tokenize(q);
  if (!toks || !/\d/.test(q)) return null;
  const meaningful = toks.some((t) => t.t === "id" || (t.t === "op" && t.v !== "-" && t.v !== "+")) || toks.filter((t) => t.t === "op").length > (toks[0]?.t === "op" ? 1 : 0);
  if (!meaningful) return null;
  const value = evaluate(q);
  if (value === null) return null;
  // English always answers with a point; Turkish echoes a decimal comma when the query used one
  return { value, text: formatNumber(value, language() === "tr" && /\d,\d/.test(q) && !/\d\.\d/.test(q)) };
}
