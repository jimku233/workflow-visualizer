#!/usr/bin/env node
/**
 * flow.mjs — 把业务流程渲染成「Mermaid 源码 + 自包含交互式 HTML 流程图」。
 *
 * 设计约束（重要）：
 *   1. 零依赖：只用 node: 内置模块，不需要 npm install。
 *   2. 纯离线：不引用任何 CDN。布局与渲染都是本文件自己实现的 SVG，
 *      不依赖 mermaid.js —— 所以断网、内网、无外网环境下都能出图。
 *   3. 产物自包含：导出的 .svg 内含 <style>，单独发给别人也能正确显示。
 *
 * 用法：
 *   node flow.mjs render  <spec.json|spec.mmd> [--out x.html] [--svg x.svg] [--mmd x.mmd] [--all]
 *   node flow.mjs mermaid <spec.json> [--out x.mmd]
 *   node flow.mjs check   <spec.json|spec.mmd>
 *   node flow.mjs sample  [--out sample.json]
 *   node flow.mjs help
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, resolve, extname, basename, join } from 'node:path';
import { buildHome } from './serve.mjs';

/** 渲染器版本：写进产物与清单，首页据此标出"旧版渲染"的文件。改了渲染/前端行为就+1。 */
const FLOW_VERSION = '1.2.2';
import { fileURLToPath } from 'node:url';

// ── 前端资源：放在 ../assets/，渲染时内联回产物，保证产物仍是**自包含单文件 HTML** ──
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const assetCache = new Map();
const loadAsset = (name) => {
  if (!assetCache.has(name)) assetCache.set(name, readFileSync(join(ASSET_DIR, name), 'utf8'));
  return assetCache.get(name);
};

/** 同目录流程图清单的文件名：页面里的「全部流程图」抽屉会读它。 */
const FLOW_MANIFEST = '流程索引.json';

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const CHAR_W = 15;          // 一个全角字 = 15px（font-size 15 时）
const LINE_H = 21;          // 正文行高
const NODE_PAD_X = 24;      // 节点左右内边距（单侧）
const V_GAP = 84;           // 层与层之间的垂直间距（含分组标题所需的呼吸感）
const H_GAP = 34;           // 同层节点之间的水平间距
const MAX_W = 420;
const MIN_W = 150;
const WRAP_UNITS = 16;      // 正文折行宽度（全角字数）
const WRAP_UNITS_DECISION = 12;  // 菱形会按文字自动放大，这里给宽一些避免「问题?」这种断行

const KINDS = new Set(['task', 'decision', 'start', 'end', 'risk', 'milestone']);
const STATUSES = new Set(['done', 'doing', 'todo', 'risk', 'hold']);

const STATUS_LABEL = {
  done: '已完成',
  doing: '进行中',
  todo: '待开始',
  risk: '需人工把关',
  hold: '阻塞/等素材',
};

const KIND_LABEL = {
  task: '环节',
  decision: '判断',
  start: '起点',
  end: '终点',
  risk: '风险点',
  milestone: '关键检查点',
};

const GROUP_PALETTE = ['#4aa3ff', '#3fbf7f', '#e0a030', '#c084fc', '#ef6b6b', '#2dd4bf'];

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

const isCJK = (ch) =>
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch);

/** 文本的显示宽度，单位：全角字。 */
function units(s) {
  let u = 0;
  for (const ch of String(s)) u += isCJK(ch) ? 1 : 0.55;
  return u;
}

/** 估算一段文字的实际像素宽度（用于"把药丸+计数整组居中"这类对位计算，全角=字号、半角≈0.56、空格≈0.3）。 */
function textW(s, size) {
  let w = 0;
  for (const ch of String(s)) w += isCJK(ch) ? size : (ch === ' ' ? size * 0.3 : size * 0.56);
  return w;
}

/** 按全角字宽折行；先按显式 \n 分段。 */
function wrapText(text, maxUnits) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    let w = 0;
    for (const ch of para) {
      const cw = isCJK(ch) ? 1 : 0.55;
      if (w + cw > maxUnits && line !== '') { out.push(line); line = ch; w = cw; }
      else { line += ch; w += cw; }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

const clamp = (lo, hi, v) => Math.min(hi, Math.max(lo, v));

function xml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fail(msg) {
  process.stderr.write('flow: ' + msg + '\n');
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────
// 输入解析
// ─────────────────────────────────────────────────────────────

/**
 * 解析 Mermaid 的 flowchart/graph 子集。
 * 支持：flowchart TD|TB|LR、A[文本]、A(文本)、A{判断}、A((圆))、A[[子程序]]、
 *      -->、-.->、==>、---、-->|标签|、链式 A --> B --> C、subgraph ... end、%% 注释。
 */
// 当前 CLI 一次只处理一个输入；保留原文用于 JSON 结构错误的行列定位。
let activeSource = { file: '<输入>', text: '' };

function locAt(text, offset, baseLine = 1, baseCol = 1) {
  let line = baseLine, col = baseCol;
  const end = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, text.length));
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') { line++; col = 1; }
    else col++;
  }
  return { line, col };
}

function failAt(file, line, col, message) {
  fail(`${file || '<输入>'}:${line}:${col}: ${message}`);
}

function sourceFail(message, hint = {}) {
  const src = activeSource || { file: '<输入>', text: '' };
  const text = src.text || '';
  let offset = 0;
  if (hint.offset !== undefined) offset = hint.offset;
  else if (hint.property) {
    const escaped = hint.property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('"' + escaped + '"\\s*:\\s*', 'g');
    let m;
    while ((m = re.exec(text))) {
      const value = hint.value === undefined ? null : JSON.stringify(hint.value);
      if (value === null || text.startsWith(value, re.lastIndex)) { offset = m.index; break; }
    }
  } else if (hint.value !== undefined) {
    const needle = JSON.stringify(hint.value);
    const found = text.indexOf(needle);
    if (found >= 0) offset = found;
  }
  const at = locAt(text, offset, 1, 1);
  failAt(src.file, at.line, at.col, message);
}

function scanStatements(source, file, lineOffset = 0) {
  const statements = [];
  let buffer = '', hasStart = false;
  let line = 1 + lineOffset, col = 1;
  let startLine = line, startCol = col;
  let quote = null, quoteOffset = -1, escaped = false;
  let pipeLabel = false, pipeLabelOffset = -1;
  const stack = [];
  const append = (ch) => {
    if (!hasStart) { hasStart = true; startLine = line; startCol = col; }
    buffer += ch;
  };
  const emit = () => {
    if (buffer.trim()) statements.push({ text: buffer, line: startLine, col: startCol });
    buffer = '';
    hasStart = false;
  };
  const matching = { '(': ')', '[': ']', '{': '}' };
  const isOpen = (ch) => Object.prototype.hasOwnProperty.call(matching, ch);
  const canStartQuote = (i) => {
    let j = i - 1;
    while (j >= 0 && /[ \t\r]/.test(source[j])) j--;
    if (j < 0 || source[j] === '\n' || source[j] === '|' || isOpen(source[j])) return true;
    // subgraph "带空格的标题"：引号前是空白，且本段还没出现节点形状。
    return /[ \t]/.test(source[i - 1] || '') && /(?:^|\s)subgraph\s*$/i.test(buffer.trimEnd());
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (pipeLabel) {
      append(ch);
      if (ch === '|') pipeLabel = false;
      if (ch === '\n') { line++; col = 1; } else col++;
      continue;
    }
    if (!quote && stack.length === 0 && ch === '|' && /(?:-->|-\.->|==>|---|-\.-|--x|--o)\s*$/.test(buffer.trimEnd())) {
      append(ch); pipeLabel = true; pipeLabelOffset = i; col++; continue;
    }
    if (quote) {
      append(ch);
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      if (ch === '\n') { line++; col = 1; } else col++;
      continue;
    }

    if (!quote && stack.length === 0 && buffer.trim() === '' && source.startsWith('%%', i)) {
      const nl = source.indexOf('\n', i);
      if (nl < 0) { emit(); break; }
      emit(); i = nl; line++; col = 1; continue;
    }
    if ((ch === '"' || ch === "'") && canStartQuote(i)) {
      append(ch); quote = ch; quoteOffset = i;
      col++;
      continue;
    }
    if (ch === '\n') {
      if (stack.length === 0) emit();
      else append(ch);
      line++; col = 1;
      continue;
    }
    if (ch === ';' && stack.length === 0) {
      emit(); col++;
      continue;
    }
    append(ch);
    if (isOpen(ch)) stack.push({ close: matching[ch], line, col, offset: i });
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length && stack[stack.length - 1].close === ch) stack.pop();
    }
    col++;
  }

  if (pipeLabel) {
    const at = locAt(source, pipeLabelOffset, 1 + lineOffset, 1);
    failAt(file, at.line, at.col, '未闭合的连线标签');
  }
  if (quote) {
    const at = locAt(source, quoteOffset, 1 + lineOffset, 1);
    failAt(file, at.line, at.col, '未闭合的引号');
  }
  if (stack.length) {
    const open = stack[0];
    failAt(file, open.line, open.col, '未闭合的节点/语法形状括号');
  }
  emit();
  return statements;
}

const NODE_ID_RE = /^[A-Za-z0-9_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*/;
const LINK_TOKENS = ['-.->', '==>', '-->', '---', '-.-', '--x', '--o'];

function offsetLoc(stmt, offset) {
  return locAt(stmt.text, offset, stmt.line, stmt.col);
}

function syntaxFail(file, stmt, offset, message) {
  const actualOffset = offset === 0 ? Math.max(0, stmt.text.search(/\S/)) : offset;
  const at = offsetLoc(stmt, actualOffset);
  failAt(file, at.line, at.col, message);
}

function unquoteLabel(label) {
  const t = String(label).trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1).replace(/\\(["'\\])/g, '$1').replace(/&quot;/g, '"').trim();
  }
  return t.replace(/&quot;/g, '"');
}

function splitLinks(stmt, file) {
  const text = stmt.text;
  const segments = [];
  const links = [];
  const stack = [];
  const matching = { '(': ')', '[': ']', '{': '}' };
  let quote = null, escaped = false, start = 0, pipeLabel = false;
  const canStartQuote = (i) => {
    let j = i - 1;
    while (j >= 0 && /[ \t\r]/.test(text[j])) j--;
    return j < 0 || text[j] === '|' || Object.prototype.hasOwnProperty.call(matching, text[j]) || (/[ \t]/.test(text[i - 1] || '') && /(?:^|\s)subgraph\s*$/i.test(text.slice(0, i).trimEnd()));
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (pipeLabel) { if (ch === '|') pipeLabel = false; continue; }
    if (!quote && stack.length === 0 && ch === '|' && /(?:-->|-\.->|==>|---|-\.-|--x|--o)\s*$/.test(text.slice(0, i).trimEnd())) { pipeLabel = true; continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && canStartQuote(i)) { quote = ch; continue; }
    if (Object.prototype.hasOwnProperty.call(matching, ch)) { stack.push(matching[ch]); continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
      continue;
    }
    if (stack.length) continue;
    const op = LINK_TOKENS.find((token) => text.startsWith(token, i));
    if (op) {
      segments.push({ text: text.slice(start, i), offset: start });
      links.push({ text: op, offset: i });
      i += op.length - 1;
      start = i + 1;
    }
  }
  segments.push({ text: text.slice(start), offset: start });
  if (!links.length) return { segments, links };
  if (segments.length !== links.length + 1) syntaxFail(file, stmt, 0, '不完整的连线语句');
  return { segments, links };
}

function parseNodeExpr(raw, stmt, file, baseOffset) {
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  const offset = baseOffset + lead;
  if (!text) syntaxFail(file, stmt, offset, '缺少节点');
  const idMatch = NODE_ID_RE.exec(text);
  if (!idMatch) syntaxFail(file, stmt, offset, '不支持的语法：节点必须以合法 id 开始');
  const id = idMatch[0];
  let pos = id.length;
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  if (pos === text.length) return { id, label: undefined, kind: undefined };

  const rest = text.slice(pos);
  let open = '', close = '', kind = 'task';
  if (rest.startsWith('[[')) { open = '[['; close = ']]'; }
  else if (rest.startsWith('{{')) { open = '{{'; close = '}}'; }
  else if (rest.startsWith('((')) { open = '(('; close = '))'; kind = 'circle'; }
  else if (rest.startsWith('[')) { open = '['; close = ']'; }
  else if (rest.startsWith('(')) { open = '('; close = ')'; }
  else if (rest.startsWith('{')) { open = '{'; close = '}'; kind = 'decision'; }
  else syntaxFail(file, stmt, offset + pos, '不支持的节点语法（形状后存在多余内容）');

  const closers = { '(': ')', '[': ']', '{': '}' };
  const shapeStack = [...open].map((ch) => closers[ch]).reverse();
  let quote = null, escaped = false, end = -1;
  for (let i = open.length; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    let j = i - 1;
    while (j >= 0 && /[ \t\r]/.test(rest[j])) j--;
    if ((ch === '"' || ch === "'") && (j < 0 || Object.prototype.hasOwnProperty.call(closers, rest[j]) || /\s/.test(rest[i - 1] || ''))) {
      quote = ch; continue;
    }
    if (Object.prototype.hasOwnProperty.call(closers, ch)) { shapeStack.push(closers[ch]); continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (shapeStack.at(-1) !== ch) syntaxFail(file, stmt, offset + pos + i, '节点形状括号不匹配');
      shapeStack.pop();
      if (!shapeStack.length) { end = i; break; }
    }
  }
  if (quote) syntaxFail(file, stmt, offset + pos + rest.length - 1, '未闭合的节点标签引号');
  if (end < 0) syntaxFail(file, stmt, offset + pos, '未闭合的节点形状');
  if (rest.slice(end + 1).trim()) syntaxFail(file, stmt, offset + pos + end + 1, '节点形状后存在多余内容');

  const closeStart = end - close.length + 1;
  let label = rest.slice(open.length, closeStart).trim();
  // Mermaid 的圆括号单层形式按普通环节处理；只有 ((...)) 走圆形节点语义。
  if (open === '(') kind = 'task';
  label = unquoteLabel(label);
  return { id, label, kind };
}

function parseMermaid(text, file = '<输入>', lineOffset = 0) {
  const source = String(text);
  const spec = { title: '', subtitle: '', direction: 'TD', nodes: [], edges: [], groups: [] };
  const nodes = new Map();
  const groupStack = [];

  const touch = (id, label, kind) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, label: id, kind: undefined };
      nodes.set(id, n);
      spec.nodes.push(n);
    }
    if (label !== undefined && label !== '') n.label = label;
    if (kind !== undefined) n.kind = kind;
    return n;
  };
  const addToGroup = (id) => {
    const g = groupStack.at(-1);
    if (g && !g.members.includes(id)) g.members.push(id);
  };
  const statements = scanStatements(source, file, lineOffset);
  const ignoredDirectives = [];

  for (const stmt of statements) {
    const line = stmt.text.trim();
    if (!line || line.startsWith('%%')) continue;
    let m;

    if (/^(?:flowchart|graph)\b/i.test(line)) {
      m = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)?\s*$/i.exec(line);
      if (!m) syntaxFail(file, stmt, 0, '无效的 flowchart/graph 声明；方向应为 TD、TB、BT、LR 或 RL');
      const d = (m[1] || 'TD').toUpperCase();
      spec.direction = d === 'LR' || d === 'RL' ? 'LR' : 'TD';
      continue;
    }
    // 对渲染语义无影响的真实 Mermaid 指令：忽略（并计数提示），不当语法错误。
    // 这样从别处粘来的片段（常带 classDef / style / click）也能直接渲染。
    if (/^(?:classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/i.test(line)) {
      ignoredDirectives.push(line.split(/\s+/)[0].replace(/:$/, ''));
      continue;
    }
    if (/^subgraph\b/i.test(line)) {
      m = /^subgraph\s+(.+?)\s*$/i.exec(line);
      if (!m) syntaxFail(file, stmt, 0, 'subgraph 必须提供分组名称');
      const label = unquoteLabel(m[1]);
      const g = { id: 'g' + (spec.groups.length + 1), label, members: [], _loc: offsetLoc(stmt, stmt.text.search(/subgraph/i)) };
      spec.groups.push(g);
      groupStack.push(g);
      continue;
    }
    if (/^end$/i.test(line)) {                       // 只有**光杆** end 才是分组结束
      if (!groupStack.length) syntaxFail(file, stmt, 0, '存在没有匹配 subgraph 的 end');
      groupStack.pop();
      continue;
    }
    // 注意：`end((终点))` 这种是「节点 id 恰好叫 end」（真实流程里很常见），要继续往下按节点解析

    const { segments, links } = splitLinks(stmt, file);
    if (!segments.length) continue;
    if (segments.length === 1 && !segments[0].text.trim()) syntaxFail(file, stmt, 0, '空语句');

    let previous = null;
    for (let i = 0; i < segments.length; i++) {
      let segment = segments[i];
      let nodeText = segment.text;
      let nodeOffset = segment.offset;
      let edgeLabel;
      const leading = nodeText.length - nodeText.trimStart().length;
      const trimmed = nodeText.trim();
      if (i > 0) {
        const labelMatch = /^\|([^|]*)\|\s*/.exec(trimmed);
        if (labelMatch) {
          edgeLabel = unquoteLabel(labelMatch[1]).replace(/\u2223/g, '|');
          nodeOffset += leading + labelMatch[0].length;
          nodeText = trimmed.slice(labelMatch[0].length);
        }
      } else if (trimmed.startsWith('|')) {
        syntaxFail(file, stmt, segment.offset + leading, '连线标签必须跟在连线操作符后面');
      }
      const node = parseNodeExpr(nodeText, stmt, file, nodeOffset);
      touch(node.id, node.label, node.kind);
      addToGroup(node.id);
      if (previous) {
        const link = links[i - 1];
        if (!link) syntaxFail(file, stmt, segment.offset, '缺少连线操作符');
        spec.edges.push({
          from: previous.id,
          to: node.id,
          label: edgeLabel || undefined,
          style: link.text.includes('.') ? 'dashed' : 'solid',
        });
      }
      previous = node;
    }
  }

  if (groupStack.length) {
    const g = groupStack.at(-1);
    const loc = g._loc || { line: 1 + lineOffset, col: 1 };
    failAt(file, loc.line, loc.col, 'subgraph 未与 end 配对：缺少 end');
  }
  spec.edges = spec.edges || [];
  if (ignoredDirectives.length) {
    spec.ignoredDirectives = [...new Set(ignoredDirectives)];
  }
  return spec;
}
/** 从 .md 中抽出 ```mermaid 代码块；没有就整篇当 mermaid。保留原文行偏移。 */
function extractMermaid(text) {
  const m = /```mermaid[ \t]*\r?\n([\s\S]*?)```/i.exec(text);
  if (!m) return { text, lineOffset: 0 };
  const contentAt = m.index + m[0].indexOf('\n') + 1;
  return { text: m[1], lineOffset: (text.slice(0, contentAt).match(/\n/g) || []).length };
}

function loadSpec(file) {
  if (!existsSync(file)) failAt(file, 1, 1, '输入文件不存在');
  const text = readFileSync(file, 'utf8');
  const ext = extname(file).toLowerCase();
  activeSource = { file, text };
  if (ext === '.json') {
    try {
      return JSON.parse(text);
    } catch (e) {
      let offset;
      const pos = /position\s+(\d+)/i.exec(String(e?.message || ''));
      if (pos) offset = Number(pos[1]);
      const lc = /line\s+(\d+)\s+column\s+(\d+)/i.exec(String(e?.message || ''));
      if (offset === undefined && lc) {
        const lines = text.split(/\n/);
        offset = 0;
        for (let i = 0; i < Number(lc[1]) - 1 && i < lines.length; i++) offset += lines[i].length + 1;
        offset += Math.max(0, Number(lc[2]) - 1);
      }
      const at = locAt(text, offset === undefined ? 0 : offset, 1, 1);
      failAt(file, at.line, at.col, 'JSON 解析失败：' + e.message);
    }
  }
  if (ext === '.md' || ext === '.markdown') {
    const extracted = extractMermaid(text);
    const parsed = parseMermaid(extracted.text, file, extracted.lineOffset);
    activeSource = { file, text };
    noteIgnored(parsed);
    return parsed;
  }
  const parsed = parseMermaid(text, file, 0);
  activeSource = { file, text };
  noteIgnored(parsed);
  return parsed;
}

/** 解析时忽略掉的"无害 Mermaid 指令"提示一句——在 loadSpec 里说，避免被 normalize 重建对象时丢掉。 */
function noteIgnored(spec) {
  if (spec && spec.ignoredDirectives && spec.ignoredDirectives.length) {
    process.stdout.write('  · 已忽略对渲染无影响的 Mermaid 指令：' + spec.ignoredDirectives.join(' / ') + '\n');
  }
}

// ─────────────────────────────────────────────────────────────
// 规格归一化 + 校验
// ─────────────────────────────────────────────────────────────

function normalize(specIn) {
  const src = activeSource || { file: '<输入>', text: '' };
  const bad = (message, hint = {}) => sourceFail(message, hint);
  if (!specIn || typeof specIn !== 'object' || Array.isArray(specIn)) {
    bad('规格根必须是对象', { offset: 0 });
  }

  for (const key of ['nodes', 'edges', 'groups']) {
    if (specIn[key] !== undefined && !Array.isArray(specIn[key])) {
      bad(key + ' 必须是数组', { property: key });
    }
  }
  const rawNodes = specIn.nodes ?? [];
  const rawEdges = specIn.edges ?? [];
  const rawGroups = specIn.groups ?? [];
  const spec = {
    title: specIn.title || '',
    subtitle: specIn.subtitle || '',
    direction: String(specIn.direction || 'TD').toUpperCase() === 'LR' ? 'LR' : 'TD',
    wrap: specIn.wrap === undefined ? 0 : Number(specIn.wrap),
    nodes: [],
    edges: [],
    groups: [],
  };

  const seen = new Set();
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      bad('nodes[' + i + '] 必须是对象', { property: 'nodes' });
    }
    const id = String(raw.id ?? '').trim();
    if (!id) bad('存在没有 id 的节点', { property: 'id', value: raw.id });
    if (seen.has(id)) bad('节点 id 重复：' + id, { property: 'id', value: id });
    seen.add(id);

    let kind = raw.kind == null || raw.kind === '' ? 'task' : String(raw.kind).toLowerCase();
    if (kind === 'subroutine') kind = 'task';
    // circle 是 Mermaid 的内部节点类型，需保留给入/出度推断起点或终点。
    if (!KINDS.has(kind) && kind !== 'circle') bad('未知 kind：' + kind + '（节点 ' + id + '）', { property: 'kind', value: raw.kind });
    const status = raw.status ? String(raw.status).toLowerCase() : undefined;
    if (status && !STATUSES.has(status)) bad('未知 status：' + status + '（节点 ' + id + '）', { property: 'status', value: raw.status });
    spec.nodes.push({
      id,
      label: raw.label !== undefined ? String(raw.label) : id,
      kind,
      status,
      time: raw.time ? String(raw.time) : '',
      owner: raw.owner ? String(raw.owner) : '',
      detail: raw.detail ? String(raw.detail) : '',
      note: raw.note ? String(raw.note) : '',
      color: raw.color ? String(raw.color) : '',
    });
  }

  const ids = new Set(spec.nodes.map((n) => n.id));
  for (let i = 0; i < rawEdges.length; i++) {
    const raw = rawEdges[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('edges[' + i + '] 必须是对象', { property: 'edges' });
    const from = String(raw.from ?? '').trim();
    const to = String(raw.to ?? '').trim();
    if (!ids.has(from)) bad('连线起点不存在：' + from, { property: 'from', value: raw.from });
    if (!ids.has(to)) bad('连线终点不存在：' + to, { property: 'to', value: raw.to });
    spec.edges.push({ from, to, label: raw.label !== undefined ? String(raw.label) : '', style: raw.style === 'dashed' ? 'dashed' : 'solid' });
  }

  const groupIds = new Set();
  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i];
    if (!g || typeof g !== 'object' || Array.isArray(g)) bad('groups[' + i + '] 必须是对象', { property: 'groups' });
    const gid = String(g.id || 'g' + i).trim();
    if (!gid) bad('分组 id 不能为空', { property: 'id', value: g.id });
    if (groupIds.has(gid)) bad('分组 id 重复：' + gid, { property: 'id', value: gid });
    groupIds.add(gid);
    if (g.members !== undefined && !Array.isArray(g.members)) bad('分组 members 必须是数组（分组 ' + gid + '）', { property: 'members', value: g.members });
    const membersIn = g.members ?? [];
    const members = [];
    const memberSet = new Set();
    for (const memberRaw of membersIn) {
      const member = String(memberRaw ?? '').trim();
      if (!ids.has(member)) bad('分组 ' + gid + ' 引用了不存在的节点：' + member, { value: memberRaw });
      if (memberSet.has(member)) bad('分组 ' + gid + ' 中节点重复：' + member, { value: memberRaw });
      memberSet.add(member);
      members.push(member);
    }
    if (members.length) spec.groups.push({ id: gid, label: String(g.label || ''), members });
  }

  // 圆形节点若没有入边 = 起点，没有出边 = 终点。
  const hasIn = new Set(spec.edges.map((e) => e.to));
  const hasOut = new Set(spec.edges.map((e) => e.from));
  for (const n of spec.nodes) {
    if (n.kind === 'start') continue;
    const raw = rawNodes.find((r) => String(r.id) === n.id) || {};
    if (String(raw.kind || '').toLowerCase() === 'circle' && !hasIn.has(n.id)) n.kind = 'start';
    else if (String(raw.kind || '').toLowerCase() === 'circle' && !hasOut.has(n.id)) n.kind = 'end';
  }

  if (!spec.nodes.length) bad('没有任何节点', { property: 'nodes' });
  // normalize 会重建规格对象，解析阶段记下的"已忽略指令"要带过去，否则提示会丢
  if (specIn.ignoredDirectives) spec.ignoredDirectives = specIn.ignoredDirectives;
  return spec;
}
/** 分组标题（药丸 + "N 步"计数）的尺寸。布局阶段算包围盒、SVG 阶段画药丸，必须共用同一套算法。 */
function bandTitleMetrics(label, countText) {
  const labelW = units(label) * 12.4 + 26;
  const countW = textW(countText, 11) + 2;
  return { labelW, countW, gap: 8, totalW: labelW + 8 + countW, minBandW: 26 + labelW + 8 + countW };
}

function analyze(spec) {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const out = new Map(spec.nodes.map((n) => [n.id, []]));
  const inc = new Map(spec.nodes.map((n) => [n.id, []]));
  for (const e of spec.edges) { out.get(e.from).push(e); inc.get(e.to).push(e); }
  const back = new Set();
  const color = new Map();
  const visit = (id) => {
    color.set(id, 1);
    for (const e of out.get(id)) {
      const c = color.get(e.to) || 0;
      if (c === 1) back.add(e);
      else if (c === 0) visit(e.to);
    }
    color.set(id, 2);
  };
  for (const n of spec.nodes) if (!color.get(n.id)) visit(n.id);
  return { byId, out, inc, back };
}

// ─────────────────────────────────────────────────────────────
// 布局（TD 空间计算，LR 最后转置）
// ─────────────────────────────────────────────────────────────

function layout(spec, opts = {}) {
  const { byId, out, inc, back } = analyze(spec);
  const layers = new Map();

  const depth = new Map();
  const forward = (e) => !back.has(e);
  const compute = (id, stack) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    let d = 0;
    for (const e of inc.get(id)) if (forward(e)) d = Math.max(d, compute(e.from, stack) + 1);
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const n of spec.nodes) compute(n.id, new Set());

  for (const n of spec.nodes) {
    const d = depth.get(n.id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  }
  const layerKeys = [...layers.keys()].sort((a, b) => a - b);

  // 节点尺寸
  for (const n of spec.nodes) {
    const isDecision = n.kind === 'decision';
    const maxUnits = isDecision ? WRAP_UNITS_DECISION : WRAP_UNITS;
    const lines = wrapText(n.label, maxUnits);
    const textW = Math.max(...lines.map(units)) * CHAR_W;
    const metaParts = [];
    if (n.time) metaParts.push(n.time);
    if (n.owner) metaParts.push(n.owner);
    n._lines = lines;
    n._meta = metaParts.join(' · ');   // 判断节点没有左上图标行，时间并入 meta
    n._metaNoTime = n.owner;           // 普通节点的时间走右上角药丸，meta 只留负责人
    const labelH = lines.length * LINE_H;
    if (isDecision) {
      // 菱形内接矩形条件：a/W + b/H ≤ 1/2（a、b 为文字块半宽半高）
      const blockH = labelH + (n._meta ? 18 : 0);
      n.h = Math.round(blockH * 2.6);
      n.w = clamp(MIN_W, MAX_W, Math.round(Math.max(labelH > LINE_H ? 2 * textW * 1.15 : 1.9 * textW, 190)));
    } else {
      // 宽度要同时容得下：左侧图标(18+9) + 间距 + 右上时间药丸 + 右内边距
      const timeW = n.time ? units(n.time) * 11 + 20 : 0;
      const minW = n.time ? Math.max(MIN_W, 27 + 10 + timeW + 14) : MIN_W;
      n.w = clamp(minW, MAX_W, Math.round(textW + NODE_PAD_X * 2));
      n.h = Math.round(48 + labelH + (n._metaNoTime ? 18 : 0) + 18);
    }
  }

  // 同层次序：以入边邻居重心排序，迭代 3 轮
  const orderIndex = new Map();
  layerKeys.forEach((k) => layers.get(k).forEach((n, i) => orderIndex.set(n.id, i)));
  for (let pass = 0; pass < 3; pass++) {
    for (const k of layerKeys) {
      const row = layers.get(k);
      const score = new Map();
      row.forEach((n, i) => {
        const preds = inc.get(n.id).filter(forward).map((e) => orderIndex.get(e.from)).filter((v) => v !== undefined);
        score.set(n.id, preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : i);
      });
      row.sort((a, b) => score.get(a.id) - score.get(b.id) || orderIndex.get(a.id) - orderIndex.get(b.id));
      row.forEach((n, i) => orderIndex.set(n.id, i));
    }
  }

  // ── 定位：支持分栏换行（长链折成多列，读向仍统一向下）────────────────
  const L = layerKeys.length;
  const rowWidths = layerKeys.map((k) => {
    const row = layers.get(k);
    return row.reduce((a, n) => a + n.w, 0) + H_GAP * (row.length - 1);
  });
  const rowHeights = layerKeys.map((k) => Math.max(...layers.get(k).map((n) => n.h)));

  // wrapRows = 每栏行数：0/未指定 → L（单栏竖排）；-1 → 自动挑；N≥2 → 固定 N 行
  const wrapRows = (opts.wrap === -1) ? pickWrapRows(L, rowWidths, rowHeights, opts.targetAspect ?? 1.6)
    : (opts.wrap >= 2 ? Math.min(opts.wrap, L) : L);
  const R = Math.max(1, Math.min(wrapRows, L));
  const C = Math.ceil(L / R);

  const colW = new Array(C).fill(0);
  for (let i = 0; i < L; i++) colW[Math.floor(i / R)] = Math.max(colW[Math.floor(i / R)], rowWidths[i]);
  const rowHmax = new Array(R).fill(0);
  for (let i = 0; i < L; i++) rowHmax[i % R] = Math.max(rowHmax[i % R], rowHeights[i]);

  const COL_GAP = 118;
  const colX = []; const rowY = [];
  let accX = 0;
  for (let c = 0; c < C; c++) { colX.push(accX); accX += colW[c] + COL_GAP; }
  const contentW = Math.max(accX - COL_GAP, 1);
  let accY = 0;
  for (let r = 0; r < R; r++) { rowY.push(accY); accY += rowHmax[r] + V_GAP; }
  const contentH = Math.max(accY - V_GAP, 1);
  const colBottom = accY - V_GAP;

  layerKeys.forEach((k, i) => {
    const row = layers.get(k);
    const c = Math.floor(i / R);
    const r = i % R;
    const y = rowY[r] + rowHmax[r] / 2;
    let x = colX[c] + (colW[c] - rowWidths[i]) / 2;
    for (const n of row) {
      n._cx = x + n.w / 2;
      n._cy = y;
      n._col = c;
      n._row = r;
      n._rowCount = row.length;
      x += n.w + H_GAP;
    }
  });

  // 边路点
  const edgePaths = [];
  let backIdx = 0;
  let busIdx = 0;
  for (const e of spec.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (e.from === e.to) {
      const x = a._cx + a.w / 2;
      edgePaths.push({ edge: e, kind: 'cubic', pts: [[x, a._cy - 8], [x + 46, a._cy - 34], [x + 46, a._cy + 34], [x, a._cy + 8]] });
      continue;
    }
    const isBack = back.has(e);
    const sameCol = a._col === b._col;
    const sameLayer = Math.abs(a._cy - b._cy) < 1;
    if (sameCol && !isBack && !sameLayer && b._cy > a._cy) {
      const p0 = [a._cx, a._cy + a.h / 2];
      const p3 = [b._cx, b._cy - b.h / 2];
      const dy = p3[1] - p0[1];
      edgePaths.push({ edge: e, kind: 'cubic', pts: [p0, [p0[0], p0[1] + dy * 0.42], [p3[0], p3[1] - dy * 0.42], p3] });
    } else if (sameCol) {
      // 同列回边 / 同层：走本列右侧旁路
      const laneX = colX[a._col] + colW[a._col] + 20 + backIdx++ * 22;
      const yTop = Math.min(a._cy, b._cy);
      const yBot = Math.max(a._cy, b._cy);
      edgePaths.push({
        edge: e, kind: 'ortho', laneTop: yTop, laneBot: yBot,
        pts: [[a._cx + a.w / 2, a._cy], [laneX, a._cy], [laneX, b._cy], [b._cx + b.w / 2, b._cy]],
      });
    } else {
      // 跨列：短路径走列间空隙；行内有多节点时改走底部走廊，避免横穿节点
      const gutter = b._col > a._col ? colX[b._col] - 34 - busIdx * 20 : colX[b._col] + colW[b._col] + 34 + busIdx * 20;
      const shortRoute = a._rowCount === 1 && b._rowCount === 1;
      busIdx++;
      let pts;
      if (shortRoute) {
        const xa = b._col > a._col ? a._cx + a.w / 2 : a._cx - a.w / 2;
        const xb = b._col > a._col ? b._cx - b.w / 2 : b._cx + b.w / 2;
        pts = [[xa, a._cy], [gutter, a._cy], [gutter, b._cy], [xb, b._cy]];
      } else {
        const corridor = colBottom + 30 + (busIdx - 1) * 20;
        pts = [[a._cx, a._cy + a.h / 2], [a._cx, corridor], [gutter, corridor], [gutter, b._cy], [b._cx - b.w / 2, b._cy]];
        if (b._col < a._col) pts[4] = [b._cx + b.w / 2, b._cy];
      }
      edgePaths.push({ edge: e, kind: 'ortho', pts });
    }
  }
  void out;

  // 分组带（跨列时按列切成多段，避免把不相干节点圈进来）
  const bands = [];
  spec.groups.forEach((g, gi) => {
    const color = g.color || GROUP_PALETTE[gi % GROUP_PALETTE.length];
    const byCol = new Map();
    for (const id of g.members) {
      const n = byId.get(id);
      const c = n._col ?? 0;
      if (!byCol.has(c)) byCol.set(c, []);
      byCol.get(c).push(n);
    }
    let part = 0;
    for (const c of [...byCol.keys()].sort((a, b) => a - b)) {
      const members = byCol.get(c);
      const label = part === 0 ? g.label : g.label + '（续）';
      const cxMin = Math.min(...members.map((n) => n._cx - n.w / 2));
      const cxMax = Math.max(...members.map((n) => n._cx + n.w / 2));
      // 分组框至少要装得下自己的标题（药丸 + 计数，二者居中后左右各留 13）
      const needW = bandTitleMetrics(label, members.length + ' 步').minBandW;
      // 标题比节点列还宽时**左右对称外扩**：只往右长会让节点列贴在左边，小节看着不居中
      const extra = Math.max(0, needW - (cxMax - cxMin + 40));      const x0 = cxMin - 20 - Math.floor(extra / 2);
      let x1 = cxMax + 20 + Math.ceil(extra / 2);
      const y0 = Math.min(...members.map((n) => n._cy - n.h / 2)) - 54;   // 54：给分组标题药丸留出空间，别贴着第一个节点
      const y1 = Math.max(...members.map((n) => n._cy + n.h / 2)) + 18;
      bands.push({
        id: g.id + '-' + c,
        label,
        members: members.map((n) => n.id),
        x: x0, y: y0, w: x1 - x0, h: y1 - y0, color,
      });
      part++;
    }
  });

  const result = { spec, nodes: spec.nodes, edgePaths, bands, contentW, contentH, wrapRows: R, cols: C };

  // LR：整体转置（坐标与宽高互换）
  if (spec.direction === 'LR') {
    const swap = (n) => {
      const cx = n._cx, cy = n._cy, w = n.w, h = n.h;
      n._cx = cy; n._cy = cx; n.w = h; n.h = w;
    };
    for (const n of spec.nodes) swap(n);
    for (const ep of result.edgePaths) ep.pts = ep.pts.map(([x, y]) => [y, x]);
    for (const b of result.bands) { const x = b.x, y = b.y, w = b.w, h = b.h; b.x = y; b.y = x; b.w = h; b.h = w; }
    const t = result.contentW; result.contentW = result.contentH; result.contentH = t;
  }

  return result;
}

/** 自动选择「每栏行数」：让画布宽高比尽量接近目标（默认 1.6，横向阅读舒适区）。 */
function pickWrapRows(L, rowWidths, rowHeights, targetAspect) {
  if (L < 5) return L;
  let best = L;
  let bestScore = Infinity;
  for (let R = 1; R <= L; R++) {
    const C = Math.ceil(L / R);
    const colW = new Array(C).fill(0);
    for (let i = 0; i < L; i++) colW[Math.floor(i / R)] = Math.max(colW[Math.floor(i / R)], rowWidths[i]);
    const rowH = new Array(R).fill(0);
    for (let i = 0; i < L; i++) rowH[i % R] = Math.max(rowH[i % R], rowHeights[i]);
    const W = colW.reduce((a, b) => a + b, 0) + 118 * (C - 1);
    const H = rowH.reduce((a, b) => a + b, 0) + V_GAP * (R - 1);
    const score = Math.abs(Math.log((W / H) / targetAspect));
    if (score < bestScore - 1e-9) { bestScore = score; best = R; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────
// SVG 渲染（含内联样式，保证 .svg 单独可用）
// ─────────────────────────────────────────────────────────────

function svgStyle(vid) {
  return loadAsset('svg.css').replace(/\{\{vid\}\}/g, vid);
}

const KIND_GLYPH = { start: '▶', end: '■', milestone: '✓', risk: '!', decision: '', task: '' };

/** 正交折线转成带圆角的路径。 */
function orthoPath(pts, r = 9) {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    if (rr < 1) { d += ` L${cx.toFixed(1)},${cy.toFixed(1)}`; continue; }
    const a = [cx - ((cx - px) / inLen) * rr, cy - ((cy - py) / inLen) * rr];
    const b = [cx + ((nx - cx) / outLen) * rr, cy + ((ny - cy) / outLen) * rr];
    d += ` L${a[0].toFixed(1)},${a[1].toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
}

// ── 角标定位：把类型图标圆环完整放进节点形状里（含描边宽度），避免"出框" ──
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToRect(px, py, x0, y0, x1, y1) {
  const dx = Math.max(x0 - px, 0, px - x1), dy = Math.max(y0 - py, 0, py - y1);
  return Math.hypot(dx, dy);
}

/** 点到节点边界的距离（正=在形状内）。rect=圆角 12 卡片；stadium=起点/终点胶囊（半径 h/2）；diamond=判断菱形。 */
function shapeClearance(shape, w, h, x, y) {
  if (shape === 'stadium') { const rad = h / 2; return rad - distToSeg(x, y, rad, rad, Math.max(rad, w - rad), rad); }
  if (shape === 'diamond') {
    const a = w / 2, b = h / 2;
    return ((1 - Math.abs(x - a) / a - Math.abs(y - b) / b) * a * b) / Math.hypot(a, b);
  }
  return 12 - distToRect(x, y, 12, 12, Math.max(12, w - 12), Math.max(12, h - 12));
}

/** 角标圆周上离节点边界最近的距离。 */
function badgeClearance(shape, w, h, gx, gy, r) {
  let m = Infinity;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    m = Math.min(m, shapeClearance(shape, w, h, gx + r * Math.cos(a), gy + r * Math.sin(a)));
  }
  return m;
}

/** 把角标推进形状内。留 4.5px：圆环描边 0.6 + 节点描边最多 1.3，再剩 ~2.6px 视觉空隙。 */
function fitBadge(shape, w, h, gx, gy, r) {
  const MARGIN = 4.5;
  let best = { gx, gy, cl: badgeClearance(shape, w, h, gx, gy, r) };
  if (best.cl >= MARGIN || shape === 'diamond') return best;   // 菱形角标在正中，本来就是最内的位置
  for (let x = gx; x <= Math.max(gx, w - r - 2); x += 0.5) {
    const cl = badgeClearance(shape, w, h, x, gy, r);
    if (cl > best.cl) best = { gx: x, gy, cl };
    if (cl >= MARGIN) return best;
  }
  return best;
}

/** 时间药丸本身是"高 21 的胶囊"（两端半圆 + 上下直边），同样要整块落在节点形状内。 */
function pillClearance(shape, w, h, tx, ty, tw, th) {
  const r = th / 2, cy = ty + r;
  const ax = tx + r, bx = Math.max(ax, tx + tw - r);
  let m = Infinity;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    m = Math.min(m, shapeClearance(shape, w, h, ax + r * Math.cos(a), cy + r * Math.sin(a)));
    m = Math.min(m, shapeClearance(shape, w, h, bx + r * Math.cos(a), cy + r * Math.sin(a)));
    const x = ax + (bx - ax) * (i / 32);
    m = Math.min(m, shapeClearance(shape, w, h, x, cy - r), shapeClearance(shape, w, h, x, cy + r));
  }
  return m;
}

/** 药丸右上角最容易顶出胶囊的右弧：往左推（不够再往下挪一点），取位移最小的解。 */
function fitPill(shape, w, h, tx, ty, tw, th) {
  const MARGIN = 3.5;   // 药丸描边 0.5 + 节点描边最多 1.3，再留 ~1.7px 视觉空隙
  let best = { tx, ty, cl: pillClearance(shape, w, h, tx, ty, tw, th) };
  if (best.cl >= MARGIN || shape === 'diamond') return best;
  for (let x = tx; x >= 2; x -= 0.5) {
    for (const dy of [0, 1, 2, 3]) {
      const cl = pillClearance(shape, w, h, x, ty + dy, tw, th);
      if (cl > best.cl) best = { tx: x, ty: ty + dy, cl };
      if (cl >= MARGIN) return { tx: x, ty: ty + dy, cl };
    }
  }
  return best;
}

function renderSvg(L, vid = 'v', head = true) {
  const pad = 40;
  const hasHead = Boolean(L.spec.title || L.spec.subtitle) && head !== false;
  const titleBand = (L.spec.title && hasHead ? 36 : 0) + (L.spec.subtitle && hasHead ? 22 : 0) + (hasHead ? 18 : 0);
  // 分组带可能比节点列更宽（标题长）而对称外扩，甚至到负数：把分组带的包围盒也算进原点与画布尺寸，避免被裁掉
  const bMinX = L.bands.length ? Math.min(0, ...L.bands.map((b) => b.x)) : 0;
  const bMaxX = L.bands.length ? Math.max(L.contentW, ...L.bands.map((b) => b.x + b.w)) : L.contentW;
  const bMinY = L.bands.length ? Math.min(0, ...L.bands.map((b) => b.y)) : 0;
  const bMaxY = L.bands.length ? Math.max(L.contentH, ...L.bands.map((b) => b.y + b.h)) : L.contentH;
  const W = Math.round(bMaxX - bMinX + pad * 2 + 120);
  const H = Math.round(bMaxY - bMinY + pad * 2 + titleBand);
  const ox = pad - bMinX;
  const oy = pad - bMinY + titleBand;
  const ff = "'Segoe UI','Microsoft YaHei',system-ui,sans-serif";

  const parts = [];
  parts.push(`<svg id="flow-svg-${vid}" data-variant="${vid}" data-theme="dark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  parts.push('<defs>');
  parts.push('<style>' + svgStyle(vid).replace(/var\(--ff\)/g, ff) + '</style>');
  parts.push(`<filter id="nShadow-${vid}" x="-25%" y="-25%" width="150%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="3.2" flood-color="#05070c" flood-opacity="0.34"/></filter>`);
  parts.push(`<filter id="selGlow-${vid}" x="-35%" y="-35%" width="170%" height="170%"><feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="#4a9dff" flood-opacity="0.8"/></filter>`);
  parts.push(`<filter id="selGlowWarm-${vid}" x="-35%" y="-35%" width="170%" height="170%"><feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="#bf6b3a" flood-opacity="0.65"/></filter>`);
  parts.push(`<pattern id="grid-${vid}" width="26" height="26" patternUnits="userSpaceOnUse"><circle class="grid-dot" cx="2" cy="2" r="1.15"/></pattern>`);
  const mk = (id, color) => `<marker id="${id}-${vid}" viewBox="0 0 12 12" refX="9.5" refY="6" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse"><path d="M1.5 2.2 L10 6 L1.5 9.8 z" fill="${color}"/></marker>`;
  parts.push(mk('arrow', 'var(--edge)'));
  parts.push(mk('arrow-hi', 'var(--accent)'));
  parts.push(mk('arrow-dim', 'var(--edge-dim)'));
  parts.push('</defs>');

  // 画布点阵底纹：放在 #vp 里、范围放大到 ±1 倍画布，
  // 这样缩放/平移时底纹跟着走，且不会在视野里露出"底纹矩形"的硬边。
  parts.push(`<g id="vp-${vid}">`);
  parts.push(`<rect class="canvas-grid" x="${-W}" y="${-H}" width="${W * 3}" height="${H * 3}" fill="url(#grid-${vid})"/>`);

  // 标题块（页面外壳已经有标题，所以 HTML 版不画，避免缩放时压住节点；导出的 .svg 才画）
  if (hasHead) {
    const ty = pad + 4;
    parts.push(`<rect class="t-accent" x="${ox}" y="${ty}" width="4.5" height="${L.spec.title ? 22 : 14}" rx="2.25"/>`);    if (L.spec.title) parts.push(`<text class="t-title" x="${ox + 16}" y="${ty + 18}">${xml(L.spec.title)}</text>`);
    if (L.spec.subtitle) parts.push(`<text class="t-sub" x="${ox + 16}" y="${ty + (L.spec.title ? 42 : 13)}">${xml(L.spec.subtitle)}</text>`);
  }

  // 分组带
  for (const b of L.bands) {
    parts.push(`<g class="band">`);
    parts.push(`<rect class="band-bg" x="${(ox + b.x).toFixed(1)}" y="${(oy + b.y).toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="16" fill="${b.color}" fill-opacity="0.075" stroke="${b.color}" stroke-opacity="0.46"/>`);
    if (b.label) {
      const countText = b.members.length + ' 步';
      const bm = bandTitleMetrics(b.label, countText);
      const lw = bm.labelW;
      const cw = bm.countW;
      // 药丸 + 计数 作为一组在带内水平居中
      const lx = ox + b.x + Math.max(13, (b.w - (lw + 8 + cw)) / 2);
      const ly = oy + b.y + 10;
      parts.push(`<rect class="band-pill" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${lw.toFixed(1)}" height="23" rx="11.5" fill="${b.color}"/>`);
      parts.push(`<text class="band-label" x="${(lx + 13).toFixed(1)}" y="${(ly + 16).toFixed(1)}" fill="${b.color}" style="--c:${b.color}">${xml(b.label)}</text>`);
      parts.push(`<text class="band-count" x="${(lx + lw + 8).toFixed(1)}" y="${(ly + 16).toFixed(1)}" fill="${b.color}" style="--c:${b.color}" opacity="0.8">${countText}</text>`);
    }
    parts.push('</g>');
  }

  // 边
  const labelGroups = [];
  for (const ep of L.edgePaths) {
    const e = ep.edge;
    const pts = ep.pts.map(([x, y]) => [ox + x, oy + y]);
    let d;
    if (ep.kind === 'cubic') {
      const dy = pts[3][1] - pts[0][1];
      const off = Math.max(26, Math.abs(dy) * 0.38);
      const c1 = [pts[0][0], pts[0][1] + off];
      const c2 = [pts[3][0], pts[3][1] - off];
      d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${pts[3][0].toFixed(1)},${pts[3][1].toFixed(1)}`;
    } else {
      d = orthoPath(pts);
    }
    const cls = 'edge' + (e.style === 'dashed' ? ' dashed' : '');
    parts.push(`<path class="${cls}" data-from="${xml(e.from)}" data-to="${xml(e.to)}" marker-end="url(#arrow-${vid})" d="${d}"/>`);
    if (e.label) {
      const mid = ep.kind === 'cubic'
        ? [(pts[0][0] + pts[3][0]) / 2, (pts[0][1] + pts[3][1]) / 2]
        : pts[1];
      const w = Math.max(32, units(e.label) * 11.5 + 18);
      labelGroups.push(`<g class="edge-label-g" data-from="${xml(e.from)}" data-to="${xml(e.to)}"><rect class="edge-label-bg" x="${(mid[0] - w / 2).toFixed(1)}" y="${(mid[1] - 10.5).toFixed(1)}" width="${w.toFixed(1)}" height="21" rx="10.5"/><text class="edge-label" x="${mid[0].toFixed(1)}" y="${(mid[1] + 4).toFixed(1)}">${xml(e.label)}</text></g>`);
    }
  }
  parts.push(...labelGroups);

  // 节点
  for (const n of L.spec.nodes) {
    const x = ox + n._cx - n.w / 2;
    const y = oy + n._cy - n.h / 2;
    const isDec = n.kind === 'decision';
    const cls = ['node', 'k-' + n.kind, n.status ? 'st-' + n.status : 'st-none'].join(' ');
    parts.push(`<g class="${cls}" data-id="${xml(n.id)}" data-status="${xml(n.status || '')}" data-kind="${xml(n.kind)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">`);

    if (isDec) {
      parts.push(`<polygon class="node-bg" filter="url(#nShadow-${vid})" points="${(n.w / 2).toFixed(1)},0 ${n.w.toFixed(1)},${(n.h / 2).toFixed(1)} ${(n.w / 2).toFixed(1)},${n.h.toFixed(1)} 0,${(n.h / 2).toFixed(1)}"/>`);
    } else if (n.kind === 'start' || n.kind === 'end') {
      parts.push(`<rect class="node-bg" filter="url(#nShadow-${vid})" x="0" y="0" width="${n.w}" height="${n.h}" rx="${(n.h / 2).toFixed(1)}"/>`);
    } else {
      parts.push(`<rect class="node-bg" filter="url(#nShadow-${vid})" x="0" y="0" width="${n.w}" height="${n.h}" rx="12"/>`);
      parts.push(`<rect class="accent" x="0" y="10" width="3.5" height="${n.h - 20}" rx="1.75"/>`);
    }

    // 类型图标（起点/终点/检查点/风险/判断）；普通环节没有图标，保持清爽
    const capsule = n.kind === 'start' || n.kind === 'end';
    const shape = isDec ? 'diamond' : (capsule ? 'stadium' : 'rect');
    const glyph = KIND_GLYPH[n.kind] || '';
    if (glyph) {
      const R = 9;
      // 圆角卡片/胶囊要把角标推离左边和上边的弧，否则圆环会压在节点轮廓上（胶囊最明显）
      const fit = fitBadge(shape, n.w, n.h, isDec ? n.w / 2 : 18.5, isDec ? 23 : 20, R);
      const gx = fit.gx, gy = fit.gy;
      parts.push(`<circle class="kind-chip" cx="${gx.toFixed(1)}" cy="${gy}" r="${R}"/>`);
      parts.push(`<circle class="kind-ring" cx="${gx.toFixed(1)}" cy="${gy}" r="${R}"/>`);
      parts.push(`<text class="kind-glyph" x="${gx.toFixed(1)}" y="${gy + 0.5}">${xml(glyph)}</text>`);
    }

    // 时间药丸（判断节点没有图标行，时间并入 meta 行）；胶囊右上角是圆角，药丸同样要内推
    if (n.time && !isDec) {
      const tw = units(n.time) * 11 + 18;
      const fit = fitPill(shape, n.w, n.h, n.w - 12 - tw, 8.5, tw, 21);
      const tx = fit.tx, pillY = fit.ty;
      parts.push(`<rect class="time-pill" x="${tx.toFixed(1)}" y="${pillY.toFixed(1)}" width="${tw.toFixed(1)}" height="21" rx="10.5"/>`);
      parts.push(`<text class="t-time" x="${(tx + tw / 2).toFixed(1)}" y="${(pillY + 14.5).toFixed(1)}" text-anchor="middle">${xml(n.time)}</text>`);
    }

    let ty;
    if (isDec) {
      const blockH = n._lines.length * LINE_H + (n._meta ? 18 : 0);
      ty = Math.round(n.h / 2 - blockH / 2 + 15);   // 菱形内文字垂直居中
    } else ty = 47;
    for (const line of n._lines) {
      parts.push(`<text class="t-label" x="${(n.w / 2).toFixed(1)}" y="${ty}" text-anchor="middle">${xml(line)}</text>`);
      ty += LINE_H;
    }
    const metaText = isDec ? n._meta : n._metaNoTime;
    if (metaText) parts.push(`<text class="t-meta" x="${(n.w / 2).toFixed(1)}" y="${ty + 2}" text-anchor="middle">${xml(metaText)}</text>`);
    parts.push('</g>');
  }

  parts.push('</g></svg>');
  return { svg: parts.join('\n'), width: W, height: H };
}

// ─────────────────────────────────────────────────────────────
// HTML 外壳（页面 chrome 的 CSS/JS 也全部内联）
// ─────────────────────────────────────────────────────────────

const CLIENT_JS = loadAsset('app.js');

/** assets/shell.html 是页面骨架，里面的 {{名字}} 是占位符，由 renderHtml 传进来的内容填上。
 *  只扫描模板一遍、用函数式替换：填进去的内容（Mermaid 源码、JSON、标题……）里即使有 {{…}} 或 $&，也不会被二次展开或吞字符。
 *  读取时统一成 LF、去 BOM（这些文本原来写在模板字符串里，换行天然是 LF）。 */
const loadShell = () => {
  const t = loadAsset('shell.html');
  return (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t).replace(/\r\n/g, '\n');
};
const fillShell = (tpl, slots) => {
  for (const k of Object.keys(slots)) if (!tpl.includes('{{' + k + '}}')) throw new Error('shell.html 缺少占位符 {{' + k + '}}');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in slots)) throw new Error('shell.html 里有未知占位符 {{' + k + '}}');
    return slots[k];
  });
};

function renderHtml(svgs, L, mmd, meta = {}) {
  const spec = L.spec;
  const predsOf = new Map(spec.nodes.map((n) => [n.id, []]));
  const succsOf = new Map(spec.nodes.map((n) => [n.id, []]));
  for (const e of spec.edges) { succsOf.get(e.from).push(e.to); predsOf.get(e.to).push(e.from); }
  const slug = (spec.title || 'workflow').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  const data = {
    slug,
    title: spec.title,
    subtitle: spec.subtitle,
    direction: spec.direction,
    groups: spec.groups,
    statusLabels: STATUS_LABEL,
    kinds: [...new Set(spec.nodes.map((n) => n.kind))].map((k) => ({ key: k, label: KIND_LABEL[k] || k })),
    nodes: spec.nodes.map((n) => ({
      id: n.id, label: n.label, kind: n.kind,
      kindLabel: KIND_LABEL[n.kind] || n.kind,
      status: n.status || '', statusLabel: n.status ? (STATUS_LABEL[n.status] || n.status) : '',
      time: n.time, owner: n.owner, detail: n.detail, note: n.note,
      preds: predsOf.get(n.id), succs: succsOf.get(n.id),
    })),
    edges: spec.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, style: e.style })),
    selfFile: meta.selfFile || '',
    flows: meta.flows || [],
  };
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  const statusesPresent = [...new Set(spec.nodes.map((n) => n.status).filter(Boolean))];
  const statusCounts = {};
  for (const n of spec.nodes) if (n.status) statusCounts[n.status] = (statusCounts[n.status] || 0) + 1;
  // 第 6 段是状态汇总（done:4,risk:1…）：首页据此显示"全部图里共多少处需关注"
  const stats = [
    spec.nodes.length, spec.edges.length, spec.groups.length,
    svgs.portraitSize, svgs.landscapeSize,
    Object.entries(statusCounts).map(([k, v]) => `${k}:${v}`).join(','),
  ].join('|');

  const legend = statusesPresent.map((s) => `<button data-status="${s}"><i class="dot st-${s}"></i>${STATUS_LABEL[s] || s}</button>`).join('');
  return fillShell(loadShell(), {
    titleMeta: xml(spec.title || ''),
    flowVersion: FLOW_VERSION,
    stats: xml(stats),
    titleTag: xml(spec.title || '工作流图'),
    brandName: xml(spec.title || '工作流'),
    legend,
    svgPortrait: svgs.portrait,
    svgLandscape: svgs.landscape,
    mmd: xml(mmd),
    json,
    css: loadAsset('app.css'),
    js: CLIENT_JS,
  });
}

// ─────────────────────────────────────────────────────────────
// Mermaid 导出
// ─────────────────────────────────────────────────────────────

/** Mermaid 标签转义：含分隔符时用双引号包起来（与 parseMermaid 的反解规则配套）。 */
const MMD_SPECIAL = /[\[\]{}()|"]/;
function mmdLabel(s) {
  const t = String(s ?? '');
  return MMD_SPECIAL.test(t) ? '"' + t.replace(/"/g, '&quot;') + '"' : t;
}

/** 边标签里的竖线用视觉等价的 U+2223 表示，避免冲突于 |标签| 分隔符；解析往返时还原。 */
function mmdEdgeLabel(s) {
  return mmdLabel(String(s ?? '').replace(/\|/g, '\u2223'));
}

const MMD_RESERVED = new Set(['end', 'subgraph', 'graph', 'flowchart', 'class', 'classdef', 'style',
  'linkstyle', 'click', 'direction', 'acctitle', 'accdescr']);

/** Mermaid 的关键字不能当节点 id：`end((终点))` 在真实 Mermaid 里也会被当成分组结束，导出时统一改名。 */
function safeId(id) {
  const s = String(id);
  return MMD_RESERVED.has(s.trim().toLowerCase()) ? s + '_' : s;
}

/** 导出件首行的标记：告诉 refresh「这是产物、不是源」，别拿它重渲染（会丢 time/owner/detail/note） */
const MMD_EXPORT_MARK = '%% workflow-visualizer 导出件（不是源文件；要改流程请改 .json，或直接改这个 .mmd 并删掉本行）';

function toMermaid(spec) {
  const out = [];
  out.push(MMD_EXPORT_MARK);
  out.push('flowchart ' + (spec.direction === 'LR' ? 'LR' : 'TD'));
  const shapeOf = (n) => {
    const t = mmdLabel(n.label);
    if (n.kind === 'decision') return `{${t}}`;
    if (n.kind === 'start' || n.kind === 'end') return `((${t}))`;
    return `[${t}]`;
  };
  const nodeById = new Map(spec.nodes.map((n) => [n.id, n]));
  const inGroup = new Map();
  spec.groups.forEach((g, i) => g.members.forEach((m) => inGroup.set(m, i)));
  const emitted = new Set();
  spec.groups.forEach((g, gi) => {
    out.push('  subgraph ' + mmdLabel(g.label || g.id));
    for (const m of g.members) {
      out.push('    ' + safeId(m) + shapeOf(nodeById.get(m)));
      emitted.add(m);
    }
    out.push('  end');
    void gi;
  });
  for (const n of spec.nodes) if (!emitted.has(n.id)) out.push('  ' + safeId(n.id) + shapeOf(n));
  for (const e of spec.edges) {
    const arrow = e.style === 'dashed' ? '-.->' : '-->';
    out.push('  ' + safeId(e.from) + ' ' + arrow + (e.label ? '|' + mmdEdgeLabel(e.label) + '|' : '') + ' ' + safeId(e.to));
  }
  return out.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

const BOOL_FLAGS = new Set(['all', 'help', 'debug', 'single']);
const VALUE_FLAGS = new Set(['out', 'svg', 'mmd', 'wrap', 'port']);

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) { flags[key] = true; continue; }
      if (!VALUE_FLAGS.has(key)) {
        fail('未知参数：--' + key + '（可用：' + [...BOOL_FLAGS, ...VALUE_FLAGS].map((k) => '--' + k).join(' / ') + '）');
      }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) fail('参数 --' + key + ' 缺少取值');
      flags[key] = val;
      i++;
    } else rest.push(a);
  }
  if (rest.length > 1) fail('多余的位置参数：' + rest.slice(1).join(' ') + '（每个命令只接受一个输入路径）');
  return { flags, rest };
}

function writeOut(file, content) {
  const dir = dirname(resolve(file));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, content, 'utf8');
}

/** 反转义 meta 里的实体，用于把标题还原成可读文本。 */
function unxml(s) {
  return String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * 扫描目录里由本 skill 生成的流程图页面（靠 HTML 上的 data-flow-viz="1" 标记识别），
 * 供页面里的「全部流程图」抽屉使用。按修改时间倒序。
 */
function scanFlows(dir) {
  const flows = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return { version: 1, updated: '', flows }; }
  for (const name of names) {
    if (!/\.html?$/i.test(name) || name.startsWith('【') || name.startsWith('.')) continue;
    const full = join(dir, name);
    let text = '';
    let st = null;
    try {
      st = statSync(full);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      text = readFileSync(full, 'utf8');
    } catch { continue; }
    if (!/data-flow-viz="1"/.test(text)) continue;
    const title = unxml((/<meta name="flow-title" content="([^"]*)"/.exec(text) || [, ''])[1]);
    const statsRaw = unxml((/<meta name="flow-stats" content="([^"]*)"/.exec(text) || [, ''])[1]);
    const [nodes = '0', edges = '0', groups = '0', portrait = '', landscape = '', status = ''] = String(statsRaw).split('|');
    flows.push({
      file: name,
      title: title || name.replace(/\.html?$/i, ''),
      nodes: Number(nodes) || 0,
      edges: Number(edges) || 0,
      groups: Number(groups) || 0,
      portrait, landscape, status,
      mtime: new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false }),
      mtimeMs: st.mtimeMs,
    });
  }
  // 固定按文件名排序（不用 mtime）：这样页面内嵌快照与「流程索引.json」顺序永远一致，
  // 打开抽屉后 fetch 回来也不会重排——列表在手指底下跳位置会点错条目。
  flows.sort((a, b) => a.file.localeCompare(b.file, 'zh'));
  return { version: 1, updated: new Date().toLocaleString('zh-CN', { hour12: false }), flows };
}

async function cmdRender(input, flags) {
  const spec = normalize(loadSpec(input));
  // 0=关闭分栏；N=横版每栏 N 行（N=1 合法，表示每栏一个节点），负数/非整数直接报错
  if (flags.wrap !== undefined && !/^\d+$/.test(String(flags.wrap).trim())) {
    fail('--wrap 需要 ≥0 的整数：0=关闭分栏，N=横版每栏 N 行');
  }
  const baseWrap = flags.wrap !== undefined ? Number(flags.wrap) : (spec.wrap ?? 0);

  // 两个版式各自独立布局（structuredClone 隔离坐标，避免互相覆盖）
  const Lp = layout(structuredClone(spec), { wrap: baseWrap });
  const Lw = baseWrap >= 2 || baseWrap === -1
    ? layout(structuredClone(spec), { wrap: baseWrap, targetAspect: 1.6 })
    : layout(structuredClone(spec), { wrap: -1, targetAspect: 1.6 });
  const svgP = renderSvg(Lp, 'portrait', false);          // HTML 版：不画标题块
  const svgW = renderSvg(Lw, 'landscape', false);
  const svgPFile = renderSvg(Lp, 'portrait', true);       // 导出的 .svg：自带标题
  const svgWFile = renderSvg(Lw, 'landscape', true);
  const mmd = toMermaid(spec);

  if (flags.debug) {
    for (const [tag, L] of [['竖版', Lp], ['横版', Lw]]) {
      process.stderr.write(`debug ${tag}: cols=${L.cols} rows=${L.wrapRows} 画布 ${L.contentW.toFixed(0)}x${L.contentH.toFixed(0)}\n`);
      const rows = new Map();
      for (const n of L.spec.nodes) {
        const key = (n._col ?? 0) + ':' + (n._row ?? 0);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(n.id);
      }
      for (const [k, ids] of rows) process.stderr.write(`    col:row ${k} → ${ids.join(' ')}\n`);
    }
  }

  const stem = basename(input).replace(/\.(json|mmd|mermaid|md|markdown)$/i, '');
  const outDir = flags.out ? dirname(resolve(flags.out)) : dirname(resolve(input));
  const htmlPath = flags.out ? resolve(flags.out) : join(outDir, stem + '.html');
  const selfFile = basename(htmlPath);
  const portraitSize = `${svgP.width}x${svgP.height}`;
  const landscapeSize = `${svgW.width}x${svgW.height}`;

  // 页面内嵌一份清单快照（file:// 下打不开 fetch，用它兜底）。
  // 顺序与「流程索引.json」完全一致（都按文件名），且**包含当前页自己**——
  // 抽屉里要能标出「当前」，也不能因为 fetch 回来而重排（那会导致手指底下的条目换位、点错）。
  const listed = scanFlows(outDir).flows;
  const snapshot = listed.slice();
  if (!listed.some((f) => f.file === selfFile)) {
    snapshot.push({
      file: selfFile,
      title: spec.title || stem,
      nodes: spec.nodes.length,
      edges: spec.edges.length,
      groups: spec.groups.length,
      portrait: portraitSize,
      landscape: landscapeSize,
      mtime: '本次生成',
      mtimeMs: 0,
    });
    snapshot.sort((a, b) => a.file.localeCompare(b.file, 'zh'));
  }

  writeOut(htmlPath, renderHtml(
    { portrait: svgP.svg, landscape: svgW.svg, portraitSize, landscapeSize },
    Lp, mmd, { selfFile, flows: snapshot },
  ));
  writeOut(join(outDir, FLOW_MANIFEST), JSON.stringify(scanFlowsWithVersion(outDir), null, 2) + '\n');

  // 静态首页：本地 file:// 打开时浏览器只会给"纯文件名列表"，
  // 这份 index.html 就是它的替代品（🏠 按钮在 file:// 下指向它）。
  try {
    const homeHtml = await buildHome({
      dir: outDir,
      baseHref: '',
      rootPath: outDir,
      port: Number(flags.port) || 8765,
      fileMode: true,
    });
    writeOut(join(outDir, 'index.html'), homeHtml);
  } catch (err) {
    process.stderr.write('flow: 静态首页生成失败（不影响流程图）：' + err.message + '\n');
  }

  const written = [htmlPath, join(outDir, FLOW_MANIFEST), join(outDir, 'index.html')];
  if (flags.all || flags.mmd) {
    const p = flags.mmd ? resolve(flags.mmd) : join(outDir, stem + '.mmd');
    writeOut(p, mmd);
    written.push(p);
  }
  if (flags.all || flags.svg) {
    const pP = flags.svg ? resolve(flags.svg) : join(outDir, stem + '-竖版.svg');
    const pW = flags.svg ? pP.replace(/\.svg$/i, '') + '-横版.svg' : join(outDir, stem + '-横版.svg');
    writeOut(pP, '<?xml version="1.0" encoding="UTF-8"?>\n' + svgPFile.svg);
    writeOut(pW, '<?xml version="1.0" encoding="UTF-8"?>\n' + svgWFile.svg);
    written.push(pP, pW);
  }

  const stats = `节点 ${spec.nodes.length} · 连线 ${spec.edges.length} · 分组 ${spec.groups.length}`
    + ` · 竖版 ${svgP.width}x${svgP.height} · 横版 ${svgW.width}x${svgW.height}`
    + (Lw.cols > 1 ? `（横版自动分 ${Lw.cols} 栏）` : '');
  process.stdout.write('flow: ' + stats + '\n');
  for (const p of written) process.stdout.write('  → ' + p + '\n');
  return 0;
}

/** 扫描产物目录并带上版本信息：清单自身的 generatorVersion + 每个产物 HTML 里的 flow-version。
 *  渲染与建索引**都要**用它写清单，否则后写的那次会把版本信息抹掉（首页就会显示 v?）。 */
function scanFlowsWithVersion(dir) {
  const mf = scanFlows(dir);
  mf.generatorVersion = FLOW_VERSION;
  for (const f of mf.flows) {
    try {
      const html = readFileSync(join(dir, f.file), 'utf8');
      const m = /<meta name="flow-version" content="([^"]*)"/.exec(html);
      f.version = m ? m[1] : '';
    } catch (e) { f.version = ''; }
  }
  return mf;
}

/** 批量重渲染：把目录里所有"有规格的"流程图刷新成当前版本，然后重建清单与首页。
 *  规格认 *.json（含 nodes 数组）与 *.mmd / *.md；产物名与规格同名（.html）。 */
async function cmdRefresh(dir, flags) {
  const target = resolve(dir || '.');
  if (!existsSync(target)) fail('目录不存在：' + target);
  const all = readdirSync(target);
  const isSpecJson = (f) => {
    try { const j = JSON.parse(readFileSync(join(target, f), 'utf8')); return j && Array.isArray(j.nodes) && j.nodes.length > 0; } catch (e) { return false; }
  };
  const isExport = (f) => {
    try { return readFileSync(join(target, f), 'utf8').slice(0, 400).includes('workflow-visualizer 导出件'); } catch (e) { return false; }
  };
  const specs = all.filter((f) => /\.(json|mmd|markdown|md)$/i.test(f)).filter((f) => {
    if (/^流程索引\.json$/i.test(f)) return false;
    if (/\.json$/i.test(f)) return isSpecJson(f);
    if (isExport(f)) return false;                 // 本 skill 导出的产物：不是源
    // 同名有 .json 规格时跳过 .mmd/.md —— 那些多半是本 skill 导出的产物，拿它当源会丢 id/形状
    const base = f.replace(/\.(mmd|markdown|md)$/i, '');
    return !all.includes(base + '.json');
  });
  if (!specs.length) { process.stdout.write('flow: 这个目录里没有可刷新的规格文件（*.json 含 nodes / *.mmd）\n'); return 0; }
  let n = 0;
  for (const f of specs) {
    const spec = join(target, f);
    const base = f.replace(/\.(json|mmd|markdown|md)$/i, '');
    const out = join(target, base + '.html');
    // 输入是 .mmd/.md 时**不要**写 <同名>.mmd：那正是源文件本身，会被导出结果改写（注释、顺序、保留字 id 全丢）
    const isMmdSource = /\.(mmd|markdown|md)$/i.test(f);
    // 护栏：Mermaid 语法存不下 时间/负责人/说明/备注。若同名产物里已经有这些字段，
    // 用 .mmd 重渲染就会把它们抹掉（踩过一次）—— 这里直接跳过并提示改 .json。
    if (isMmdSource && existsSync(out)) {
      try {
        const prev = readFileSync(out, 'utf8');
        const j = /<script id="flow-data" type="application\/json">([\s\S]*?)<\/script>/.exec(prev);
        if (j) {
          const d = JSON.parse(j[1]);
          const rich = (d.nodes || []).filter((n) => n.time || n.owner || n.detail || n.note).length;
          if (rich) {
            process.stdout.write('  · 跳过 ' + f + '：同名产物里有 ' + rich + ' 个节点带时间/负责人/说明，.mmd 存不下这些字段\n    → 想重渲染请用 ' + base + '.json（或先把 .mmd 换成带字段的 JSON 源）\n');
            continue;
          }
        }
      } catch (e) { /* 读不出来就按原样继续 */ }
    }
    await cmdRender(spec, isMmdSource
      ? { out, svg: join(target, base + '-竖版.svg'), wrap: flags.wrap }
      : { out, all: true, wrap: flags.wrap });
    if (isMmdSource) {
      // --svg x.svg 的约定会再写一个 x-横版.svg；对 mmd 源来说就成了 "<base>-竖版-横版.svg"，清掉它
      const stray = join(target, base + '-竖版-横版.svg');
      if (existsSync(stray) && !/竖版-竖版/.test(base)) { try { rmSync(stray); } catch (e) { /* 删不掉就算了 */ } }
    }
    n++;
  }
  process.stdout.write(`flow: 已刷新 ${n} 张流程图 → ${target}\n`);
  return cmdIndex(target, flags);
}

async function cmdIndex(dir, flags) {
  const target = resolve(dir || '.');
  if (!existsSync(target)) fail('目录不存在：' + target);
  // 版本信息一起写进清单：首页据此标出"旧版渲染"并显示生成器版本
  const manifest = scanFlowsWithVersion(target);
  const out = flags.out ? resolve(flags.out) : join(target, FLOW_MANIFEST);
  writeOut(out, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`flow: 收录 ${manifest.flows.length} 张流程图 → ${out}\n`);
  for (const f of manifest.flows) process.stdout.write(`  · ${f.title}  (${f.nodes} 环节 · ${f.mtime})\n`);

  // 静态首页（file:// 打开用的 index.html）同样是"生成时快照"，而且它还会把目录里
  // 非流程图的 .html 当成 dev 卡片列出来。只重建清单不重建首页，删掉的文件就会在
  // 首页上留下幽灵卡片（踩过：临时自测页删除后首页仍显示 _selftest）。
  try {
    const homeHtml = await buildHome({
      dir: target,
      baseHref: '',
      rootPath: target,
      port: Number(flags.port) || 8765,
      fileMode: true,
    });
    const homePath = join(target, 'index.html');
    writeOut(homePath, homeHtml);
    process.stdout.write('flow: 静态首页已同步 → ' + homePath + '\n');
  } catch (err) {
    process.stderr.write('flow: 静态首页生成失败（不影响清单）：' + err.message + '\n');
  }
  return 0;
}

function cmdPreview(target, flags) {
  if (!target) fail('用法：flow.mjs preview <流程图.html> [--out 对照预览.html]');
  const page = basename(resolve(target));
  const out = flags.out ? resolve(flags.out) : join(dirname(resolve(target)), '【电脑用】对照预览.html');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>两版对照：手机竖屏 / 电脑横屏</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:16px;background:#0b0e13;color:#e7eaf0;
       font:13px/1.5 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;
       display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
  .dev{background:#151b24;border:1px solid #2d3644;border-radius:14px;padding:10px;flex:0 0 auto}
  .dev h4{margin:0 0 8px;font-size:12px;font-weight:600;color:#93a0b3}
  iframe{border:0;border-radius:9px;background:#0e1116;display:block}
  .phone iframe{width:354px;height:632px}
  .desk  iframe{width:944px;height:632px}
  .mobile-tip{display:none;background:#1b2129;border:1px solid #2d3644;border-left:3px solid #4a9dff;
              border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.7;max-width:640px}
  /* 手机上看这个对照页没意义（它是给电脑并排比对用的），只留提示，避免整页被缩小成一团 */
  @media (max-width:900px){
    .desk{display:none}
    .mobile-tip{display:block}
  }
</style>
</head>
<body>
  <div class="mobile-tip">
    这是<b>电脑上</b>用的并排对照页（左右两个固定宽度的框），手机上打开只会被整体缩小，看不出效果。<br>
    手机上请直接打开 <code>${xml(page)}</code> —— 它会自动选竖版并占满屏幕。
  </div>
  <div class="dev phone"><h4>手机竖屏 354×632　→　应自动选「竖版」</h4><iframe src="${xml(page)}"></iframe></div>
  <div class="dev desk"><h4>电脑横屏 944×632　→　应自动选「横版」</h4><iframe src="${xml(page)}"></iframe></div>
</body>
</html>
`;
  writeOut(out, html);
  process.stdout.write('flow: 对照预览 → ' + out + '\n');
  return 0;
}

function cmdCheck(input) {
  const spec = normalize(loadSpec(input));
  const { back, inc, out } = analyze(spec);
  const problems = [];
  const reachable = new Set();
  const roots = spec.nodes.filter((n) => inc.get(n.id).length === 0).map((n) => n.id);
  const walk = (id) => { if (reachable.has(id)) return; reachable.add(id); for (const e of out.get(id)) walk(e.to); };
  roots.forEach(walk);
  for (const n of spec.nodes) if (!reachable.has(n.id)) problems.push('节点不可达（没有任何入边且不是起点）：' + n.id);
  const isolated = spec.nodes.filter((n) => inc.get(n.id).length === 0 && out.get(n.id).length === 0);
  for (const n of isolated) problems.push('孤立节点（既无入边也无出边）：' + n.id);
  const noEnd = spec.nodes.every((n) => out.get(n.id).length > 0);
  if (noEnd) problems.push('没有终点：每个节点都有出边（可能有环）');
  process.stdout.write('flow: 节点 ' + spec.nodes.length + ' · 连线 ' + spec.edges.length + ' · 分组 ' + spec.groups.length + '\n');
  if (back.size) process.stdout.write('  ↺ 检测到 ' + back.size + ' 条回边（会走右侧旁路渲染）\n');
  if (!problems.length) process.stdout.write('  ✓ 结构检查通过\n');
  else for (const p of problems) process.stdout.write('  ! ' + p + '\n');
  // 退出码契约：0=通过 / 1=结构问题 / 2=参数或输入错误（fail()）
  return problems.length ? 1 : 0;
}

function cmdSample(flags) {
  const sample = {
      "title": "示例：饮品店 · 每日开店到闭店",
      "subtitle": "虚构示例，用来演示分组 / 时间窗 / 状态 / 判断 / 风险点；把它改成你自己的流程即可",
      "direction": "TD",
      "groups": [
          {
              "id": "g1",
              "label": "开店（08:00–09:30）",
              "members": [
                  "s",
                  "a",
                  "b",
                  "c"
              ]
          },
          {
              "id": "g2",
              "label": "营业（09:30–21:00）",
              "members": [
                  "d",
                  "e",
                  "f",
                  "g",
                  "h"
              ]
          },
          {
              "id": "g3",
              "label": "收尾（21:00–22:30）",
              "members": [
                  "i",
                  "j",
                  "k",
                  "l"
              ]
          }
      ],
      "nodes": [
          {
              "id": "s",
              "label": "08:00 到店",
              "kind": "start",
              "status": "done"
          },
          {
              "id": "a",
              "label": "开设备与巡检",
              "kind": "task",
              "time": "08:00–08:30",
              "owner": "店长",
              "status": "done",
              "detail": "咖啡机 / 制冰机 / 收银台 / 灭火器压力表"
          },
          {
              "id": "b",
              "label": "备料与试味",
              "kind": "task",
              "time": "08:30–09:10",
              "owner": "后厨",
              "status": "done",
              "detail": "研磨刻度、糖浆效期、试饮校准"
          },
          {
              "id": "c",
              "label": "开店前复检",
              "kind": "milestone",
              "time": "09:10–09:30",
              "owner": "店长",
              "status": "doing",
              "detail": "卫生 / 价签 / 外卖平台接单状态",
              "note": "复检不过先不开门，避免差评"
          },
          {
              "id": "d",
              "label": "09:30 开门营业",
              "kind": "task",
              "time": "09:30–11:00",
              "owner": "值班",
              "status": "doing"
          },
          {
              "id": "e",
              "label": "排队是否超过 8 单",
              "kind": "decision",
              "time": "11:00–13:00",
              "owner": "值班",
              "status": "todo",
              "detail": "判断要不要加开出杯位"
          },
          {
              "id": "f",
              "label": "开第二个出杯位",
              "kind": "risk",
              "time": "高峰",
              "owner": "值班",
              "status": "risk",
              "detail": "临时加人，注意冰槽与杯盖库存",
              "note": "库存不够时先限购单品"
          },
          {
              "id": "g",
              "label": "正常出杯",
              "kind": "task",
              "time": "高峰",
              "owner": "值班",
              "status": "todo"
          },
          {
              "id": "h",
              "label": "午后补货",
              "kind": "task",
              "time": "14:00–15:00",
              "owner": "后厨",
              "status": "hold",
              "detail": "牛奶 / 冰块 / 杯具 / 封口膜",
              "note": "等供应商到货，缺的先用替代品"
          },
          {
              "id": "i",
              "label": "21:00 停止接单",
              "kind": "task",
              "time": "21:00",
              "owner": "值班",
              "status": "todo"
          },
          {
              "id": "j",
              "label": "清洁与设备保养",
              "kind": "task",
              "time": "21:00–22:00",
              "owner": "后厨",
              "status": "todo",
              "detail": "磨豆机清粉、奶管冲洗、地面消毒"
          },
          {
              "id": "k",
              "label": "盘点与对账",
              "kind": "task",
              "time": "22:00–22:20",
              "owner": "店长",
              "status": "todo",
              "detail": "现金 / 平台流水 / 库存差异"
          },
          {
              "id": "l",
              "label": "22:30 闭店上报",
              "kind": "end",
              "status": "todo",
              "detail": "日报发到门店群，异常单独标注"
          }
      ],
      "edges": [
          {
              "from": "s",
              "to": "a"
          },
          {
              "from": "a",
              "to": "b"
          },
          {
              "from": "b",
              "to": "c"
          },
          {
              "from": "c",
              "to": "d",
              "label": "通过"
          },
          {
              "from": "d",
              "to": "e"
          },
          {
              "from": "e",
              "to": "f",
              "label": "超过 8 单"
          },
          {
              "from": "e",
              "to": "g",
              "label": "未超过"
          },
          {
              "from": "f",
              "to": "h"
          },
          {
              "from": "g",
              "to": "h"
          },
          {
              "from": "h",
              "to": "i"
          },
          {
              "from": "i",
              "to": "j"
          },
          {
              "from": "j",
              "to": "k"
          },
          {
              "from": "k",
              "to": "l"
          }
      ]
  };;
  const out = flags.out ? resolve(flags.out) : 'sample.json';
  writeOut(out, JSON.stringify(sample, null, 2) + '\n');
  process.stdout.write('flow: 已写出示例规格 → ' + out + '\n');
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, rest } = parseArgs(argv.slice(1));
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'render') {
    if (!rest[0]) fail('用法：flow.mjs render <spec.json|spec.mmd> [--out x.html] [--svg x.svg] [--mmd x.mmd] [--all]');
    return cmdRender(rest[0], flags);
  }
  if (cmd === 'mermaid') {
    if (!rest[0]) fail('用法：flow.mjs mermaid <spec.json> [--out x.mmd]');
    const spec = normalize(loadSpec(rest[0]));
    const mmd = toMermaid(spec);
    if (flags.out) { writeOut(resolve(flags.out), mmd); process.stdout.write('flow: → ' + resolve(flags.out) + '\n'); }
    else process.stdout.write(mmd);
    return 0;
  }
  if (cmd === 'check') {
    if (!rest[0]) fail('用法：flow.mjs check <spec.json|spec.mmd>');
    return cmdCheck(rest[0]);
  }
  if (cmd === 'preview') return cmdPreview(rest[0], flags);
  if (cmd === 'index') return cmdIndex(rest[0], flags);
  if (cmd === 'sample') return cmdSample(flags);
    if (cmd === 'refresh') {
    return cmdRefresh(rest[0] || '.', flags);
  }
  fail('未知命令：' + cmd + '（可用：render / mermaid / check / index / refresh / preview / sample / help）');
}

const HELP = `flow.mjs — 业务流程 → 两版交互式流程图（竖版适配手机 / 横版适配电脑）+ Mermaid 源码
零依赖、纯离线，不请求任何 CDN。

用法：
  node flow.mjs render  <spec.json|spec.mmd> [--out x.html] [--all] [--svg x.svg] [--mmd x.mmd] [--wrap N] [--debug]
  node flow.mjs refresh <目录>          批量重渲染该目录里所有规格（*.json 含 nodes / *.mmd），并重建清单与首页
  node flow.mjs mermaid <spec.json> [--out x.mmd]
  node flow.mjs check   <spec.json|spec.mmd>
  node flow.mjs preview <流程图.html> [--out 对照预览.html]   # 一页并排看手机/电脑两版
  node flow.mjs index   <目录>                        # 重建清单 + 同步 file:// 静态首页 index.html
  node flow.mjs sample  [--out sample.json]
  node flow.mjs help

输入：
  *.json                 完整规格（title / subtitle / direction / wrap / groups / nodes / edges）
  *.mmd *.mermaid         Mermaid flowchart 子集
  *.md                    自动抽取第一个 \`\`\`mermaid 代码块

输出：
  一个 HTML，内含两个版式，按窗口比例自动选，底部可手动切「竖版 / 横版」：
    · 竖版 portrait   单列纵向，适配手机；宽屏下高度自适应滚动
    · 横版 landscape  长流程自动分栏（可 --wrap N 指定行数），适配电脑一屏
  目录里的「流程索引.json」收录本 skill 生成的全部流程图，
  页面右上角「全部流程图」按钮会弹出抽屉切换（HTTP 打开时自动刷新）。
  --all 额外输出 <名>-竖版.svg / <名>-横版.svg 与 <名>.mmd
  --wrap 0       关闭分栏（横版=竖版）
  --wrap N       横版固定每栏 N 行
  --debug        打印两版的栏数/行数与各栏成员
`;

// 退出码契约：0=成功（check 通过）/ 1=check 发现结构问题 / 2=参数或输入错误
// 注意：main() 是 async（render / index 会 await），裸调用会把返回值与 rejection 都吞掉
main()
  .then((code) => { if (typeof code === 'number') process.exitCode = code; })
  .catch((err) => {
    process.stderr.write('flow: ' + ((err && err.message) || err) + '\n');
    process.exitCode = 2;
  });
