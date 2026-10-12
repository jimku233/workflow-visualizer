#!/usr/bin/env node
/**
 * split-shell.mjs — 把 scripts/flow.mjs 里 renderHtml() 的 HTML 骨架抽成 assets/shell.html。
 *
 * 做了什么：
 *   · 模板里 11 个数据插值（标题 / stats / 图例 / 两版 SVG / Mermaid 源码 / JSON / app.css / app.js）
 *     变成 shell.html 里的 {{占位符}}，由 renderHtml 传进去；
 *   · 另外 14 处 ${ICON.x} / ${iconBtn(…)} 展开后本来就是固定标记，直接写成字面 HTML，
 *     renderHtml 里的 ICON 表和 iconBtn 助手随之删除；
 *   · 新增 loadShell() / fillShell()：只扫模板一遍、函数式替换，填入的内容里有 {{…}}、$&、$1 都不会被二次展开或吞字符。
 *
 * 用法（项目根目录运行，或把根目录当第一个参数）：
 *   node split-shell.mjs [根目录]            拆分：先在临时副本里用多组用例前后对比，通过才写入
 *   node split-shell.mjs [根目录] --dry      只验证，不写任何文件
 *   node split-shell.mjs [根目录] --verify   事后复查：现在的 flow.mjs + shell.html 渲染结果，
 *                                            是否仍与 scripts/flow.mjs.pre-shell（备份）一致（--against <文件> 可换基准）
 *
 * 验收标准：同一批输入渲染出的页面，忽略渲染时间戳后逐字节相同。零依赖，只用 node: 内置模块。
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync, cpSync, readdirSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname } from 'node:path';

const argv = process.argv.slice(2);
const ai = argv.indexOf('--against');
const against = ai >= 0 ? argv[ai + 1] : null;
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a, i) => !a.startsWith('--') && !(ai >= 0 && i === ai + 1));

class Fail extends Error {}
const fail = (m) => { throw new Fail(m); };
const say = (m) => process.stdout.write(m + '\n');

// ── 模板字符串还原 / 解析 ──
function cook(raw, what) {
  if (raw.includes('${')) fail(what + ' 里有未处理的 ${…}');
  try { return new Function('return `' + raw + '`')(); }
  catch (e) { fail(what + ' 无法还原成运行时字符串：' + e.message); }
}

/** 把 open 处（反引号）开始的模板字符串拆成 静态片段 / 插值表达式 两种部分。 */
function parseTemplate(src, open) {
  const parts = [];
  let buf = '';
  let i = open + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { buf += c + src[i + 1]; i++; continue; }
    if (c === '`') break;
    if (c === '$' && src[i + 1] === '{') {
      parts.push({ s: buf }); buf = '';
      let depth = 1, j = i + 2, q = null;
      for (; j < src.length && depth; j++) {
        const d = src[j];
        if (q) { if (d === '\\') j++; else if (d === q) q = null; continue; }
        if (d === "'" || d === '"') q = d;
        else if (d === '`') fail('插值里有嵌套的模板字符串，脚本不敢自动拆');
        else if (d === '{') depth++;
        else if (d === '}') depth--;
      }
      if (depth) fail('插值的花括号没有配对');
      parts.push({ e: src.slice(i + 2, j - 1) });
      i = j - 1;
      continue;
    }
    buf += c;
  }
  if (i >= src.length) fail('模板字符串没有结束');
  parts.push({ s: buf });
  return { parts, end: i };   // end = 结尾反引号的位置
}

// 数据插值 → 占位符名（表达式文本必须与 flow.mjs 里一字不差）
const SLOTS = [
  ["xml(spec.title || '')", 'titleMeta'],
  ['xml(stats)', 'stats'],
  ["xml(spec.title || '工作流图')", 'titleTag'],
  ["xml(spec.title || '工作流')", 'brandName'],
  ['legend', 'legend'],
  ['svgs.portrait', 'svgPortrait'],
  ['svgs.landscape', 'svgLandscape'],
  ['xml(mmd)', 'mmd'],
  ['json', 'json'],
  ["loadAsset('app.css')", 'css'],
  ['CLIENT_JS', 'js'],
];

const HELPERS = String.raw`/** assets/shell.html 是页面骨架，里面的 {{名字}} 是占位符，由 renderHtml 传进来的内容填上。
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
};`;

function transform(src) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const fn = src.indexOf('function renderHtml(');
  const ret = fn < 0 ? -1 : src.indexOf('return `<!DOCTYPE html>', fn);
  const iconAt = fn < 0 ? -1 : src.indexOf('const ICON = {', fn);
  if (ret < 0 || iconAt < 0 || iconAt > ret) fail('没找到 renderHtml() 里的 ICON 表 / return `<!DOCTYPE html>…`，文件结构和预期不同');
  const lineStart = (i) => src.lastIndexOf('\n', i) + 1;
  const iconStart = lineStart(iconAt);
  const retLineStart = lineStart(ret);
  const iconSrc = src.slice(iconStart, retLineStart);          // const ICON = {…}; const iconBtn = …;

  const { parts, end } = parseTemplate(src, ret + 7);
  const evalIcon = (expr) => {
    try { return new Function(iconSrc + '\nreturn (' + expr + ');')(); }
    catch (e) { fail('展开 ${' + expr + '} 失败：' + e.message); }
  };

  const used = new Map();
  let shell = '';
  for (const p of parts) {
    if ('s' in p) { shell += cook(p.s, '模板里的静态 HTML'); continue; }
    const e = p.e.trim();
    const slot = SLOTS.find(([x]) => x === e);
    if (slot) { used.set(slot[1], (used.get(slot[1]) || 0) + 1); shell += '{{' + slot[1] + '}}'; }
    else if (/^(iconBtn\(|ICON\.)/.test(e)) shell += evalIcon(e);
    else fail('出现了不认识的插值 ${' + e + '}，脚本不敢自动拆');
  }
  for (const [, name] of SLOTS) if (used.get(name) !== 1) fail('占位符 {{' + name + '}} 应当恰好出现 1 次，实际 ' + (used.get(name) || 0) + ' 次');
  if ((shell.match(/\{\{/g) || []).length !== SLOTS.length) fail('展开后的 HTML 里混进了多余的 {{ ，不敢继续');

  const call = ['return fillShell(loadShell(), {']
    .concat(SLOTS.map(([expr, name]) => '    ' + (expr === name ? name : name + ': ' + expr) + ','))
    .concat(['  })']).join(eol);

  const edits = [
    { at: fn, end: fn, text: HELPERS.split('\n').join(eol) + eol + eol },
    { at: iconStart, end: retLineStart, text: '' },
    { at: ret, end: end + 1, text: call },
  ];
  let out = src;
  for (const e of edits.sort((p, q) => q.at - p.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  if (/\bICON\b|\biconBtn\b/.test(out)) fail('删除 ICON/iconBtn 之后 flow.mjs 里仍有引用，不敢继续');
  return { out, shell };
}

// ── 验证：同一批输入，用"拆分前 / 拆分后"的 flow.mjs 各渲染一遍，抹平时间戳后逐字节比 ──
const norm = (s) => s
  .replace(/"mtime": ?"[^"]*"/g, '"mtime":"T"')
  .replace(/"mtimeMs": ?[0-9.]+/g, '"mtimeMs":0')
  .replace(/"updated": ?"[^"]*"/g, '"updated":"T"');

const baseSpec = (over = {}) => ({
  title: '饮品店 · 开店到闭店', subtitle: '虚构示例', direction: 'TD',
  groups: [{ id: 'g1', label: '开店', members: ['s', 'a'] }, { id: 'g2', label: '营业', members: ['d', 'e', 'f', 'g'] }],
  nodes: [
    { id: 's', label: '到店', kind: 'start', status: 'done' },
    { id: 'a', label: '开设备与巡检', time: '08:00–08:30', owner: '店长', status: 'done', detail: '咖啡机\n制冰机', note: '先看压力表' },
    { id: 'd', label: '开门营业', time: '09:30', status: 'doing' },
    { id: 'e', label: '排队是否超过 8 单', kind: 'decision', status: 'todo' },
    { id: 'f', label: '开第二个出杯位', kind: 'risk', status: 'risk' },
    { id: 'g', label: '正常出杯', kind: 'milestone', status: 'hold' },
    { id: 'z', label: '闭店上报', kind: 'end', status: 'todo' },
  ],
  edges: [
    { from: 's', to: 'a' }, { from: 'a', to: 'd' }, { from: 'd', to: 'e' },
    { from: 'e', to: 'f', label: '是' }, { from: 'e', to: 'g', label: '否' },
    { from: 'f', to: 'z' }, { from: 'g', to: 'z' }, { from: 'g', to: 'd', style: 'dashed' },
  ],
  ...over,
});

// 这些字符串专门用来戳"占位符替换"的坑：二次展开、$ 替换模式、HTML 转义、</script>
const HOSTILE = '<b>"A&B" {{title}} {{js}} {{json}} $& $1 $$ $` $\' ${x}</b>';

function writeCases(dir) {
  const put = (name, text) => { writeFileSync(join(dir, name), text, 'utf8'); return join(dir, name); };
  const hostile = baseSpec({ title: HOSTILE, subtitle: '{{css}} </script><script>alert(1)</script> $&' });
  hostile.nodes[1].label = '{{x}} $& $1';
  hostile.nodes[1].detail = '</script><script>alert(1)</script> {{legend}} $`';
  hostile.nodes[2].note = "$' {{svgPortrait}}";
  return [
    ['普通（分组/回边/各类节点）', put('plain.json', JSON.stringify(baseSpec()))],
    ['敌意字符（{{x}}、$&、$1、</script>）', put('hostile.json', JSON.stringify(hostile))],
    ['没有标题和副标题', put('notitle.json', JSON.stringify(baseSpec({ title: '', subtitle: '' })))],
    ['LR 方向', put('lr.json', JSON.stringify(baseSpec({ direction: 'LR' })))],
    ['Mermaid（含 {{六边形}}）', put('hex.mmd', 'flowchart LR\n  subgraph 阶段一\n    A{{六边形}} --> B[处理 {{x}} 与 $&]\n  end\n  B -->|是| C((结束))\n')],
    ['Markdown 里的 mermaid', put('doc.md', '# t\n```mermaid\nflowchart TD\n  A[开始] --> B{判断 $1}\n  B --> C[完成]\n```\n')],
  ];
}

function userExamples(root) {
  const d = join(root, 'examples');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => /\.(json|mmd|mermaid|md)$/i.test(n)).slice(0, 20)
    .map((n) => ['你的 examples/' + n, join(d, n)]);
}

function render(projectRoot, spec, outHtml) {
  const flow = join(projectRoot, 'scripts', 'flow.mjs');
  mkdirSync(dirname(outHtml), { recursive: true });
  let last = '';
  for (let k = 0; k < 2; k++) {                       // 第二遍才是"目录里已有自己"的稳态
    // 注意：本机沙箱禁止管道 stdio（spawnSync 默认 'pipe' → EPERM），所以把子进程输出重定向到文件再读。
    // 这样在任何环境下都能拿到错误信息，行为与原来一致。
    const logPath = outHtml + '.log';
    const fd = openSync(logPath, 'w');
    let status = 0;
    try {
      const r = spawnSync(process.execPath, [flow, 'render', spec, '--out', outHtml], { stdio: ['ignore', fd, fd] });
      status = typeof r.status === 'number' ? r.status : -1;
    } finally {
      closeSync(fd);
    }
    if (status !== 0) fail('渲染失败：' + spec + '\n' + readFileSync(logPath, 'utf8'));
    last += norm(readFileSync(outHtml, 'utf8'));
  }
  return last;
}

function firstDiff(a, b) {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x[i] === y[i]) i++;
  if (i === n && x.length === y.length) return null;
  const cut = (buf) => buf.subarray(Math.max(0, i - 40), i + 60).toString('utf8').replace(/\n/g, '⏎');
  return { at: i, before: cut(x), after: cut(y) };
}

function makeProject(dir, root, flowText, shellText) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(root, 'assets'), join(dir, 'assets'), { recursive: true });
  cpSync(join(root, 'scripts', 'serve.mjs'), join(dir, 'scripts', 'serve.mjs'));
  writeFileSync(join(dir, 'scripts', 'flow.mjs'), flowText, 'utf8');
  if (shellText !== undefined) writeFileSync(join(dir, 'assets', 'shell.html'), shellText, 'utf8');
}

/** origFlowText 是基准；afterRoot 是被验证的项目根目录（里面有 scripts/flow.mjs 与 assets/）。 */
function checkIdentical(origFlowText, afterRoot, root) {
  const tmp = mkdtempSync(join(tmpdir(), 'split-shell-'));
  try {
    const beforeRoot = join(tmp, 'before');
    makeProject(beforeRoot, root, origFlowText);
    const casesDir = join(tmp, 'cases');
    mkdirSync(casesDir);
    const cases = writeCases(casesDir).concat(userExamples(root));
    let n = 0, bytes = 0;
    const seen = {};
    for (const [label, spec] of cases) {
      const a = render(beforeRoot, spec, join(tmp, 'out-before', String(n), 'x.html'));
      const b = render(afterRoot, spec, join(tmp, 'out-after', String(n), 'x.html'));
      const d = firstDiff(a, b);
      if (d) fail(`✗ 用例「${label}」不相同，从第 ${d.at} 字节起：\n  基准  …${d.before}\n  现在  …${d.after}`);
      seen[label] = a;
      bytes += Buffer.byteLength(a, 'utf8');
      n++;
    }
    // 覆盖检查：敌意用例里的危险片段必须原样出现在页面里，否则这组比较没有意义
    const h = seen['敌意字符（{{x}}、$&、$1、</script>）'] || '';
    for (const m of ['{{js}}', '{{json}}', '{{title}}', '$&', '$1', '$$']) {
      if (!h.includes(m)) fail('敌意用例没有覆盖到 ' + m + '，比较结果不可信');
    }
    return { n, bytes };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

async function main() {
  const root = resolve(positional[0] ?? process.cwd());
  const flowFile = join(root, 'scripts', 'flow.mjs');
  const shellFile = join(root, 'assets', 'shell.html');
  const backup = flowFile + '.pre-shell';
  if (!existsSync(flowFile)) fail('找不到 ' + flowFile + '（请在项目根目录运行，或把项目根目录作为参数）');
  if (!existsSync(join(root, 'scripts', 'serve.mjs'))) fail('找不到 scripts/serve.mjs');

  if (flags.has('--verify')) {
    const base = resolve(against ?? backup);
    if (!existsSync(base)) fail('找不到基准 ' + base + '（拆分时会自动备份成 flow.mjs.pre-shell；也可用 --against 指定）');
    const r = checkIdentical(readFileSync(base, 'utf8'), root, root);
    say(`✓ 现在的渲染结果与基准一致（${r.n} 个用例 / ${r.bytes} 字节，已抹平时间戳）`);
    return;
  }

  const orig = readFileSync(flowFile, 'utf8');
  if (orig.includes('fillShell(')) { say('flow.mjs 已经拆过了。要复查请加 --verify。'); return; }
  if (existsSync(shellFile)) fail('assets/shell.html 已存在，先挪走再跑（不会覆盖你已有的文件）');

  const t = transform(orig);

  // 闸门：在临时副本里验证，不通过就什么都不写
  const stage = mkdtempSync(join(tmpdir(), 'split-shell-stage-'));
  let gate;
  try {
    const afterRoot = join(stage, 'after');
    makeProject(afterRoot, root, t.out, t.shell);
    gate = checkIdentical(orig, afterRoot, root);
  } finally { rmSync(stage, { recursive: true, force: true }); }
  say(`✓ 临时副本里拆分前后一致（${gate.n} 个用例 / ${gate.bytes} 字节，已抹平时间戳）`);

  if (flags.has('--dry')) { say('--dry：没有写任何文件。'); return; }

  if (!existsSync(backup)) writeFileSync(backup, orig, 'utf8');
  writeFileSync(shellFile, t.shell, 'utf8');
  writeFileSync(flowFile, t.out, 'utf8');
  checkIdentical(orig, root, root);                                // 对真正写下去的文件再比一次
  const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';
  say('✓ 真实文件复查通过');
  say(`  flow.mjs  ${kb(orig)} → ${kb(t.out)}`);
  say(`  assets/shell.html  ${kb(t.shell)}（${t.shell.split('\n').length - 1} 行）`);
  say(`  备份 ${backup}（确认没问题后可删）`);
}

main().catch((e) => {
  if (e instanceof Fail) { process.stderr.write('split-shell: ' + e.message + '\n'); process.exitCode = 1; }
  else { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 2; }
});
