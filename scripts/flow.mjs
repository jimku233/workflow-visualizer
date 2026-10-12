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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, extname, basename, join } from 'node:path';
import { buildHome } from './serve.mjs';

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
function parseMermaid(text) {
  const spec = { title: '', subtitle: '', direction: 'TD', nodes: [], edges: [], groups: [] };
  const nodes = new Map();
  const edges = [];
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

  // 一行里可能有多条语句，用 ; 再切一次
  const lines = String(text).split(/\r?\n/).flatMap((l) => l.split(';'));

  for (let raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;

    let m;
    if ((m = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)?/i.exec(line))) {
      const d = (m[1] || 'TD').toUpperCase();
      spec.direction = d === 'LR' || d === 'RL' ? 'LR' : 'TD';
      continue;
    }
    if (/^(?:classDef|class|style|linkStyle|click|direction)\b/i.test(line)) continue;
    if ((m = /^subgraph\s+(.*)$/i.exec(line))) {
      let label = m[1].trim().replace(/^["']|["']$/g, '');
      const gid = 'g' + (spec.groups.length + 1);
      const g = { id: gid, label, members: [] };
      spec.groups.push(g);
      groupStack.push(g);
      continue;
    }
    if (/^end$/i.test(line)) { groupStack.pop(); continue; }

    // 解析节点/连线交替序列
    const parts = line.split(/\s*(-->|-\.->|==>|---|-\.-|--x|--o)\s*/);
    let pendingLabel = null;
    for (let i = 0; i < parts.length; i += 2) {
      let spec0 = (parts[i] || '').trim();
      const link = i + 1 < parts.length ? parts[i + 1] : null;

      // 连线标签写在下一段开头：-->|有|
      const lm = /^\|([^|]*)\|/.exec(spec0);
      if (lm) { pendingLabel = lm[1].trim(); spec0 = spec0.slice(lm[0].length).trim(); }

      if (spec0) {
        const nm = /^([A-Za-z0-9_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*)\s*(\(\([\s\S]*\)\)|\[\[[\s\S]*\]\]|\{\{[\s\S]*\}\}|\[[\s\S]*\]|\([\s\S]*\)|\{[\s\S]*\})?/.exec(spec0);
        if (nm) {
          const id = nm[1];
          let label;
          const sh = nm[2];
          if (sh) {
            // shape → kind：{} 判断、(( )) 圆（起点/终点，由入出度补全）、其余按普通环节
            const kind =
              sh.startsWith('{') && !sh.startsWith('{{') ? 'decision' :
              sh.startsWith('((') ? 'circle' : 'task';
            label = sh.replace(/^(\(\(|\[\[|\{\{|\[|\(|\{)/, '').replace(/(\)\)|\]\]|\}\}|\]|\)|\})$/, '');
            label = label.trim();
            const q = label[0];
            if ((q === '"' || q === "'") && label.length > 1 && label.endsWith(q)) label = label.slice(1, -1).trim();
            touch(id, label, kind);
          } else {
            touch(id);
          }
          if (i > 0 && parts[i - 1] !== undefined) {
            // 记录连线：上一段的节点 → 本段节点
            const prevSpec = (parts[i - 2] || '').trim();
            const pm = pm0(prevSpec);
            if (pm) {
              edges.push({ from: pm, to: id, label: pendingLabel || undefined, style: styleOf(parts[i - 1]) });
            }
          }
          if (groupStack.length && !groupStack[groupStack.length - 1].members.includes(id)) {
            groupStack[groupStack.length - 1].members.push(id);
          }
          pendingLabel = null;
          continue;
        }
        // 独立成行的裸节点（subgraph 成员）
        const bare = /^([A-Za-z0-9_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*)$/.exec(spec0);
        if (bare) {
          touch(bare[1]);
          if (groupStack.length && !groupStack[groupStack.length - 1].members.includes(bare[1])) {
            groupStack[groupStack.length - 1].members.push(bare[1]);
          }
        }
      }
      void link;
    }
  }

  function pm0(s) {
    const m = /^([A-Za-z0-9_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*)/.exec(s.trim());
    return m ? m[1] : undefined;
  }
  function styleOf(link) {
    if (!link) return 'solid';
    return link.includes('.') ? 'dashed' : 'solid';
  }

  spec.edges = edges;
  return spec;
}

/** 从 .md 中抽出 ```mermaid 代码块；没有就整篇当 mermaid。 */
function extractMermaid(text) {
  const m = /```(?:mermaid)?\s*\n([\s\S]*?)```/.exec(text);
  return m ? m[1] : text;
}

function loadSpec(file) {
  if (!existsSync(file)) fail('输入文件不存在：' + file);
  const text = readFileSync(file, 'utf8');
  const ext = extname(file).toLowerCase();
  if (ext === '.json') {
    try { return JSON.parse(text); } catch (e) { fail('JSON 解析失败：' + e.message); }
  }
  if (ext === '.md' || ext === '.markdown') return parseMermaid(extractMermaid(text));
  return parseMermaid(text);
}

// ─────────────────────────────────────────────────────────────
// 规格归一化 + 校验
// ─────────────────────────────────────────────────────────────

function normalize(specIn) {
  const spec = {
    title: specIn.title || '',
    subtitle: specIn.subtitle || '',
    direction: (specIn.direction || 'TD').toUpperCase() === 'LR' ? 'LR' : 'TD',
    wrap: specIn.wrap === undefined ? 0 : Number(specIn.wrap),
    nodes: [],
    edges: [],
    groups: [],
  };

  const seen = new Set();
  for (const raw of specIn.nodes || []) {
    const id = String(raw.id ?? '').trim();
    if (!id) fail('存在没有 id 的节点');
    if (seen.has(id)) fail('节点 id 重复：' + id);
    seen.add(id);
    let kind = String(raw.kind || '').toLowerCase();
    if (kind === 'subroutine') kind = 'task';
    if (!KINDS.has(kind)) kind = 'task';
    let status = raw.status ? String(raw.status).toLowerCase() : undefined;
    if (status && !STATUSES.has(status)) fail('未知 status：' + status + '（节点 ' + id + '）');
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
  for (const raw of specIn.edges || []) {
    const from = String(raw.from ?? '').trim();
    const to = String(raw.to ?? '').trim();
    if (!ids.has(from)) fail('连线起点不存在：' + from);
    if (!ids.has(to)) fail('连线终点不存在：' + to);
    spec.edges.push({
      from,
      to,
      label: raw.label !== undefined ? String(raw.label) : '',
      style: raw.style === 'dashed' ? 'dashed' : 'solid',
    });
  }

  for (const g of specIn.groups || []) {
    const members = (g.members || []).filter((m) => ids.has(m));
    if (!members.length) continue;
    spec.groups.push({ id: String(g.id || 'g' + spec.groups.length), label: String(g.label || ''), members });
  }

  // 圆形节点若没有入边 = 起点，没有出边 = 终点（Mermaid 里 ((x)) 语义模糊，这里补全）
  const hasIn = new Set(spec.edges.map((e) => e.to));
  const hasOut = new Set(spec.edges.map((e) => e.from));
  for (const n of spec.nodes) {
    if (n.kind === 'start') continue;
    const raw = (specIn.nodes || []).find((r) => String(r.id) === n.id) || {};
    if (String(raw.kind || '').toLowerCase() === 'circle' && !hasIn.has(n.id)) n.kind = 'start';
    else if (String(raw.kind || '').toLowerCase() === 'circle' && !hasOut.has(n.id)) n.kind = 'end';
  }

  if (!spec.nodes.length) fail('没有任何节点');
  return spec;
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
  const { out, inc, back } = analyze(spec);
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
    const a = byIdish(spec, e.from);
    const b = byIdish(spec, e.to);
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
      const n = byIdish(spec, id);
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
      const needW = 26 + (units(label) * 12.4 + 26) + 8 + (textW(members.length + ' 步', 11) + 2);
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

function byIdish(spec, id) {
  return spec.nodes.find((n) => n.id === id);
}

// ─────────────────────────────────────────────────────────────
// SVG 渲染（含内联样式，保证 .svg 单独可用）
// ─────────────────────────────────────────────────────────────

function svgStyle(vid) {
  return `
    svg{--edge:#94a0b3;--edge-soft:#55627a;--edge-dim:#39424f;--grid:#2b3646;--card:#1c2431;
      --hit:#4a9dff;
      --t-label:#f3f6fb;--t-meta:#a3aec2;--t-title:#f7fafd;--t-sub:#a3aec2;
      --n-task:#212a38;--n-task-s:#46536a;--n-dec:#2f2716;--n-dec-s:#c3a044;
      --n-se:#173226;--n-se-s:#4aa06f;--n-risk:#311a1d;--n-risk-s:#b85c60;--n-mile:#1f2839;--n-mile-s:#7c90b8;
      --dot-done:#46c886;--dot-doing:#5aa9ff;--dot-todo:#7b8698;--dot-risk:#f4676c;--dot-hold:#eab24a;--accent:#5aa9ff}
    svg[data-theme='light']{--edge:#7d6c52;--edge-soft:#a8946f;--edge-dim:#b8a37c;--grid:#c6b28e;--card:#fffdf7;
      --hit:#2b7fe0;
      --t-label:#2b2721;--t-meta:#6f6553;--t-title:#221f1a;--t-sub:#6f6553;
      --n-task:#fffdf7;--n-task-s:#8a7448;--n-dec:#fdf3da;--n-dec-s:#a8761a;
      --n-se:#eef7ea;--n-se-s:#3f8556;--n-risk:#fbeae8;--n-risk-s:#b04e4e;--n-mile:#f6f0e3;--n-mile-s:#8f8168;
      --dot-done:#35935f;--dot-doing:#2b7fe0;--dot-todo:#948a78;--dot-risk:#c9424a;--dot-hold:#bd7f16;--accent:#bf6b3a}
    /* 浅色主题在"缩小到看不清"时自动再加深一档线条（笔迹 3.29→4.22、连线 3.71→4.28，只加一档、不跳到深色） */
    svg[data-theme='light'].zoomed-out{--edge:#6f6049;--edge-soft:#8a7550;--edge-dim:#a08a63;
      --n-task-s:#75603c;--n-dec-s:#96691a;--n-se-s:#357a4c;--n-risk-s:#a84848;--n-mile-s:#7f7156}
    .canvas-grid{opacity:.9}
    .grid-dot{fill:var(--grid)}
    .t-accent{fill:var(--accent)}
    .t-title{font:600 21px/1.25 var(--ff);fill:var(--t-title)}
    .t-sub{font:400 12.5px/1.4 var(--ff);fill:var(--t-sub)}
    .node{cursor:pointer}
    .node .node-bg{stroke-width:1.5}
    .node:hover .node-bg{stroke-width:2.3}
    .node.k-task .node-bg,.node.k-milestone .node-bg{fill:var(--n-task);stroke:var(--n-task-s)}
    .node.k-decision .node-bg{fill:var(--n-dec);stroke:var(--n-dec-s)}
    .node.k-start .node-bg,.node.k-end .node-bg{fill:var(--n-se);stroke:var(--n-se-s)}
    .node.k-risk .node-bg{fill:var(--n-risk);stroke:var(--n-risk-s);stroke-dasharray:6 4}
    .node.k-milestone .node-bg{stroke-width:2}
    .node .t-label{font:500 15px/1.35 var(--ff);fill:var(--t-label)}
    .node .t-meta{font:400 11.5px/1.2 var(--ff);fill:var(--t-meta)}
    .node .t-time{font:500 11px/1.2 var(--ff);fill:var(--t-meta)}
    .node .time-pill{fill:var(--card);stroke:var(--edge-soft);stroke-width:1;opacity:.85}
    .node .kind-glyph{font:600 10.5px/1 var(--ff);text-anchor:middle;dominant-baseline:central}
    .node .kind-chip{stroke:none;opacity:.16}
    .node .kind-ring{fill:none;stroke-width:1.2}
    .node .accent{stroke:none}
    .st-done .accent,.st-done .kind-chip{fill:var(--dot-done)} .st-done .kind-ring{stroke:var(--dot-done)} .st-done .kind-glyph{fill:var(--dot-done)}
    .st-doing .accent,.st-doing .kind-chip{fill:var(--dot-doing)} .st-doing .kind-ring{stroke:var(--dot-doing)} .st-doing .kind-glyph{fill:var(--dot-doing)}
    .st-todo .accent,.st-todo .kind-chip{fill:var(--dot-todo)} .st-todo .kind-ring{stroke:var(--dot-todo)} .st-todo .kind-glyph{fill:var(--dot-todo)}
    .st-risk .accent,.st-risk .kind-chip{fill:var(--dot-risk)} .st-risk .kind-ring{stroke:var(--dot-risk)} .st-risk .kind-glyph{fill:var(--dot-risk)}
    .st-hold .accent,.st-hold .kind-chip{fill:var(--dot-hold)} .st-hold .kind-ring{stroke:var(--dot-hold)} .st-hold .kind-glyph{fill:var(--dot-hold)}
    .st-none .accent,.st-none .kind-chip{fill:var(--edge-soft)} .st-none .kind-ring{stroke:var(--edge-soft)} .st-none .kind-glyph{fill:var(--t-meta)}
    .edge{fill:none;stroke:var(--edge);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .edge.dashed{stroke-dasharray:5 5}
    .edge-label-bg{fill:var(--card);stroke:var(--edge-soft);stroke-width:1}
    .edge-label{font:500 11.5px/1.2 var(--ff);fill:var(--t-meta);text-anchor:middle}
    .band-bg{stroke-width:1.2}
    .band-pill{stroke:none;opacity:.16}
    .band-label{font:600 12px/1.2 var(--ff)}
    .band-count{font:400 11px/1.2 var(--ff)}
    .node.is-dim,.edge.is-dim,.edge-label-g.is-dim{opacity:.12}
    /* 缩小到看不清小字时自动"简化"：藏掉药丸/小字/底纹，加粗描边，只留框+标题+线 */
    svg.zoomed-out .time-pill,svg.zoomed-out .t-time,svg.zoomed-out .t-meta{display:none}
    svg.zoomed-out .canvas-grid{display:none}
    svg.zoomed-out .node .node-bg{stroke-width:2.6}
    svg.zoomed-out .node.k-milestone .node-bg{stroke-width:3}
    svg.zoomed-out .node.k-risk .node-bg{stroke-width:2.6;stroke-dasharray:7 5}
    svg.zoomed-out .band-bg{fill-opacity:.05}
    svg.zoomed-out .edge{stroke-width:2.2}
    svg.zoomed-out .edge-label-bg{display:none}
    svg.zoomed-out .edge-label{font-size:13px}
    .node.is-sel .node-bg{stroke-width:2.4;filter:url(#selGlow-${vid})}
    svg[data-theme='light'] .node.is-sel .node-bg{filter:url(#selGlowWarm-${vid})}
    .node.is-hit .node-bg{stroke:var(--hit);stroke-width:2.4}
    .node.is-hit-soft .node-bg{stroke:var(--dot-hold);stroke-width:2.2;stroke-dasharray:5 4}
    .edge.is-hi{stroke:var(--accent);stroke-width:2.4}
    .edge-label-g.is-hi .edge-label{fill:var(--accent)}
    svg[data-hide-status~='done'] .node.st-done,
    svg[data-hide-status~='doing'] .node.st-doing,
    svg[data-hide-status~='todo'] .node.st-todo,
    svg[data-hide-status~='risk'] .node.st-risk,
    svg[data-hide-status~='hold'] .node.st-hold{opacity:.12;filter:grayscale(1)}
  `;
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
      const lw = units(b.label) * 12.4 + 26;
      const cw = textW(countText, 11) + 2;
      // 药丸 + 计数 作为一组在带内水平居中
      const lx = ox + b.x + Math.max(13, (b.w - (lw + 8 + cw)) / 2);
      const ly = oy + b.y + 10;
      parts.push(`<rect class="band-pill" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${lw.toFixed(1)}" height="23" rx="11.5" fill="${b.color}"/>`);
      parts.push(`<text class="band-label" x="${(lx + 13).toFixed(1)}" y="${(ly + 16).toFixed(1)}" fill="${b.color}">${xml(b.label)}</text>`);
      parts.push(`<text class="band-count" x="${(lx + lw + 8).toFixed(1)}" y="${(ly + 16).toFixed(1)}" fill="${b.color}" opacity="0.8">${countText}</text>`);
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

const CLIENT_JS = [
  "(function(){",
  "  'use strict';",
  "  var data=JSON.parse(document.getElementById('flow-data').textContent);",
  "  var meta={}; data.nodes.forEach(function(n){meta[n.id]=n;});",
  "  var statusKeys=[], statusCount={};",
  "  data.nodes.forEach(function(n){ if(!n.status) return; if(!statusCount[n.status]){statusCount[n.status]=0; statusKeys.push(n.status);} statusCount[n.status]++; });",
  "  var hidden={};",
  "  var zoomLabel=document.getElementById('zoom-label');",
  "  // 同一页携带两版布局（竖版/横版）。SVG 的 viewBox 自身会做一次 meet 缩放，",
  "  // 所以每版各自在元素像素空间维护 view{K,TX,TY}，apply 时再反解成 user 单位的 transform。",
  "  var VN=['portrait','landscape'], V={};",
  "  VN.forEach(function(n){",
  "    var s=document.getElementById('flow-svg-'+n);",
  "    if(!s) return;",
  "    var b=s.viewBox.baseVal;",
  "    V[n]={n:n, svg:s, vp:document.getElementById('vp-'+n), vw:b.width, vh:b.height, view:{K:1,TX:0,TY:0}, map:{s:1,cx:0,cy:0}, w:0, h:0};",
  "  });",
  "  var active='portrait', manual=false, sel=null, hits=0, drag=null, lastQuery='', searchHits=null;",
  "  function cur(){ return V[active]||V[VN[0]]; }",
  "  function measure(v){ var r=v.svg.getBoundingClientRect(); if(r.width<2||r.height<2) return false; v.w=r.width; v.h=r.height; v.map.s=Math.min(v.w/v.vw, v.h/v.vh); v.map.cx=(v.w-v.vw*v.map.s)/2; v.map.cy=(v.h-v.vh*v.map.s)/2; return true; }",
  "  function paint(v){ var k=v.view.K/v.map.s, tx=(v.view.TX-v.map.cx)/v.map.s, ty=(v.view.TY-v.map.cy)/v.map.s; v.vp.setAttribute('transform','translate('+tx+','+ty+') scale('+k+')');",
  "    // 屏幕上标题只有几像素时自动简化（隐藏小字与底纹、加粗描边），放大回来自动还原",
  "    v.svg.classList.toggle('zoomed-out', v.view.K*15 < 8.5);",
  "  }",
  "  function paintActive(){ var v=cur(); paint(v); zoomLabel.textContent=Math.round(v.view.K/(v.map.s||1)*100)+'%'; }",
  "  function variantKey(v){ return (V.portrait===v)?'portrait':'landscape'; }",
  "  function rememberZoom(v){ lsSet('flowviz-zoom:'+SELF+':'+variantKey(v), {k:v.view.K, ts:Date.now()}); }",
  "  function fitAll(v){ v=v||cur(); if(!measure(v)) return; v.view.K=v.map.s; v.view.TX=v.map.cx; v.view.TY=v.map.cy; paintActive(); rememberZoom(v); }",
  "  function initial(v){",
  "    v=v||cur(); if(!measure(v)) return;",
  "    var contentAspect=v.vw/v.vh;",
  "    // ?zoom=0.45 固定缩放（截图/检查小比例下的可读性时用），默认仍按下面规则自动选",
  "    var zq=/[?&]zoom=([\\d.]+)/.exec(location.search);",
  "    if(zq&&Number(zq[1])>0){ var Kz=v.map.s*Number(zq[1]); v.view.K=Kz; v.view.TX=(v.w-v.vw*Kz)/2; v.view.TY=16; paintActive(); return; }",
  "    // ?fitcap=2.0 可临时改「竖版默认缩放上限」（默认 1.45 = 整幅适配的 1.45 倍）",
  "    var fc=/[?&]fitcap=([\\d.]+)/.exec(location.search);",
  "    var fcap=(fc&&Number(fc[1])>0)?Number(fc[1]):1.45;",
  "    var kAll=v.map.s, kWidth=v.w/v.vw*0.99, K;",
  "    // 横而扁的图（分栏后的横版）在窄屏上不要宽度撑满，否则会放大到只看得见一角；直接整幅适配",
  "    if(v.w/v.vw <= v.map.s*1.8 || contentAspect > 1.2){ K=kAll; }",
  "    // 竖版长流程：铺满宽度一屏只能看到四五个环节，所以给个上限（手机上更想先看清整体走向）",
  "    else { K=Math.min(kWidth, kAll*fcap); }",
  "    var zk=lsGet('flowviz-zoom:'+SELF+':'+variantKey(v));   // 上次手动缩放过的档位（换文件各记各的）",
  "    if(zk&&zk.k>0) K=Math.min(kAll*10, Math.max(kAll*0.08, zk.k));",
  "    v.view.K=K;",
  "    v.view.TX=(v.w-v.vw*K)/2;",
  "    v.view.TY=(v.vh*K<=v.h)?(v.h-v.vh*K)/2:16;",   // 一屏装得下就垂直居中，装不下就从顶部开始",
  "    paintActive();",
  "  }",
  "  function zoomAt(v,mx,my,f){ if(!measure(v)) return; var K=Math.min(v.map.s*10, Math.max(v.map.s*0.08, v.view.K*f)); var s=K/v.view.K; v.view.TX=mx-(mx-v.view.TX)*s; v.view.TY=my-(my-v.view.TY)*s; v.view.K=K; paintActive(); rememberZoom(v); }",
  "  function zoomBy(f){ var v=cur(); if(!measure(v)) return; zoomAt(v, v.w/2, v.h/2, f); }",
  "  function autoVariant(){ var w=window.innerWidth, h=window.innerHeight; return (w<760 || w/h<1.08) ? 'portrait' : 'landscape'; }",
  "  function setVariant(name, refit, byUser){",
  "    if(!V[name]) return;",
  "    if(byUser) manual=true;",
  "    active=name;",
  "    document.getElementById('canvas').setAttribute('data-show', name);",
  "    document.querySelectorAll('[data-variant-btn]').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-variant-btn')===name); });",
  "    if(refit) initial(); else { measure(cur()); paintActive(); }",
  "  }",
  "  window.addEventListener('resize',function(){",
  "    if(!manual){ var a=autoVariant(); if(a!==active){ setVariant(a,true); return; } }",
  "    initial();",
  "  });",
  "  function touchDist(e){ var a=e.touches[0], b=e.touches[1]; return Math.sqrt((a.clientX-b.clientX)*(a.clientX-b.clientX)+(a.clientY-b.clientY)*(a.clientY-b.clientY)); }",
  "  VN.forEach(function(n){",
  "    var v=V[n]; if(!v) return;",
  "    var pinch=null;",
  "    v.svg.addEventListener('wheel',function(e){ e.preventDefault(); var r=v.svg.getBoundingClientRect(); zoomAt(v, e.clientX-r.left, e.clientY-r.top, e.deltaY<0?1.12:1/1.12); },{passive:false});",
  "    v.svg.addEventListener('mousedown',function(e){ drag={n:n,x:e.clientX,y:e.clientY,ox:v.view.TX,oy:v.view.TY,moved:false}; });",
  "    v.svg.addEventListener('dblclick',function(e){ if(!(e.target.closest&&e.target.closest('.node'))) fitAll(v); });",
  "    // 触屏：单指平移 / 双指缩放 / 轻点选中（手机上没有鼠标事件，必须单独处理）",
  "    v.svg.addEventListener('touchstart',function(e){",
  "      if(e.touches.length===1){ pinch=null; drag={n:n,x:e.touches[0].clientX,y:e.touches[0].clientY,ox:v.view.TX,oy:v.view.TY,moved:false}; }",
  "      else if(e.touches.length===2){ drag=null; pinch={d:touchDist(e)}; }",
  "    },{passive:true});",
  "    v.svg.addEventListener('touchmove',function(e){",
  "      if(e.touches.length===2){",
  "        if(!measure(v)) return;",
  "        var r=v.svg.getBoundingClientRect();",
  "        var d=touchDist(e);",
  "        if(pinch&&pinch.d>0) zoomAt(v, (e.touches[0].clientX+e.touches[1].clientX)/2-r.left, (e.touches[0].clientY+e.touches[1].clientY)/2-r.top, d/pinch.d);",
  "        pinch={d:d}; e.preventDefault(); return;",
  "      }",
  "      if(drag&&drag.n===n&&e.touches.length===1){",
  "        var t=e.touches[0], dx=t.clientX-drag.x, dy=t.clientY-drag.y;",
  "        if(Math.abs(dx)+Math.abs(dy)>6) drag.moved=true;",
  "        v.view.TX=drag.ox+dx; v.view.TY=drag.oy+dy; paintActive(); e.preventDefault();",
  "      }",
  "    },{passive:false});",
  "    v.svg.addEventListener('touchend',function(e){",
  "      if(drag&&drag.n===n&&!drag.moved&&e.changedTouches.length){",
  "        var t=e.changedTouches[0], el=document.elementFromPoint(t.clientX,t.clientY);",
  "        var g=el&&el.closest?el.closest('.node'):null;",
  "        if(g) select(g.getAttribute('data-id')); else select(null);",
  "      }",
  "      if(!e.touches.length){ drag=null; pinch=null; }",
  "    });",
  "  });",
  "  window.addEventListener('mousemove',function(e){ if(!drag) return; var v=V[drag.n]; var dx=e.clientX-drag.x, dy=e.clientY-drag.y; if(Math.abs(dx)+Math.abs(dy)>3) drag.moved=true; v.view.TX=drag.ox+dx; v.view.TY=drag.oy+dy; paintActive(); });",
  "  window.addEventListener('mouseup',function(e){",
  "    if(drag&&!drag.moved&&drag.n===active){ var g=e.target.closest?e.target.closest('.node'):null; if(g) select(g.getAttribute('data-id')); else if(e.target.closest&&e.target.closest('svg')) select(null); }",
  "    drag=null;",
  "  });",
  "  function esc(s){ return String(s==null?'':s).replace(/[&<>\"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]; }); }",
  "  function eachSvg(fn){ VN.forEach(function(n){ if(V[n]) fn(V[n].svg, n); }); }",
  "  function relayout(){ VN.forEach(function(n){ if(V[n]) measure(V[n]); }); paintActive(); }",
  "  function setPanel(open){ document.body.classList.toggle('panel-open', !!open); relayout(); }",
  "  function select(id){",
  "    sel=id;",
  "    if(id) setPanel(true); else if(document.body.classList.contains('panel-open') && window.innerWidth<=600) setPanel(false);",
  "    eachSvg(function(s,n){",
  "      s.querySelectorAll('.node').forEach(function(x){ x.classList.remove('is-sel','is-dim'); });",
  "      s.querySelectorAll('.edge').forEach(function(p){ p.classList.remove('is-hi','is-dim'); p.setAttribute('marker-end','url(#arrow-'+n+')'); });",
  "      s.querySelectorAll('.edge-label-g').forEach(function(p){ p.classList.remove('is-hi','is-dim'); });",
  "    });",
  "    if(!id){ renderPanel(null); return; }",
  "    eachSvg(function(s,n){",
  "      s.querySelectorAll('.node').forEach(function(x){ if(x.getAttribute('data-id')!==id) x.classList.add('is-dim'); });",
  "      var g=s.querySelector('.node[data-id=\"'+CSS.escape(id)+'\"]'); if(g) g.classList.add('is-sel');",
  "      s.querySelectorAll('.edge').forEach(function(p){ var a=p.getAttribute('data-from'),b=p.getAttribute('data-to'); if(a===id||b===id){ p.classList.add('is-hi'); p.setAttribute('marker-end','url(#arrow-hi-'+n+')'); } else p.classList.add('is-dim'); });",
  "      s.querySelectorAll('.edge-label-g').forEach(function(p){ var a=p.getAttribute('data-from'),b=p.getAttribute('data-to'); if(a===id||b===id) p.classList.add('is-hi'); else p.classList.add('is-dim'); });",
  "    });",
  "    renderPanel(meta[id]);",
  "  }",
  "  function renderOverview(){",
  "    var el=document.getElementById('detail');",
  "    var h='<div class=\"ov-kicker\">流程概览</div>';",
  "    if(searchHits&&searchHits.length){",
  "      h='<div class=\"hit-head\"><span class=\"sec\" style=\"margin:0\">搜索「'+esc(lastQuery)+'」命中 '+searchHits.length+' 处</span>';",
  "      h+='<span class=\"hit-nav\"><button data-hit-nav=\"-1\" title=\"上一个（↑ / Shift+Enter）\">↑</button>';",
  "      h+='<span class=\"hit-pos\">'+(hitIdx+1)+'/'+searchHits.length+'</span>';",
  "      h+='<button data-hit-nav=\"1\" title=\"下一个（↓ / Enter）\">↓</button></span></div>';",
  "      h+='<div class=\"hit-tip only-pc\">键盘 ↑ ↓（或 Enter / Shift+Enter）连着翻命中，Esc 清空</div>';",
  "      h+='<div class=\"hits\">'+searchHits.map(hitRow).join('')+'</div>';",
  "      h+='<label class=\"focus-toggle\"><input type=\"checkbox\" id=\"focus-on\"'+(focusOn?' checked':'')+'> 自动聚焦命中</label>';",
  "      h+='<div class=\"sec\">流程概览</div>';",
  "    }",
  "    h+='<h2 class=\"ov-title\">'+esc(data.title||'未命名流程')+'</h2>';",
  "    if(data.subtitle) h+='<p class=\"ov-sub\">'+esc(data.subtitle)+'</p>';",
  "    h+='<div class=\"stats\"><div class=\"stat\"><b>'+data.nodes.length+'</b><span>环节</span></div><div class=\"stat\"><b>'+data.edges.length+'</b><span>连接</span></div><div class=\"stat\"><b>'+data.groups.length+'</b><span>分组</span></div></div>';",
  "    if(statusKeys.length){",
  "      h+='<div class=\"sec\">按状态筛选</div><div class=\"pillcol\">';",
  "      statusKeys.forEach(function(s){ h+='<button class=\"ov-status'+(hidden[s]?' off':'')+'\" data-status=\"'+s+'\"><i class=\"dot st-'+s+'\"></i><span>'+esc(labelOf(s))+'</span><em>'+statusCount[s]+'</em></button>'; });",
  "      h+='</div>';",
  "    }",
  "    var focus=data.nodes.filter(function(n){ return n.status==='risk'||n.status==='hold'; });",
  "    if(focus.length){",
  "      h+='<div class=\"sec\">需关注（点击定位）</div>';",
  "      focus.forEach(function(n){ h+='<button class=\"ov-focus\" data-goto=\"'+esc(n.id)+'\"><span class=\"of-dot st-'+esc(n.status)+'\"></span><span class=\"of-label\">'+esc(n.label)+'</span><em>'+esc(n.statusLabel)+'</em></button>'; });",
  "    }",
  "    h+='<div class=\"sec\">图例</div><div class=\"klegend\">'+data.kinds.map(function(k){ return '<span class=\"kchip k-'+k.key+'\">'+esc(k.label)+'</span>'; }).join('')+'</div>';",
  "    h+='<p class=\"hint\"><span class=\"only-pc\">点节点看详情 · 滚轮缩放 · 拖拽平移 · 双击空白适配 · 搜索后 ↑↓ 翻命中 · Esc 取消选中</span><span class=\"only-touch\">点环节看详情 · 单指拖动 · 双指缩放 · 底部按钮可切竖/横版</span></p>';",
  "    el.innerHTML=h;",
  "    el.querySelectorAll('.ov-status').forEach(function(b){ b.onclick=function(){ toggleStatus(b.getAttribute('data-status')); }; });",
  "    el.querySelectorAll('[data-goto]').forEach(function(b){ b.onclick=function(){ select(b.getAttribute('data-goto')); }; });",
  "    el.querySelectorAll('[data-hit]').forEach(function(b){ b.onclick=function(){ hitIdx=Number(b.getAttribute('data-hit'))||0; focusHits(); renderPanel(null); }; });",
  "    el.querySelectorAll('[data-hit-nav]').forEach(function(b){ b.onclick=function(){ jumpHit(Number(b.getAttribute('data-hit-nav'))); }; });",
  "    var fo=document.getElementById('focus-on');",
  "    if(fo) fo.onchange=function(){ focusOn=fo.checked; if(focusOn) focusHits(); };",
  "  }",
  "  function labelOf(s){ return data.statusLabels[s]||s; }",
  "  function renderPanel(n){",
  "    var el=document.getElementById('detail');",
  "    if(!n){ renderOverview(); return; }",
  "    var h='<button class=\"back\" id=\"panel-back\">← 返回概览</button>';",
  "    h+='<div class=\"d-id\">'+esc(n.id)+'</div>';",
  "    h+='<h2 class=\"d-title\">'+esc(n.label)+'</h2>';",
  "    h+='<div class=\"chips\"><span class=\"chip k-'+esc(n.kind)+'\">'+esc(n.kindLabel||n.kind)+'</span>';",
  "    if(n.status) h+='<span class=\"chip st-'+esc(n.status)+'\"><i class=\"dot st-'+esc(n.status)+'\"></i>'+esc(n.statusLabel||n.status)+'</span>';",
  "    h+='</div>';",
  "    if(n.time) h+='<div class=\"kv\"><b>时间</b><span>'+esc(n.time)+'</span></div>';",
  "    if(n.owner) h+='<div class=\"kv\"><b>负责</b><span>'+esc(n.owner)+'</span></div>';",
  "    if(n.detail) h+='<div class=\"kv\"><b>说明</b><span>'+esc(n.detail).replace(/\\n/g,'<br>')+'</span></div>';",
  "    if(n.note) h+='<div class=\"kv note\"><b>注意</b><span>'+esc(n.note).replace(/\\n/g,'<br>')+'</span></div>';",
  "    h+='<div class=\"kv\"><b>上游</b><span>'+(n.preds.length?n.preds.map(linkOf).join(' '):'—')+'</span></div>';",
  "    h+='<div class=\"kv\"><b>下游</b><span>'+(n.succs.length?n.succs.map(linkOf).join(' '):'—')+'</span></div>';",
  "    el.innerHTML=h;",
  "    var b=document.getElementById('panel-back'); if(b) b.onclick=function(){ select(null); };",
  "    el.querySelectorAll('[data-goto]').forEach(function(x){ x.onclick=function(){ select(x.getAttribute('data-goto')); }; });",
  "  }",
  "  function linkOf(id){ var n=meta[id]; var t=n?n.label:id; return '<button class=\"jump\" data-goto=\"'+esc(id)+'\" title=\"'+esc(id)+'\">'+esc(t)+'</button>'; }",
  "  function toggleStatus(s){ if(hidden[s]){ delete hidden[s]; } else { hidden[s]=1; } applyFilter(); }",
  "  function applyFilter(){",
  "    eachSvg(function(s){ s.setAttribute('data-hide-status', Object.keys(hidden).join(' ')); });",
  "    document.querySelectorAll('.legend button').forEach(function(b){ if(hidden[b.getAttribute('data-status')]) b.classList.add('off'); else b.classList.remove('off'); });",
  "    if(!sel) renderOverview();",
  "  }",
  "  document.querySelectorAll('.legend button').forEach(function(b){ b.onclick=function(){ toggleStatus(b.getAttribute('data-status')); }; });",
  "  document.querySelectorAll('[data-variant-btn]').forEach(function(b){ b.onclick=function(){ setVariant(b.getAttribute('data-variant-btn'), true, true); }; });",
  "  document.getElementById('zoom-in').onclick=function(){ zoomBy(1.2); };",
  "  document.getElementById('zoom-out').onclick=function(){ zoomBy(1/1.2); };",
  "  document.getElementById('zoom-fit').onclick=function(){ fitAll(); };",
  "  var panelBtn=document.getElementById('panel-toggle');",
  "  if(panelBtn) panelBtn.onclick=function(){ var open=!document.body.classList.contains('panel-open'); setPanel(open); if(open) renderPanel(sel ? meta[sel] : null); };",
  "  var hitIdx=0, focusOn=true;",
  "  document.getElementById('search').addEventListener('input',function(e){",
  "    var q=e.target.value.trim().toLowerCase(); lastQuery=q; hits=0; hitIdx=0;",
  "    var shownSet={}, softSet={}, order=[];",
  "    eachSvg(function(s){",
  "      s.classList.toggle('searching', !!q);",
  "      s.querySelectorAll('.node').forEach(function(g){",
  "        var n=meta[g.getAttribute('data-id')]||{};",
  "        g.classList.remove('is-hit','is-hit-soft');",
  "        if(!q) return;",
  "        var shown=[n.label,n.id,n.time,n.owner].join(' ').toLowerCase();",
  "        var rest=[n.detail,n.note].join(' ').toLowerCase();",
  "        if(shown.indexOf(q)>=0){ g.classList.add('is-hit'); if(!shownSet[n.id]){ shownSet[n.id]=1; order.push(n.id); } }",
  "        else if(rest.indexOf(q)>=0){ g.classList.add('is-hit-soft'); if(!shownSet[n.id]&&!softSet[n.id]){ softSet[n.id]=1; order.push(n.id); } }",
  "      });",
  "    });",
  "    hits=order.length;",
  "    searchHits=q?order:null;",
  "    var softOnly=Object.keys(softSet).filter(function(id){ return !shownSet[id]; }).length;",
  "    document.getElementById('search-count').textContent=q?(hits+' 个匹配'+(softOnly?'（'+softOnly+' 个只在说明/备注里）':'')):'';",
  "    // 手机端结果清单默认藏在收起的抽屉里，搜到东西就自动弹出来（这是'搜了等于没提示'的根因）",
  "    if(q&&hits>0&&!sel) setPanel(true);",
  "    if(!sel) renderPanel(null);",
  "    if(q&&hits>0&&focusOn) focusHits();",
  "  });",
  "  // 节点在画布(user)坐标系里的矩形。注意 getBBox() 返回的是节点自身局部坐标（0,0~w,h），",
  "  // 必须再加上该 <g> 的 translate(x,y)，否则聚焦会跳到画布左上角附近（踩过）。",
  "  function nodeBox(g){",
  "    var bb=g.getBBox();",
  "    var m=/translate\\(\\s*([-\\d.]+)[ ,]+([-\\d.]+)/.exec(g.getAttribute('transform')||'');",
  "    var tx=m?parseFloat(m[1]):0, ty=m?parseFloat(m[2]):0;",
  "    return {x:tx+bb.x, y:ty+bb.y, w:bb.width, h:bb.height};",
  "  }",
  "  function hitBox(ids){",
  "    var svg=cur().svg, x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;",
  "    ids.forEach(function(id){ var g=svg.querySelector('.node[data-id=\"'+CSS.escape(id)+'\"]'); if(!g) return;",
  "      var b=nodeBox(g); x0=Math.min(x0,b.x); y0=Math.min(y0,b.y); x1=Math.max(x1,b.x+b.w); y1=Math.max(y1,b.y+b.h); });",
  "    return isFinite(x0)?{x0:x0,y0:y0,x1:x1,y1:y1}:null;",
  "  }",
  "  function animateVp(){ var v=cur(); v.vp.classList.add('vp-anim'); clearTimeout(v._animT); v._animT=setTimeout(function(){ v.vp.classList.remove('vp-anim'); },320); }",
  "  function centerOn(id,scale){",
  "    var v=cur(); if(!measure(v)) return;",
  "    var g=v.svg.querySelector('.node[data-id=\"'+CSS.escape(id)+'\"]'); if(!g) return;",
  "    var b=nodeBox(g); var K=(scale||v.view.K);",
  "    animateVp();",
  "    v.view.K=K;",
  "    v.view.TX=v.w/2-((b.x+b.w/2)*K);",
  "    v.view.TY=v.h/2-((b.y+b.h/2)*K);",
  "    paintActive();",
  "  }",
  "  function focusHits(){",
  "    if(!searchHits||!searchHits.length) return;",
  "    var v=cur(); if(!measure(v)) return;",
  "    var box=hitBox(searchHits); if(!box) return;",
  "    var bw=box.x1-box.x0, bh=box.y1-box.y0;",
  "    var pad=90;",
  "    var kFit=Math.min((v.w-pad*2)/Math.max(bw,1), (v.h-pad*2)/Math.max(bh,1));",
  "    // 命中离得太远时不要为了'全都装下'把字缩没：低于当前 60% 就只居中到当前命中",
  "    if(searchHits.length===1 || kFit>=v.view.K*0.6){",
  "      var K=Math.min(kFit, v.view.K*2.2);",
  "      animateVp();",
  "      v.view.K=K;",
  "      v.view.TX=v.w/2-((box.x0+bw/2)*K);",
  "      v.view.TY=v.h/2-((box.y0+bh/2)*K);",
  "      paintActive();",
  "    } else {",
  "      centerOn(searchHits[hitIdx]||searchHits[0], v.view.K);",
  "    }",
  "  }",
  "  function jumpHit(d){",
  "    if(!searchHits||!searchHits.length) return;",
  "    hitIdx=(hitIdx+d+searchHits.length)%searchHits.length;",
  "    focusHits();",
  "    centerOn(searchHits[hitIdx], cur().view.K);",
  "    if(!sel) renderPanel(null);",
  "    else select(searchHits[hitIdx]);",
  "    var row=document.querySelector('.hit-row.cur');",
  "    if(row&&row.scrollIntoView) row.scrollIntoView({block:'nearest'});",
  "  }",
  "  document.getElementById('search').addEventListener('keydown',function(e){",
  "    if(e.key==='ArrowDown'){ e.preventDefault(); jumpHit(1); }",
  "    else if(e.key==='ArrowUp'){ e.preventDefault(); jumpHit(-1); }",
  "    else if(e.key==='Enter'){ e.preventDefault(); jumpHit(e.shiftKey?-1:1); }",
  "    else if(e.key==='Escape'){ e.target.value=''; e.target.dispatchEvent(new Event('input')); e.target.blur(); }",
  "  });",
  "  function mark(text,q){ var i=String(text).toLowerCase().indexOf(q); if(i<0) return esc(text); return esc(String(text).slice(0,i))+'<mark>'+esc(String(text).slice(i,i+q.length))+'</mark>'+esc(String(text).slice(i+q.length)); }",
  "  function hitRow(id,i){",
  "    var n=meta[id]||{}, q=lastQuery;",
  "    var fields=[['标题',n.label],['id',n.id],['时间',n.time],['负责',n.owner],['说明',n.detail],['注意',n.note]];",
  "    var field='标题', text=n.label||'', soft=false;",
  "    for(var k=0;k<fields.length;k++){",
  "      var v=fields[k][1]||'';",
  "      if(String(v).toLowerCase().indexOf(q)>=0){ field=fields[k][0]; text=v; soft=(field==='说明'||field==='注意'); break; }",
  "    }",
  "    var idx=String(text).toLowerCase().indexOf(q);",
  "    var snip=(idx>26?'…':'')+String(text).slice(Math.max(0,idx-22), Math.max(0,idx-22)+54);",
  "    return '<button class=\"hit-row'+(soft?' soft':'')+(i===hitIdx?' cur':'')+'\" data-hit=\"'+i+'\"><span class=\"hr-n\">'+(i+1)+'</span>'",
  "      +'<span class=\"hr-main\"><span class=\"hr-label\">'+esc(n.label||id)+'<em>'+field+'</em></span>'",
  "      +'<span class=\"hr-snip\">'+mark(snip,q)+'</span></span></button>';",
  "  }",
  "  /* ── 全部流程图抽屉 ── */",
  "  var flows=(data.flows||[]).slice(), selfFile=data.selfFile||'';",
  "  function renderFlows(){",
  "    var el=document.getElementById('flows-list');",
  "    if(!flows.length){ el.innerHTML='<p class=\"hint\">同目录下还没找到其它由本 skill 生成的流程图。</p>'; return; }",
  "    el.innerHTML=flows.map(function(f){",
  "      var cur=(f.file===selfFile);",
  "      // 当前页不是链接：误点也不会原地不动，让人以为坏了",
  "      if(cur) return '<div class=\"flow-row cur\"><span class=\"fr-name\">'+esc(f.title||f.file)+'<span class=\"fr-cur\">当前</span></span>'",
  "        +'<span class=\"fr-meta\">'+f.nodes+' 环节 · '+f.edges+' 连接 · '+esc(f.mtime||'')+'</span></div>';",
  "      return '<a class=\"flow-row\" href=\"'+encodeURI(f.file)+'\"><span class=\"fr-name\">'+esc(f.title||f.file)+'</span>'",
  "        +'<span class=\"fr-meta\">'+f.nodes+' 环节 · '+f.edges+' 连接 · '+esc(f.mtime||'')+'</span></a>';",
  "    }).join('');",
  "  }",
  "  function openFlows(open){",
  "    document.getElementById('flows-drawer').classList.toggle('open', !!open);",
  "    document.getElementById('drawer-scrim').classList.toggle('open', !!open);",
  "    if(open){ renderFlows(); refreshFlows(); }",
  "  }",
  "  function refreshFlows(){",
  "    if(location.protocol.indexOf('http')!==0) return;",
  "    fetch('流程索引.json?t='+Date.now()).then(function(r){ return r.ok?r.json():null; }).then(function(j){",
  "      if(j&&j.flows&&j.flows.length){ flows=j.flows; renderFlows(); }",
  "    }).catch(function(){});",
  "  }",
  "  document.getElementById('flows-toggle').onclick=function(){ openFlows(true); };",
  "  document.getElementById('flows-close').onclick=function(){ openFlows(false); };",
  "  document.getElementById('drawer-scrim').onclick=function(){ openFlows(false); };",
  "  function download(name,blob){ var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },1500); }",
  "  function variantTag(){ return active==='portrait' ? '-竖版' : '-横版'; }",
  "  function svgSource(){ var v=cur(); var c=v.svg.cloneNode(true); c.setAttribute('xmlns','http://www.w3.org/2000/svg'); c.removeAttribute('id'); return '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n'+c.outerHTML; }",
  "  document.getElementById('export-svg').onclick=function(){ download(data.slug+variantTag()+'.svg', new Blob([svgSource()],{type:'image/svg+xml'})); };",
  "  document.getElementById('export-png').onclick=function(){",
  "    var v=cur(); var src=svgSource(); var img=new Image(); var scale=2;",
  "    img.onload=function(){ var cv=document.createElement('canvas'); cv.width=v.vw*scale; cv.height=v.vh*scale; var cx=cv.getContext('2d'); cx.fillStyle=(document.documentElement.getAttribute('data-theme')==='light')?'#edf1f7':'#0e1116'; cx.fillRect(0,0,cv.width,cv.height); cx.drawImage(img,0,0,cv.width,cv.height); cv.toBlob(function(b){ if(b) download(data.slug+variantTag()+'.png',b); }); };",
  "    img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(src);",
  "  };",
  // 主题 + 锁定：总设置 / 单张图 / 锁定，三者时间戳比较，后改的优先
  "  var THEME_KEY='flowviz-theme', SELF=data.selfFile||decodeURIComponent(location.pathname.split('/').pop());",
  "  function lsGet(k){ try{ var v=localStorage.getItem(k); if(!v) return null; try{ return JSON.parse(v); }catch(e){ return {mode:v,ts:0}; } }catch(e){ return null; } }",
  "  function lsSet(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }",
  "  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }",
  "  function globalPref(){ return lsGet(THEME_KEY)||{mode:'system',ts:0}; }",
  "  function selfPref(){ return lsGet(THEME_KEY+':'+SELF); }",
  "  function lockPref(){ return lsGet('flowviz-lock:'+SELF); }",
  "  function systemTheme(){ return (window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'; }",
  "  function effective(){",
  "    var lock=lockPref(); if(lock&&lock.locked) return {mode:lock.mode, src:'locked'};",
  "    var g=globalPref(), p=selfPref();",
  "    if(p&&p.ts>(g.ts||0)) return {mode:p.mode, src:'self'};",
  "    return {mode:g.mode||'system', src:'global'};",
  "  }",
  "  var toastTimer=null;",
  "  function toast(msg){",
  "    var el=document.getElementById('toast'); if(!el) return;",
  "    el.textContent=msg; el.classList.add('show');",
  "    if(toastTimer) clearTimeout(toastTimer);",
  "    toastTimer=setTimeout(function(){ el.classList.remove('show'); },2800);",
  "  }",
  "  function modeLabel(e){ return e.src==='locked' ? '已锁定' : (e.mode==='system'?'跟随系统':(e.mode==='dark'?'深色':'浅色')) + (e.src==='self'?'（这张图单独设的）':'（跟着首页「外观」设置）'); }",
  "  function applyTheme(){",
  "    var e=effective(); var d=(e.mode==='system')?systemTheme():e.mode;",
  "    document.documentElement.setAttribute('data-theme',d);",
  "    eachSvg(function(s){ s.setAttribute('data-theme',d); });",
  "    var locked=(e.src==='locked');",
  "    var lb=document.getElementById('lock');",
  "    if(lb){ lb.classList.toggle('on',locked); lb.title=locked?'这张图的颜色已锁定，点一下解锁':'锁定这张图的颜色（锁定后首页「外观」改不动它）';",
  "      var sp=lb.querySelector('span'); if(sp) sp.textContent=locked?'已锁定':'锁定颜色'; }",
  "    var b=document.getElementById('theme');",
  "    if(b){ b.classList.toggle('locked',locked); b.title=locked?'颜色已锁定：先点「锁定颜色」解锁，才能改':('当前：'+modeLabel(e)+'　点一下在这张图上切明/暗'); }",
  "  }",
  "  document.getElementById('theme').onclick=function(){",
  "    var e=effective();",
  "    if(e.src==='locked'){ toast('这张图的颜色已锁定，先点「锁定颜色」解锁'); return; }",
  "    var next=(document.documentElement.getAttribute('data-theme')==='light')?'dark':'light';",
  "    lsSet(THEME_KEY+':'+SELF,{mode:next,ts:Date.now()});",
  "    applyTheme();",
  "    toast('这张图已设为'+(next==='light'?'浅色':'深色')+'（后改的优先；改首页「显示设置」会再覆盖它）');",
  "  };",
  "  // 本地文件模式（双击打开）下浏览器只给纯文件名目录列表，所以指向生成的静态首页",
  "  var homeBtn=document.getElementById('home-btn');",
  "  if(homeBtn && location.protocol==='file:') homeBtn.setAttribute('href','./index.html');",
  "  var lockBtn=document.getElementById('lock');",
  "  if(lockBtn) lockBtn.onclick=function(){",
  "    var lock=lockPref();",
  "    if(lock&&lock.locked){ lsDel('flowviz-lock:'+SELF); toast('已解锁：这张图重新跟着首页「外观」走'); }",
  "    else { var cur=document.documentElement.getAttribute('data-theme'); lsSet('flowviz-lock:'+SELF,{locked:true,mode:cur,ts:Date.now()}); toast('已锁定当前颜色：改总设置或别处的颜色都不会影响这张图'); }",
  "    applyTheme();",
  "  };",
  "  if(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').addEventListener){",
  "    matchMedia('(prefers-color-scheme: light)').addEventListener('change',function(){ applyTheme(); });",
  "  }",
  "  applyTheme();",
  "  document.getElementById('mmd-toggle').onclick=function(){ document.getElementById('mmd-panel').classList.toggle('open'); };",
  "  document.getElementById('mmd-copy').onclick=function(){ var t=document.getElementById('mmd-src'); t.select(); var b=this; try{ document.execCommand('copy'); b.textContent='已复制'; }catch(err){ b.textContent='请手动复制'; } setTimeout(function(){ b.textContent='复制'; },1500); };",
  "  window.addEventListener('keydown',function(e){",
  "    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;",
  "    // 搜索出结果后，焦点不在输入框里（比如刚点过某条命中）也能用 ↑↓ 连续翻看",
  "    if((e.key==='ArrowDown'||e.key==='ArrowUp')&&searchHits&&searchHits.length){ e.preventDefault(); jumpHit(e.key==='ArrowDown'?1:-1); return; }",
  "    if(e.key==='+'||e.key==='='){ zoomBy(1.2); }",
  "    if(e.key==='-'){ zoomBy(1/1.2); }",
  "    if(e.key==='0'){ fitAll(); }",
  "    if(e.key==='Escape'){ select(null); }",
  "  });",
  "  setVariant(autoVariant(), true);",
  "  renderPanel(null);",
  "})();",
].join('\n');

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
  const ICON = {
    out: '<path d="M3 8h10"/>',
    in: '<path d="M3 8h10M8 3v10"/>',
    fit: '<path d="M3 6.5V3h3.5M13 9.5V13H9.5M10 3h3v3.5M6 13H3V9.5"/>',
    down: '<path d="M8 2.5v7.5M5.2 7.4L8 10.2l2.8-2.8M2.8 12.6h10.4"/>',
    theme: '<path d="M8 2.6a5.4 5.4 0 100 10.8A5.4 5.4 0 008 2.6z"/><path d="M8 2.6v10.8"/>',
    code: '<path d="M6.2 4.4L3 8l3.2 3.6M9.8 4.4L13 8l-3.2 3.6"/>',
    search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="M10.4 10.4L13.6 13.6"/>',
    phone: '<rect x="4.6" y="2.2" width="6.8" height="11.6" rx="1.6"/><path d="M7.4 11.6h1.2"/>',
    monitor: '<rect x="2.2" y="3" width="11.6" height="8" rx="1.4"/><path d="M6 13.4h4M8 11v2.4"/>',
    panel: '<rect x="2.4" y="3" width="11.2" height="10" rx="1.4"/><path d="M9.6 3v10"/>',
    layers: '<path d="M8 2.4l5.6 3-5.6 3-5.6-3z"/><path d="M2.4 8.6l5.6 3 5.6-3M2.4 11.6l5.6 3 5.6-3"/>',
    home: '<path d="M2.6 7.4L8 2.8l5.4 4.6"/><path d="M4.2 7.2v5.9h7.6V7.2"/><path d="M6.8 13.1V9.6h2.4v3.5"/>',
    lockOpen: '<rect x="3.4" y="7.2" width="9.2" height="6.6" rx="1.4"/><path d="M5.6 7.2V5.4a2.4 2.4 0 014.8 0v1.8"/>',
    lockClosed: '<rect x="3.4" y="7.2" width="9.2" height="6.6" rx="1.4"/><path d="M5.6 7.2V5.4a2.4 2.4 0 014.8 0"/><path d="M8 9.6v2"/>',
  };
  const iconBtn = (id, label, path, extraClass = '') =>
    `<button id="${id}" class="icon-btn${extraClass ? ' ' + extraClass : ''}" title="${label}"><svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg><span>${label}</span></button>`;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark" data-flow-viz="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="flow-viz" content="1">
<meta name="flow-title" content="${xml(spec.title || '')}">
<meta name="flow-stats" content="${xml(stats)}">
<title>${xml(spec.title || '工作流图')}</title>
<script>
/* 主题引导：必须在首帧前跑，否则会闪一下深色。
   规则（后改的优先，与页面里 JS 完全一致）：
     flowviz-theme          = {mode:'system|dark|light', ts}   总设置（首页「显示设置」写）
     flowviz-theme:<文件名>  = {mode:'dark|light', ts}          单张图（页面上的明暗键写）
     flowviz-lock:<文件名>   = {locked:true, mode:'dark|light'} 锁定后冻结该图颜色
   有效值：锁定 → 冻结值；否则比较两张表的时间戳，谁新听谁的。*/
(function(){try{
  var SELF=decodeURIComponent(location.pathname.split('/').pop());
  function g(k){ var v=localStorage.getItem(k); if(!v) return null; try{ return JSON.parse(v); }catch(e){ return {mode:v,ts:0}; } }
  var lock=g('flowviz-lock:'+SELF), mode;
  if(lock&&lock.locked) mode=lock.mode;
  else {
    var gp=g('flowviz-theme')||{mode:'system',ts:0};
    var sp=g('flowviz-theme:'+SELF);
    mode=(sp&&sp.ts>(gp.ts||0))?sp.mode:(gp.mode||'system');
  }
  var d=(mode==='system')?((window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'):mode;
  document.documentElement.setAttribute('data-theme', d==='light'?'light':'dark');
}catch(e){}})();
</script>
<style>
  :root{--ff:'Segoe UI','Microsoft YaHei',system-ui,-apple-system,sans-serif;
    --bg:#12161d;--panel:#171d26;--panel2:#1d242f;--panel3:#232b37;--text:#eaeef5;--muted:#9aa5b8;--line:#2a3341;--line2:#35404f;
    --accent:#5aa9ff;--accent-soft:#5aa9ff24;--warn:#eab24a;--risk:#f4676c;--ok:#46c886;
    --shadow:0 1px 2px rgba(0,0,0,.36),0 10px 26px rgba(0,0,0,.22)}
  html[data-theme='light']{--bg:#e8dbc4;--panel:#f7efdf;--panel2:#f2e8d6;--panel3:#e2d3b8;--text:#2b2721;--muted:#6f6553;--line:#dccbaa;--line2:#c6b28e;
    --accent:#bf6b3a;--accent-soft:#bf6b3a1f;--warn:#b8801a;--risk:#c2403f;--ok:#35935f;
    --shadow:0 1px 2px rgba(93,74,45,.13),0 10px 26px rgba(93,74,45,.13)}
  /* 缩小时画布也跟着加深一档，让近白色的方块浮出来（节点底/画布 1.34→1.40，刻意只加一点点） */
  html[data-theme='light'] body:has(svg.zoomed-out){--bg:#e4d7bb;--panel3:#ddcdab}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font-family:var(--ff);-webkit-font-smoothing:antialiased;transition:background .22s ease}
  body{display:flex;flex-direction:column;overflow:hidden}
  header{display:flex;align-items:center;gap:12px;padding:9px 14px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap;z-index:3}
  .brand{display:flex;align-items:center;gap:8px;min-width:0}
  .brand-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);flex:0 0 auto}
  .brand-name{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44vw}
  .search{display:flex;align-items:center;gap:7px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:5px 10px;transition:border-color .15s}
  .search:focus-within{border-color:var(--accent);background:var(--panel3)}
  .search svg{width:14px;height:14px;flex:0 0 auto;stroke:var(--muted);fill:none;stroke-width:1.6;stroke-linecap:round}
  .search input{background:none;border:0;color:var(--text);font-size:12.5px;width:200px;outline:none;font-family:var(--ff)}
  #search-count{font-size:11.5px;color:var(--muted);min-width:58px}
  button{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:6px 10px;font-size:12.5px;cursor:pointer;font-family:var(--ff);display:inline-flex;align-items:center;gap:6px;transition:all .14s}
  button:hover{border-color:var(--accent);color:var(--accent);background:var(--panel3)}
  button.on{border-color:var(--accent);color:var(--accent);background:var(--panel3)}
  button.locked{opacity:.5}
  #toast{position:fixed;left:50%;bottom:96px;transform:translate(-50%,14px);max-width:86vw;text-align:center;
    background:var(--panel3);color:var(--text);border:1px solid var(--line2);border-radius:12px;padding:9px 15px;
    font-size:12.5px;box-shadow:var(--shadow);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;z-index:40}
  #toast.show{opacity:1;transform:translate(-50%,0)}
  button.off{opacity:.38;text-decoration:line-through}
  button svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  a.icon-btn{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:6px 10px;
    font-size:12.5px;display:inline-flex;align-items:center;gap:6px;text-decoration:none;transition:all .14s}
  a.icon-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--panel3)}
  a.icon-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  .legend{display:flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap}
  .legend button{padding:5px 9px;border-radius:999px;font-size:12px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 auto}
  .dot.st-done{background:var(--ok)}.dot.st-doing{background:var(--accent)}.dot.st-todo{background:#7c8798}
  .dot.st-risk{background:var(--risk)}.dot.st-hold{background:var(--warn)}
  main{flex:1;display:flex;min-height:0}
  #canvas{flex:1;min-width:0;position:relative;overflow:hidden;transition:background .22s ease;
    background:radial-gradient(1100px 620px at 50% -8%, color-mix(in srgb,var(--panel3) 70%,var(--bg)) 0%, var(--bg) 72%)}
  #canvas > svg{width:100%;height:100%;display:none;touch-action:none}
  #canvas[data-show='portrait'] #flow-svg-portrait,
  #canvas[data-show='landscape'] #flow-svg-landscape{display:block}
  .seg{display:flex;align-items:center;gap:2px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:2px}
  .seg button{border:0;background:none;padding:5px 9px;border-radius:8px;font-size:12px}
  .seg button.on{background:var(--panel3);color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent-soft)}
  aside{width:330px;flex:0 0 330px;background:var(--panel);border-left:1px solid var(--line);overflow:auto;padding:16px}
  aside::-webkit-scrollbar{width:9px}aside::-webkit-scrollbar-thumb{background:var(--line2);border-radius:9px}
  .ov-kicker{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600}
  .ov-title{margin:7px 0 6px;font-size:17px;line-height:1.35;font-weight:600;letter-spacing:.1px}
  .ov-sub{margin:0 0 14px;font-size:12.5px;line-height:1.65;color:var(--muted)}
  .stats{display:flex;gap:8px;margin-bottom:16px}
  .stat{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:9px 10px;text-align:center}
  .stat b{display:block;font-size:19px;font-weight:600;line-height:1.15}
  .stat span{font-size:10.5px;color:var(--muted)}
  .sec{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:16px 0 8px}
  .pillcol{display:flex;flex-direction:column;gap:5px}
  .ov-status,.ov-focus{width:100%;justify-content:flex-start;padding:7px 10px;font-size:12.5px;background:var(--panel2)}
  .ov-status em,.ov-focus em{margin-left:auto;font-style:normal;font-size:11px;color:var(--muted)}
  .ov-focus{text-align:left}
  .ov-focus .of-dot{width:7px;height:7px;border-radius:50%}
  .of-dot.st-risk{background:var(--risk)}.of-dot.st-hold{background:var(--warn)}
  .of-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .klegend{display:flex;gap:6px;flex-wrap:wrap}
  .kchip{font-size:11.5px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:3px 9px;background:var(--panel2)}
  .d-id{font-size:11px;color:var(--muted);font-family:ui-monospace,Consolas,monospace}
  .d-title{margin:6px 0 10px;font-size:16px;line-height:1.4;font-weight:600}
  .hint{font-size:11.5px;color:var(--muted);line-height:1.75;margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
  .chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--panel2)}
  .chip.st-done{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}
  .chip.st-doing{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)}
  .chip.st-todo{color:var(--muted)}
  .chip.st-risk{color:var(--risk);border-color:color-mix(in srgb,var(--risk) 40%,transparent)}
  .chip.st-hold{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
  .kv{font-size:12.5px;line-height:1.7;margin:10px 0}
  .kv b{display:block;color:var(--muted);font-weight:600;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px}
  .kv.note{border-left:2px solid var(--warn);padding:2px 0 2px 10px;background:color-mix(in srgb,var(--warn) 7%,transparent);border-radius:0 8px 8px 0}
  .jump{display:inline-flex;padding:3px 8px;margin:0 4px 4px 0;font-size:11.5px;border-radius:7px;background:var(--panel2);border:1px solid var(--line);color:var(--text);cursor:pointer}
  .jump:hover{border-color:var(--accent);color:var(--accent)}
  button.back{margin-bottom:12px;font-size:12px;padding:5px 9px}
  /* 搜索结果：说明/备注这类"看不见的命中"单独一栏，点一下定位 */
  .hit-head{display:flex;align-items:center;gap:8px;margin:16px 0 8px}
  .hit-nav{display:flex;align-items:center;gap:4px;margin-left:auto}
  .hit-nav button{padding:2px 9px;font-size:13px;line-height:1.5;width:26px;justify-content:center}
  .hit-pos{font-size:11.5px;color:var(--muted);min-width:30px;text-align:center;font-variant-numeric:tabular-nums}
  .focus-toggle{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);margin:9px 0 0;cursor:pointer}
  .focus-toggle input{accent-color:var(--accent)}
  .hits{display:flex;flex-direction:column;gap:5px}
  .hit-row{width:100%;text-align:left;justify-content:flex-start;gap:9px;padding:7px 10px;font-size:12.5px;background:var(--panel2);align-items:flex-start}
  .hit-row .hr-n{flex:0 0 auto;width:18px;height:18px;border-radius:50%;background:var(--panel3);color:var(--muted);
    font-size:11px;display:inline-flex;align-items:center;justify-content:center;margin-top:1px}
  .hit-row.cur{border-color:var(--hit);background:var(--panel3)}
  .hit-row.cur .hr-n{background:var(--hit);color:#fff}
  .hit-row .hr-main{display:flex;flex-direction:column;min-width:0}
  .hit-row em{font-style:normal;font-size:10.5px;color:var(--muted);margin-left:6px;white-space:nowrap}
  .hit-row .hr-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
  .hit-row .hr-snip{display:block;font-size:11px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hit-row.soft .hr-snip{color:var(--warn)}
  .hit-row mark{background:color-mix(in srgb,var(--hit) 30%,transparent);color:inherit;border-radius:3px;padding:0 2px}
  .hit-row.soft mark{background:color-mix(in srgb,var(--warn) 30%,transparent)}
  .hit-tip{font-size:11px;color:var(--muted);margin:2px 0 7px}
  /* 搜索中：非命中整体淡出，命中描边加粗；#vp 在程序化移动时加过渡 */
  svg.searching .node:not(.is-hit):not(.is-hit-soft){opacity:.14}
  svg.searching .edge:not(.is-hit){opacity:.1}
  svg.searching .edge-label-g:not(.is-hit){opacity:.1}
  svg.searching .band{opacity:.35}
  svg.searching .node.is-hit .node-bg{stroke:var(--hit);stroke-width:3}
  svg.searching .node.is-hit-soft .node-bg{stroke-width:2.8}
  #vp-portrait.vp-anim,#vp-landscape.vp-anim{transition:transform .28s ease}
  /* 全部流程图：右侧抽屉 */
  #flows-drawer{position:fixed;top:0;right:0;width:330px;max-width:88vw;height:100%;background:var(--panel);
    border-left:1px solid var(--line);box-shadow:-14px 0 34px rgba(0,0,0,.28);transform:translateX(102%);
    transition:transform .18s ease;z-index:20;display:flex;flex-direction:column}
  #flows-drawer.open{transform:none}
  .fd-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);font-size:13px;font-weight:600}
  .fd-head button{margin-left:auto;padding:4px 9px}
  #flows-list{padding:10px 12px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:6px}
  .flow-row{display:block;padding:9px 11px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);
    color:var(--text);text-decoration:none;font-size:12.5px;line-height:1.5}
  .flow-row:hover{border-color:var(--accent);color:var(--accent)}
  .flow-row.cur{border-color:var(--accent);background:var(--panel3);cursor:default}
  .flow-row.cur:hover{border-color:var(--accent);color:var(--text)}
  .flow-row .fr-name{font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .flow-row .fr-meta{color:var(--muted);font-size:11px}
  .flow-row .fr-cur{color:var(--accent);font-size:11px;margin-left:6px}
  .fd-hint{margin:0;padding:10px 14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);line-height:1.6}
  #drawer-scrim{position:fixed;inset:0;background:rgba(0,0,0,.42);opacity:0;pointer-events:none;transition:opacity .18s ease;z-index:19}
  #drawer-scrim.open{opacity:1;pointer-events:auto}
  @media (max-width:600px){ #flows-drawer{width:100%;max-width:100%} }
  #mmd-panel{display:none;border-top:1px solid var(--line);background:var(--panel);padding:12px 14px}
  #mmd-panel.open{display:block}
  #mmd-src{width:100%;height:150px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:10px;font:12px/1.65 ui-monospace,Consolas,monospace;padding:10px;resize:vertical;outline:none}
  footer{display:flex;gap:8px;padding:8px 14px;border-top:1px solid var(--line);background:var(--panel);font-size:12px;color:var(--muted);align-items:center;flex-wrap:wrap}
  .zoom-group{display:flex;align-items:center;gap:2px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:2px}
  .zoom-group button{border:0;background:none;padding:5px 7px}
  .zoom-group button span{display:none}
  #zoom-label{font-size:11.5px;color:var(--muted);min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
  .sep{width:1px;height:20px;background:var(--line);margin:0 3px}
  .foot-hint{margin-left:auto;font-size:11.5px}
  /* 按「触屏还是鼠标」给不同操作提示：别在手机上教人用滚轮、在电脑上教人双指 */
  .only-touch{display:none}
  @media (hover:none),(pointer:coarse){
    .only-pc{display:none}
    .only-touch{display:inline}
  }
  @media (max-width:960px){ main{flex-direction:column} aside{width:auto;flex:0 0 auto;border-left:none;border-top:1px solid var(--line);max-height:40vh} .brand-name{max-width:60vw} }
  @media (max-width:600px){
    header{padding:8px 10px;gap:8px}
    .brand-name{max-width:52vw;font-size:13px}
    .search{order:3;width:100%}
    .search input{width:100%}
    #search-count{order:4;min-width:0}
    .legend{order:5;width:100%;margin-left:0}
    .legend button{padding:4px 8px;font-size:11.5px}
    /* 手机上概览/详情收成**覆盖式**底部抽屉：脱离 flex 流，画布尺寸不变，
       就不会出现"开面板→画布变矮→重新适配→图被裁掉"的连锁反应 */
    aside{display:none;position:fixed;left:0;right:0;bottom:0;top:auto;width:auto;flex:0 0 auto;
      max-height:58vh;padding:14px;border-left:none;border-top:1px solid var(--line);
      border-radius:16px 16px 0 0;box-shadow:0 -14px 34px rgba(0,0,0,.42);z-index:15}
    body.panel-open aside{display:block}
    .panel-btn{display:inline-flex !important}
    .ov-title{font-size:15px}.d-title{font-size:15px}
    footer{padding:7px 10px;gap:6px}
    .foot-hint{display:none}
    .seg button span,.icon-btn span{display:none}
    .seg button{padding:6px 8px}
  }
  .panel-btn{display:none}
  @media print{ header,aside,footer,#mmd-panel{display:none} #canvas{background:#fff} }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="brand-dot"></span><span class="brand-name">${xml(spec.title || '工作流')}</span></div>
  <label class="search"><svg viewBox="0 0 16 16">${ICON.search}</svg><input id="search" type="search" placeholder="搜索环节 / 负责人 / 说明"></label>
  <span id="search-count"></span>
  <a id="home-btn" class="icon-btn" href="./" title="回到首页（流程图清单）"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON.home}</svg><span>首页</span></a>
  ${iconBtn('flows-toggle', '全部流程图', ICON.layers, 'flows-btn')}
  <div class="legend">${legend}</div>
</header>
<main>
  <div id="canvas" data-show="portrait">${svgs.portrait}${svgs.landscape}</div>
  <aside><div id="detail"></div></aside>
</main>
<footer>
  <div class="seg">
    <button data-variant-btn="portrait" class="on" title="竖版：适合手机，纵向滚动"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON.phone}</svg><span>竖版</span></button>
    <button data-variant-btn="landscape" title="横版：适合电脑，长流程自动分栏"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON.monitor}</svg><span>横版</span></button>
  </div>
  ${iconBtn('panel-toggle', '概览', ICON.panel, 'panel-btn')}
  <div class="zoom-group">
    ${iconBtn('zoom-out', '缩小', ICON.out)}
    <span id="zoom-label">100%</span>
    ${iconBtn('zoom-in', '放大', ICON.in)}
  </div>
  ${iconBtn('zoom-fit', '适配', ICON.fit)}
  <span class="sep"></span>
  ${iconBtn('export-svg', 'SVG', ICON.down)}
  ${iconBtn('export-png', 'PNG', ICON.down)}
  <span class="sep"></span>
  ${iconBtn('theme', '明/暗', ICON.theme)}
  ${iconBtn('lock', '锁定颜色', ICON.lockOpen, 'lock-btn')}
  ${iconBtn('mmd-toggle', 'Mermaid', ICON.code)}
  <span class="foot-hint"><span class="only-pc">按屏幕自动选竖/横版 · 滚轮缩放 · 拖拽平移 · 双击空白适配 · Esc 取消选中</span><span class="only-touch">按屏幕自动选竖/横版 · 单指拖动 · 双指缩放 · 点环节看详情</span></span>
</footer>
<div id="mmd-panel">
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
    <b style="font-size:12.5px">Mermaid 源码（可直接粘进飞书/语雀/GitHub/Typora）</b>
    <button id="mmd-copy" style="margin-left:auto">复制</button>
  </div>
  <textarea id="mmd-src" spellcheck="false">${xml(mmd)}</textarea>
</div>
<div id="drawer-scrim"></div>
<div id="flows-drawer" aria-hidden="true">
  <div class="fd-head">本机的流程图<button id="flows-close">✕</button></div>
  <div id="flows-list"></div>
  <p class="fd-hint">这里是同一目录下由本 skill 生成的所有流程图（按修改时间倒序）。用 HTTP 打开时会实时刷新；直接双击本地文件时用的是生成当时的清单。</p>
</div>
<div id="toast"></div>
<script id="flow-data" type="application/json">${json}</script>
<script>
${CLIENT_JS}
</script>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────
// Mermaid 导出
// ─────────────────────────────────────────────────────────────

function toMermaid(spec) {
  const out = [];
  out.push('flowchart ' + (spec.direction === 'LR' ? 'LR' : 'TD'));
  const shapeOf = (n) => {
    const t = n.label;
    if (n.kind === 'decision') return `{${t}}`;
    if (n.kind === 'start' || n.kind === 'end') return `((${t}))`;
    return `[${t}]`;
  };
  const nodeById = new Map(spec.nodes.map((n) => [n.id, n]));
  const inGroup = new Map();
  spec.groups.forEach((g, i) => g.members.forEach((m) => inGroup.set(m, i)));
  const emitted = new Set();
  spec.groups.forEach((g, gi) => {
    out.push('  subgraph ' + (g.label || g.id));
    for (const m of g.members) {
      out.push('    ' + m + shapeOf(nodeById.get(m)));
      emitted.add(m);
    }
    out.push('  end');
    void gi;
  });
  for (const n of spec.nodes) if (!emitted.has(n.id)) out.push('  ' + n.id + shapeOf(n));
  for (const e of spec.edges) {
    const arrow = e.style === 'dashed' ? '-.->' : '-->';
    out.push('  ' + e.from + ' ' + arrow + (e.label ? '|' + e.label + '|' : '') + ' ' + e.to);
  }
  return out.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'all' || key === 'help' || key === 'debug' || key === 'single') { flags[key] = true; continue; }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) fail('参数 --' + key + ' 缺少取值');
      flags[key] = val;
      i++;
    } else rest.push(a);
  }
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
  const baseWrap = flags.wrap !== undefined ? Math.max(0, Number(flags.wrap) || 0) : (spec.wrap ?? 0);

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
  writeOut(join(outDir, FLOW_MANIFEST), JSON.stringify(scanFlows(outDir), null, 2) + '\n');

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

async function cmdIndex(dir, flags) {
  const target = resolve(dir || '.');
  if (!existsSync(target)) fail('目录不存在：' + target);
  const manifest = scanFlows(target);
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
  return 0;
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

function main() {
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
  fail('未知命令：' + cmd + '（可用：render / mermaid / check / sample / help）');
}

const HELP = `flow.mjs — 业务流程 → 两版交互式流程图（竖版适配手机 / 横版适配电脑）+ Mermaid 源码
零依赖、纯离线，不请求任何 CDN。

用法：
  node flow.mjs render  <spec.json|spec.mmd> [--out x.html] [--all] [--wrap N] [--debug]
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

main();
