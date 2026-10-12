#!/usr/bin/env node
/**
 * split-home.mjs — 把 scripts/serve.mjs 里首页内联的 CSS / JS 拆成 assets/home.css、assets/home.js。
 *
 * 用法（在项目根目录运行，或把根目录当第一个参数）：
 *   node split-home.mjs [根目录]            拆分：先在临时副本里验证，通过才写入，写完再对真实文件复查
 *   node split-home.mjs [根目录] --dry      只验证，不写任何文件
 *   node split-home.mjs [根目录] --verify   事后复查：现在的 serve.mjs + assets 渲染出的首页，
 *                                           是否仍与 scripts/serve.mjs.pre-split（拆分前的备份）逐字节相同
 *                                           （--against <文件> 可换基准）
 *
 * 验收标准：用同一批目录跑 buildHome()，拆分前后输出的 HTML 逐字节相同。
 * 零依赖，只用 node: 内置模块。
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const ai = argv.indexOf('--against');
const against = ai >= 0 ? argv[ai + 1] : null;
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a, i) => !a.startsWith('--') && !(ai >= 0 && i === ai + 1));

class Fail extends Error {}
const fail = (m) => { throw new Fail(m); };
const say = (m) => process.stdout.write(m + '\n');

// ── 把"模板字符串里的原文"还原成运行时的值（\\d → \d、CRLF → LF）；含 ${…} 插值就不敢动 ──
function cook(raw, what) {
  if (raw.includes('${')) fail(what + ' 里有 ${…} 插值，脚本不敢自动拆，需要手工处理');
  try { return new Function('return `' + raw + '`')(); }
  catch (e) { fail(what + ' 无法还原成运行时字符串：' + e.message); }
}

/** 从开头反引号的位置找到配对的结尾反引号（跳过反斜杠转义）。 */
function templateEnd(src, open) {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return i;
  }
  return -1;
}

const LOAD_ASSET = String.raw`/** 首页前端资源：../assets/home.css、home.js，渲染时内联回页面（产物仍是自包含的单页）。
 *  与 flow.mjs 里的 loadAsset 同一约定；这里不缓存，改了资源刷新页面即生效。
 *  统一成 LF、去掉 BOM：这些文本以前写在模板字符串里，换行天然是 LF；
 *  拆成独立文件后，Windows 上被 git / 编辑器存成 CRLF 也不能让输出变样。 */
const loadAsset = (name) => {
  const t = readFileSync(new URL('../assets/' + name, import.meta.url), 'utf8');
  return (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t).replace(/\r\n/g, '\n');
};`;

// ── 改写 serve.mjs：返回新的源码 + 两份资源文本 ──
function transform(src) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const edits = [];   // {at, end, text}，最后按位置从后往前套用

  // 1) 首页 CSS：page() 里唯一的 <style>…</style>
  const s0 = src.indexOf('<style>');
  const s1 = src.indexOf('</style>');
  if (s0 < 0 || s1 < s0 || src.indexOf('<style>', s0 + 1) >= 0 || src.indexOf('</style>', s1 + 1) >= 0)
    fail('没找到唯一的 <style>…</style>（应该是 page() 里的首页 CSS）');
  const css = cook(src.slice(s0 + 7, s1), '首页 CSS');
  if (!css.startsWith('\n') || !css.endsWith('\n')) fail('首页 CSS 前后没有换行，和预期不符，不敢自动拆');
  edits.push({ at: s0, end: s1 + 8, text: '<style>\\n${loadAsset(\'home.css\')}</style>' });

  // 2) 首页 JS：homeScript() 里返回 <script>…</script> 的那个模板字符串
  const hs = src.indexOf('function homeScript()');
  const ret = hs < 0 ? -1 : src.indexOf('return `', hs);
  if (ret < 0) fail('没找到 function homeScript() 里的 return `…`');
  const open = ret + 7;
  const close = templateEnd(src, open);
  if (close < 0) fail('homeScript() 的模板字符串没有结束');
  const js = cook(src.slice(open + 1, close), 'homeScript()');
  if (!js.startsWith('<script>\n') || !js.endsWith('\n</script>')) fail('homeScript() 不是 <script>⏎…⏎</script> 的形状，不敢自动拆');
  edits.push({ at: ret, end: close + 1, text: 'return `<script>\\n${loadAsset(\'home.js\')}</script>`' });

  // 3) 补 import 与 loadAsset
  const imp = src.indexOf("import { pathToFileURL } from 'node:url';");
  const built = /^const BUILD = .*$/m.exec(src);
  if (imp < 0 || !built) fail('没找到插入点（import { pathToFileURL } … / const BUILD = …），文件结构和预期不同');
  if (!/readFileSync/.test(src)) edits.push({ at: imp, end: imp, text: "import { readFileSync } from 'node:fs';" + eol });
  const lineEnd = built.index + built[0].length;
  edits.push({ at: lineEnd, end: lineEnd, text: eol + eol + LOAD_ASSET.split('\n').join(eol) });

  let out = src;
  for (const e of edits.sort((p, q) => q.at - p.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return {
    out,
    css: css.slice(1),                                            // 去掉开头那个换行（模板里补回）
    js: js.slice('<script>\n'.length, js.length - '</script>'.length),
  };
}

// ── 验证：同一批目录、同一组参数，分别用"拆分前 / 拆分后"的 buildHome 渲染，逐字节比 ──
function makeFixture(dir) {
  const flow = (title, nodes) => {
    const d = {
      title, subtitle: '', direction: 'TD', groups: [], edges: [],
      nodes: nodes.map(([id, status]) => ({ id, label: id, kind: 'task', status, time: '', owner: '', detail: '', note: '' })),
    };
    return `<!DOCTYPE html><html data-flow-viz="1"><head><meta name="flow-title" content="${title}">`
      + `<meta name="flow-stats" content="${nodes.length}|0|0|577x2296|1134x824|"></head><body>`
      + `<script id="flow-data" type="application/json">${JSON.stringify(d)}</script></body></html>`;
  };
  const put = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text, 'utf8'); };
  const a = flow('示例A', [['a', 'done'], ['b', 'risk'], ['c', 'hold']]);
  put('示例A.html', a);
  put('示例A - 副本.html', a);                                    // 内容相同 → "只留一个"
  put('示例B.html', flow('示例B', [['x', 'todo'], ['y', 'todo']]));
  put('示例B（旧）.html', flow('示例B', [['x', 'todo']]));        // 同标题不同内容 → "建议改名"
  put('【对照预览】.html', '<html></html>');                      // dev 卡片
  put('示例A-横版.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  put('示例A.mmd', 'flowchart TD\n  a-->b\n');
  put('流程索引.json', JSON.stringify({ flows: [{ file: '示例A.html', title: '示例A', nodes: 3, edges: 0, groups: 0 }] }));
  put('说明.txt', 'x');
  mkdirSync(join(dir, '子目录'), { recursive: true });            // 空目录 → "还没有流程图"
}

const MATRIX = (dir) => [
  { dir, baseHref: '', rootPath: dir, fileMode: true },                                  // flow.mjs 写静态 index.html 用的
  { dir, baseHref: '/', rootPath: dir, canAct: true },                                   // serve.mjs 动态首页（本机，可处理重名）
  { dir, baseHref: '/', rootPath: dir, canAct: false, diag: true },                      // ?diag=1 自检块
  { dir, baseHref: '/子目录/', rootPath: dir, port: 9, crumb: '<a href="/">首页</a>' },   // 子目录面包屑
];

async function renderAll(serveFile, dirs) {
  const m = await import(pathToFileURL(serveFile).href);
  const out = [];
  // build 固定：默认值是模块加载时刻，前后两个模块差几秒会让 diag 输出"假不同"
  for (const dir of dirs) for (const o of MATRIX(dir)) out.push(await m.buildHome({ build: 'T', ...o }));
  return out;
}

const MARKERS = ['class="card', 'dev-row', '重名流程图', '内容相同', '内容不同', 'data-act="trash"', '自检', '这个目录里还没有流程图', '子目录'];
function coverage(outs) {
  const all = outs.join('\n');
  const miss = MARKERS.filter((m) => !all.includes(m));
  if (miss.length) fail('测试夹具没覆盖到这些分支，比较结果不可信：' + miss.join('、'));
}

function firstDiff(a, b) {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x[i] === y[i]) i++;
  if (i === n && x.length === y.length) return null;
  const cut = (buf) => buf.subarray(Math.max(0, i - 30), i + 50).toString('utf8').replace(/\n/g, '⏎');
  return { at: i, before: cut(x), after: cut(y) };
}

function compare(A, B) {
  let bytes = 0;
  for (let k = 0; k < A.length; k++) {
    const d = firstDiff(A[k], B[k]);
    if (d) fail(`✗ 第 ${k + 1}/${A.length} 组输出不相同，从第 ${d.at} 字节起：\n  基准  …${d.before}\n  现在  …${d.after}`);
    bytes += Buffer.byteLength(A[k], 'utf8');
  }
  return { n: A.length, bytes };
}

/** beforeText 是基准源码；afterFile 是要被验证的 serve.mjs（旁边的 ../assets 会被它自己读到）。 */
async function checkIdentical(beforeText, afterFile, extraDirs) {
  const tmp = mkdtempSync(join(tmpdir(), 'split-home-'));
  try {
    const before = join(tmp, 'before', 'scripts', 'serve.mjs');
    mkdirSync(dirname(before), { recursive: true });
    writeFileSync(before, beforeText, 'utf8');
    const fx = join(tmp, 'fixture');
    makeFixture(fx);
    const dirs = [fx, join(fx, '子目录'), ...extraDirs];
    const A = await renderAll(before, dirs);
    const B = await renderAll(afterFile, dirs);
    coverage(A.slice(0, 2 * MATRIX('').length));
    return compare(A, B);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';

async function main() {
  const root = resolve(positional[0] ?? process.cwd());
  const serveFile = join(root, 'scripts', 'serve.mjs');
  const homeCss = join(root, 'assets', 'home.css');
  const homeJs = join(root, 'assets', 'home.js');
  const backup = serveFile + '.pre-split';
  if (!existsSync(serveFile)) fail('找不到 ' + serveFile + '（请在项目根目录运行，或把项目根目录作为参数）');

  const realOut = join(root, 'out');
  const extra = existsSync(realOut) && statSync(realOut).isDirectory() ? [realOut] : [];
  const tail = extra.length ? ' + 你的 out/ 目录' : '';

  if (flags.has('--verify')) {
    const base = resolve(against ?? backup);
    if (!existsSync(base)) fail('找不到基准 ' + base + '（拆分时会自动备份成 serve.mjs.pre-split；也可用 --against 指定）');
    const r = await checkIdentical(readFileSync(base, 'utf8'), serveFile, extra);
    say(`✓ 现在的首页与基准逐字节相同（${r.n} 组输出 / ${r.bytes} 字节；夹具${tail}）`);
    return;
  }

  const orig = readFileSync(serveFile, 'utf8');
  if (orig.includes("loadAsset('home.css')")) { say('serve.mjs 已经拆过了。要复查请加 --verify。'); return; }
  if (existsSync(homeCss) || existsSync(homeJs)) fail('assets/home.css 或 assets/home.js 已存在，先挪走再跑（不会覆盖你已有的文件）');

  const t = transform(orig);

  // 闸门：在临时副本里验证，不通过就什么都不写
  const stage = mkdtempSync(join(tmpdir(), 'split-home-stage-'));
  let gate;
  try {
    const put = (rel, text) => { const f = join(stage, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text, 'utf8'); return f; };
    const staged = put('scripts/serve.mjs', t.out);
    put('assets/home.css', t.css);
    put('assets/home.js', t.js);
    gate = await checkIdentical(orig, staged, extra);
  } finally { rmSync(stage, { recursive: true, force: true }); }
  say(`✓ 临时副本里拆分前后逐字节相同（${gate.n} 组输出 / ${gate.bytes} 字节；夹具${tail}）`);

  if (flags.has('--dry')) { say('--dry：没有写任何文件。'); return; }

  if (!existsSync(backup)) writeFileSync(backup, orig, 'utf8');
  mkdirSync(dirname(homeCss), { recursive: true });
  writeFileSync(homeCss, t.css, 'utf8');
  writeFileSync(homeJs, t.js, 'utf8');
  writeFileSync(serveFile, t.out, 'utf8');

  await checkIdentical(orig, serveFile, extra);   // 对真正写下去的文件再比一次
  say(`✓ 真实文件复查通过`);
  say(`  serve.mjs  ${kb(orig)} → ${kb(t.out)}`);
  say(`  assets/home.css  ${kb(t.css)}`);
  say(`  assets/home.js   ${kb(t.js)}`);
  say(`  备份 ${backup}（确认没问题后可删）`);
}

main().catch((e) => {
  if (e instanceof Fail) { process.stderr.write('split-home: ' + e.message + '\n'); process.exitCode = 1; }
  else { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 2; }
});
