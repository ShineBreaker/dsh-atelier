// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 手搓 TOML 子集解析器 — 替代 pi 侧 `import { TOML } from "bun"`。
 *
 * 支持子集（覆盖 context/harnesses.toml 实际用到的全部语法）：
 *   - 点号分段表名： [harness.pi] / [harness.claude]
 *   - 键值对：basic string "..."、literal string '...'、整数/浮点、true/false
 *   - 单行数组：["a", "b"]（元素为字符串/数字/布尔，可跨行？不支持跨行）
 *   - 注释：行内 #（字符串内 # 不算注释）、整行注释
 *   - 裸键与引号键
 *
 * 不支持（遇到显式报错，不静默跳过）：跨行数组、表数组 [[x]]、内联表 {a=1}、
 * 多行字符串 """..."""、日期时间。
 */

function parseString(raw, line) {
  const q = raw[0];
  if (q !== '"' && q !== "'") throw new Error(`line ${line}: expected quoted string, got: ${raw.slice(0, 20)}`);
  // 找未转义的收尾引号
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === q && raw[i - 1] !== "\\") {
      const inner = raw.slice(1, i);
      if (q === '"') {
        // 处理常见转义
        return [inner.replace(/\\(["\\nrt])/g, (_m, c) =>
          c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c), i + 1];
      }
      return [inner, i + 1];
    }
  }
  throw new Error(`line ${line}: unterminated string`);
}

function parseScalar(raw, line) {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[+-]?\d*\.\d+$/.test(t)) return parseFloat(t);
  if (t.startsWith('"') || t.startsWith("'")) {
    const [s] = parseString(t, line);
    return s;
  }
  throw new Error(`line ${line}: unsupported value: ${t.slice(0, 30)}`);
}

/** 剥离行内注释：字符串外的 # 起注释 */
function stripComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === inStr && line[i - 1] !== "\\") inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseArray(raw, line) {
  // raw 以 "[" 开头；找匹配的 "]"（考虑字符串内括号）
  let depth = 0, inStr = null, end = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === inStr && raw[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error(`line ${line}: unterminated array`);
  const inner = raw.slice(1, end).trim();
  if (!inner) return [];
  // 按顶层逗号切分
  const parts = [];
  let cur = "", d = 0, s = null;
  for (const c of inner) {
    if (s) { if (c === s && cur[cur.length - 1] !== "\\") s = null; cur += c; continue; }
    if (c === '"' || c === "'") { s = c; cur += c; continue; }
    if (c === "[") d++;
    if (c === "]") d--;
    if (c === "," && d === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => parseScalar(p, line));
}

/**
 * 解析 TOML 文本为嵌套对象。点号表名展开为嵌套表。
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseToml(text) {
  const root = {};
  let table = root; // 当前 [table] 的落点
  const lines = text.split("\n");

  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    const line = stripComment(lines[n]).trim();
    if (!line) continue;

    if (line.startsWith("[[")) {
      throw new Error(`line ${lineNo}: array-of-tables [[..]] not supported`);
    }
    if (line.startsWith("[")) {
      const close = line.indexOf("]");
      if (close < 0) throw new Error(`line ${lineNo}: malformed table header`);
      const segs = line.slice(1, close).split(".").map((s) => {
        const t = s.trim();
        // 引号键
        if (t.startsWith('"') || t.startsWith("'")) return t.slice(1, -1);
        return t;
      }).filter(Boolean);
      if (segs.length === 0) throw new Error(`line ${lineNo}: empty table name`);
      table = root;
      for (const seg of segs) {
        if (table[seg] === undefined) table[seg] = {};
        if (typeof table[seg] !== "object" || table[seg] === null || Array.isArray(table[seg])) {
          throw new Error(`line ${lineNo}: table "${segs.join(".")}" conflicts with a scalar`);
        }
        table = table[seg];
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) throw new Error(`line ${lineNo}: expected key = value`);
    const keyRaw = line.slice(0, eq).trim();
    const key = keyRaw.startsWith('"') || keyRaw.startsWith("'") ? keyRaw.slice(1, -1) : keyRaw;
    if (!key) throw new Error(`line ${lineNo}: empty key`);
    const rawVal = line.slice(eq + 1).trim();
    if (!rawVal) throw new Error(`line ${lineNo}: missing value for "${key}"`);
    if (rawVal.startsWith("[")) {
      table[key] = parseArray(rawVal, lineNo);
    } else if (rawVal.startsWith("{")) {
      throw new Error(`line ${lineNo}: inline tables not supported`);
    } else if (rawVal.startsWith('"""') || rawVal.startsWith("'''")) {
      throw new Error(`line ${lineNo}: multiline strings not supported`);
    } else {
      table[key] = parseScalar(rawVal, lineNo);
    }
  }
  return root;
}
