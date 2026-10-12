// 主题令牌对比度自检：从 assets/app.css 里**读出真实数值**，算"小字"在三种面板底上的最低对比度。
// 要求：文字令牌 ≥ 4.5:1（WCAG AA 小字）；--hit 作为非文本（描边/圆点）≥ 3:1。
// 用法：node tools/tests/contrast.mjs       退出码 0 = 全部达标
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(join(REPO, 'assets', 'app.css'), 'utf8');

/** 取某个选择器的声明块（第一个 {...}） */
function block(sel) {
  const i = css.indexOf(sel);
  if (i < 0) throw new Error('找不到选择器：' + sel);
  const a = css.indexOf('{', i);
  const b = css.indexOf('}', a);
  return css.slice(a + 1, b);
}
function parse(decls) {
  const out = {};
  for (const m of decls.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) out['--' + m[1]] = m[2].trim();
  return out;
}
/** 解析 var() 别名（只支持一层，够用） */
function resolve(vars, name, depth = 0) {
  const v = vars[name];
  if (v === undefined) return undefined;
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  if (m && depth < 5) return resolve(vars, m[1], depth + 1);
  return v;
}
const hex = (c) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const themes = {
  dark: parse(block(":root{")),
  light: { ...parse(block(":root{")), ...parse(block("html[data-theme='light']{")) },
};

const TEXT = ['--muted', '--accent-text', '--ok-text', '--warn-text', '--risk-text'];
const NONTEXT = ['--hit'];
let fail = 0;

for (const [name, vars] of Object.entries(themes)) {
  const panels = ['--panel', '--panel2', '--panel3'].map((k) => [k, hex(resolve(vars, k))]);
  const rows = [];
  for (const t of TEXT) {
    const fg = hex(resolve(vars, t));
    if (!fg) { rows.push([t, '缺失', 0, 'FAIL']); fail++; continue; }
    const worst = Math.min(...panels.map(([, bg]) => ratio(fg, bg)));
    const ok = worst >= 4.5;
    if (!ok) fail++;
    rows.push([t, resolve(vars, t), worst, ok ? 'OK' : 'FAIL']);
  }
  for (const t of NONTEXT) {
    const fg = hex(resolve(vars, t));
    const worst = Math.min(...panels.map(([, bg]) => ratio(fg, bg)));
    const ok = worst >= 3;
    if (!ok) fail++;
    rows.push([t + '（非文本≥3）', resolve(vars, t), worst, ok ? 'OK' : 'FAIL']);
  }
  console.log(`\n${name} 主题（对 panel / panel2 / panel3 取最差）：`);
  for (const [t, v, r, s] of rows) console.log(`  ${String(t).padEnd(22)} ${String(v).padEnd(9)} ${r.toFixed(2).padStart(6)}:1  ${s}`);
}
console.log(fail ? `\n✗ ${fail} 项不达标` : '\n✓ 全部达标（小字 ≥4.5:1，非文本 ≥3:1）');

// ── 追加：SVG 分组带标题（浅色主题下必须压深，否则对 7.5% 组色浅底只有约 1.3–2.1:1）──
const palette = (/const GROUP_PALETTE = \[([^\]]+)\]/.exec(readFileSync(join(REPO, 'scripts', 'flow.mjs'), 'utf8')) || [])[1];
if (palette) {
  const colors = palette.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const lightBg = hex(resolve(themes.light, '--bg'));
  const MIX = 0.41;                       // svg.css 里写的比例，必须一致
  const INK = hex('#241f19');
  const out = [];
  for (const c of colors) {
    const band = c.match(/^#[0-9a-f]{6}$/i) ? hex(c).map((v, i) => Math.round(v * 0.075 + lightBg[i] * 0.925)) : null;
    if (!band) continue;
    const mixed = hex(c).map((v, i) => Math.round(v * MIX + INK[i] * (1 - MIX)));
    out.push([c, ratio(hex(c), band), ratio(mixed, band)]);
  }
  console.log('\n浅色主题 · 分组带标题（对 7.5% 组色浅底，需 ≥4.5）：');
  for (const [c, before, after] of out) {
    const ok = after >= 4.5;
    if (!ok) fail++;
    console.log(`  ${c}  原 ${before.toFixed(2)}:1 → 混深后 ${after.toFixed(2)}:1  ${ok ? 'OK' : 'FAIL'}`);
  }
  const min = Math.min(...out.map((r) => r[2]));
  console.log(`  最低 ${min.toFixed(2)}:1`);
}
process.exit(fail ? 1 : 0);
