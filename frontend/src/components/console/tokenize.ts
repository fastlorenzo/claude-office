/**
 * Tiny line tokenizers for console payloads (spec 2.2 "payload rendering"):
 * generic code (keywords / strings / numbers / comments per language family),
 * shell commands and JSON. No grammar, no cross-line state: good enough for
 * previews and diffs, and a few hundred bytes instead of a highlighter dep.
 */

export type TokenType =
  | "plain"
  | "kw"
  | "str"
  | "num"
  | "com"
  | "fn"
  | "type"
  | "key"
  | "flag"
  | "op"
  | "var"
  | "punct";

export interface Token {
  t: TokenType;
  v: string;
}

/** Tailwind colour per token type (dark theme). */
export const TOKEN_CLASS: Record<TokenType, string> = {
  plain: "text-slate-200",
  kw: "text-violet-300",
  str: "text-emerald-300",
  num: "text-amber-300",
  com: "text-slate-500 italic",
  fn: "text-sky-300",
  type: "text-cyan-300",
  key: "text-sky-300",
  flag: "text-amber-200",
  op: "text-pink-300",
  var: "text-orange-300",
  punct: "text-slate-400",
};

export type Lang =
  | "ts"
  | "py"
  | "json"
  | "sh"
  | "css"
  | "rs"
  | "go"
  | "yaml"
  | "md"
  | "html"
  | "sql"
  | "text";

const EXT: Record<string, Lang> = {
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  mts: "ts",
  py: "py",
  pyi: "py",
  json: "json",
  jsonc: "json",
  jsonl: "json",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  css: "css",
  scss: "css",
  rs: "rs",
  go: "go",
  yaml: "yaml",
  yml: "yaml",
  toml: "yaml",
  md: "md",
  mdx: "md",
  html: "html",
  xml: "html",
  svg: "html",
  sql: "sql",
};

/** Language label from a file path's extension. */
export function langFromPath(path: string | null | undefined): Lang {
  if (!path) return "text";
  const base = path.split(/[\\/]/).pop() ?? "";
  if (base === "Makefile" || base === "Dockerfile") return "sh";
  const i = base.lastIndexOf(".");
  return i < 0 ? "text" : (EXT[base.slice(i + 1).toLowerCase()] ?? "text");
}

const TS_KW =
  "const let var function return if else for while do switch case break continue new class extends implements interface type enum import export from as default async await yield try catch finally throw typeof instanceof in of void delete this super null undefined true false readonly public private protected static keyof satisfies declare";
const PY_KW =
  "def class return if elif else for while in not and or is import from as with try except finally raise lambda yield async await pass break continue global nonlocal None True False self assert del";
const RS_KW =
  "fn let mut pub struct enum impl trait use mod crate self Self match if else for while loop return break continue as ref move where type const static async await dyn true false Some None Ok Err";
const GO_KW =
  "func package import var const type struct interface map chan go defer return if else for range switch case default break continue select nil true false";
const SQL_KW =
  "select from where and or not insert into values update set delete create table index join left right inner outer on group by order having limit as null is in distinct";
const SH_KW =
  "if then else elif fi for in do done while until case esac function return export local";

const KW: Partial<Record<Lang, Set<string>>> = {
  ts: new Set(TS_KW.split(" ")),
  py: new Set(PY_KW.split(" ")),
  rs: new Set(RS_KW.split(" ")),
  go: new Set(GO_KW.split(" ")),
  sql: new Set(SQL_KW.split(" ")),
  sh: new Set(SH_KW.split(" ")),
  json: new Set(["true", "false", "null"]),
  yaml: new Set(["true", "false", "null", "yes", "no"]),
};

const HASH_COMMENT = new Set<Lang>(["py", "sh", "yaml"]);
const SLASH_COMMENT = new Set<Lang>(["ts", "rs", "go", "css"]);

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

function pushTok(out: Token[], t: TokenType, v: string): void {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === t) last.v += v;
  else out.push({ t, v });
}

function readString(line: string, i: number): number {
  const q = line[i];
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === "\\") j += 2;
    else if (line[j] === q) return j + 1;
    else j++;
  }
  return line.length;
}

/** Tokenize one line of source in `lang`. */
export function tokenizeLine(line: string, lang: Lang): Token[] {
  const out: Token[] = [];
  if (lang === "text" || line.length > 2000) {
    pushTok(out, "plain", line);
    return out;
  }
  if (lang === "md") return tokenizeMarkdown(line);
  const kws = KW[lang];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const rest2 = line.slice(i, i + 2);
    if (
      (HASH_COMMENT.has(lang) && c === "#") ||
      (SLASH_COMMENT.has(lang) && rest2 === "//") ||
      (lang === "sql" && rest2 === "--")
    ) {
      pushTok(out, "com", line.slice(i));
      break;
    }
    if (rest2 === "/*" && SLASH_COMMENT.has(lang)) {
      const end = line.indexOf("*/", i + 2);
      const j = end < 0 ? line.length : end + 2;
      pushTok(out, "com", line.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const j = readString(line, i);
      const s = line.slice(i, j);
      // JSON / YAML keys: a string followed by a colon.
      const isKey =
        (lang === "json" || lang === "yaml") && /^\s*:/.test(line.slice(j));
      pushTok(out, isKey ? "key" : "str", s);
      i = j;
      continue;
    }
    if (/\d/.test(c) && (i === 0 || !/[\w$]/.test(line[i - 1]))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(line);
      if (m) {
        pushTok(out, "num", m[0]);
        i += m[0].length;
        continue;
      }
    }
    IDENT.lastIndex = i;
    const id = IDENT.exec(line);
    if (id) {
      const w = id[0];
      const next = line.slice(i + w.length).match(/^\s*(.)/)?.[1];
      let t: TokenType = "plain";
      if (kws?.has(lang === "sql" ? w.toLowerCase() : w)) t = "kw";
      else if (
        lang === "yaml" &&
        next === ":" &&
        /^\s*$/.test(line.slice(0, i).replace(/-/g, ""))
      )
        t = "key";
      else if (lang === "css" && next === ":") t = "key";
      else if (next === "(") t = "fn";
      else if (/^[A-Z]/.test(w) && lang !== "sql") t = "type";
      pushTok(out, t, w);
      i += w.length;
      continue;
    }
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < line.length && /\s/.test(line[j])) j++;
      pushTok(out, "plain", line.slice(i, j));
      i = j;
      continue;
    }
    pushTok(out, /[=<>!+\-*/%&|^~?]/.test(c) ? "op" : "punct", c);
    i++;
  }
  return out;
}

function tokenizeMarkdown(line: string): Token[] {
  if (/^\s*#{1,6}\s/.test(line)) return [{ t: "kw", v: line }];
  if (/^\s*```/.test(line)) return [{ t: "com", v: line }];
  const out: Token[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    pushTok(out, "plain", line.slice(last, m.index));
    pushTok(out, m[1] ? "str" : "type", m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  pushTok(out, "plain", line.slice(last));
  return out;
}

const SH_OPS = new Set([
  "|",
  "||",
  "&&",
  ";",
  ">",
  ">>",
  "<",
  "2>",
  "&>",
  "2>&1",
  "&",
]);

/** Tokenize a shell command line: command names, flags, strings, vars, operators. */
export function tokenizeShell(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let expectCmd = true;
  while (i < line.length) {
    const c = line[i];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < line.length && /\s/.test(line[j])) j++;
      pushTok(out, "plain", line.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      pushTok(out, "com", line.slice(i));
      break;
    }
    if (c === '"' || c === "'") {
      const j = readString(line, i);
      pushTok(out, "str", line.slice(i, j));
      i = j;
      expectCmd = false;
      continue;
    }
    const op = [
      "2>&1",
      "&&",
      "||",
      ">>",
      "&>",
      "2>",
      "|",
      ";",
      ">",
      "<",
      "&",
    ].find((o) => line.startsWith(o, i));
    if (op && SH_OPS.has(op)) {
      pushTok(out, "op", op);
      i += op.length;
      expectCmd =
        op === "|" || op === "||" || op === "&&" || op === ";" || op === "&";
      continue;
    }
    let j = i;
    while (j < line.length && !/[\s|;&<>"']/.test(line[j])) j++;
    if (j === i) j = i + 1;
    const w = line.slice(i, j);
    let t: TokenType = "plain";
    if (w.startsWith("$")) t = "var";
    else if (expectCmd && /^[A-Za-z_][\w.-]*=/.test(w)) t = "var";
    else if (expectCmd) {
      t = KW.sh?.has(w) ? "kw" : "fn";
      expectCmd = KW.sh?.has(w) ?? false;
    } else if (w.startsWith("-")) t = "flag";
    else if (/^\d+$/.test(w)) t = "num";
    pushTok(out, t, w);
    i = j;
  }
  return out;
}
