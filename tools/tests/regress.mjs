// 产物回归：判定「改了代码之后，渲染结果是否变了」
//   用法：
//     node regress.mjs save  [label] [--repo <目录>] [--spec <规格>]
//     node regress.mjs check [label] [--repo <目录>] [--spec <规格>]
//   默认 repo = 本仓库根（可发布副本），label = 默认示例名
//   基线存在 _verify/baseline/ 下（几何 json + 完整 HTML），对比内容：几何数据 + 样式/脚本指纹 + HTML 逐行差异
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const LABEL = [argv[1], arg('label')].find((v) => v && !v.startsWith('--') && v !== 'save' && v !== 'check') || 'demo';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = arg('repo', join(HERE, '..', '..'));   // 默认＝本仓库根
const SPEC = arg('spec', join(REPO, 'examples/示例-饮品店日常.json'));
const WORK = join(HERE, '.tmp', 'regress');   // 独立子目录：产物 HTML 里会内嵌"同目录流程图清单"，与别的测试混放会造成假差异
const BASE = join(HERE, 'baseline');
const OUT = join(WORK, LABEL + '.html');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
// 产物里天然带渲染时间（流程索引快照的 mtime / updated），逐字节对比前先归一化——否则每次都会"有差异"
const norm = (s) => s.replace(/"mtime":"[^"]*"/g, '"mtime":"<t>"').replace(/"mtimeMs":[\d.]+/g, '"mtimeMs":0').replace(/"updated":"[^"]*"/g, '"updated":"<t>"');

// ── 渲染（每次都在干净目录里做，避免上次的产物混进"同目录清单"造成假差异）──
function render() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  // 注意：受限沙箱下 node 的 piped stdio 子进程会 EPERM（命名管道被禁），所以用 stdio:'ignore'，
  // 渲染日志不需要捕获——真正的结果从产物 HTML 里读。
  execFileSync(process.execPath, [join(REPO, 'scripts/flow.mjs'), 'render', SPEC, '--out', OUT, '--all'], { stdio: 'ignore' });
  return readFileSync(OUT, 'utf8');
}
// ── 从产物里抽几何与指纹 ──
function digest(html) {
  const out = { svgs: {}, styles: [], scripts: [], viewBox: {} };
  for (const vid of ['portrait', 'landscape']) {
    const key = html.indexOf(`id="flow-svg-${vid}"`);
    if (key < 0) { out.svgs[vid] = null; continue; }
    const s = html.lastIndexOf('<svg', key), e = html.indexOf('</svg>', key);
    const svg = html.slice(s, e);
    const nodes = [...svg.matchAll(/<g class="node [^"]*" data-id="([^"]+)"[^>]*transform="translate\(([\d.-]+),([\d.-]+)\)">/g)]
      .map((m) => ({ id: m[1], x: +m[2], y: +m[3] })).sort((a, b) => a.id.localeCompare(b.id));
    const bands = [...svg.matchAll(/<rect class="band-bg" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g)]
      .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
    out.viewBox[vid] = (/viewBox="([^"]+)"/.exec(svg) || [])[1] || '';
    out.svgs[vid] = {
      nodes: nodes.length,
      nodeCoords: nodes,
      edges: [...svg.matchAll(/<path class="edge[^"]*"/g)].length,
      edgeLabels: [...svg.matchAll(/class="edge-label"/g)].length,
      bands,
      styleHash: sha((/<style>([\s\S]*?)<\/style>/.exec(svg) || [])[1] || ''),
    };
  }
  out.lineLabels = [...html.matchAll(/<text class="t-label"[^>]*>([^<]*)</g)].map((m) => m[1]).sort();
  out.scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m.length);
  out.pageScriptHash = sha((html.match(/<script>\s*\(function\(\)\{[\s\S]*?\}\)\(\);\s*<\/script>/) || [])[0] || '');
  out.htmlBytes = Buffer.byteLength(norm(html), 'utf8');   // 归一化后计数，避免 mtime 位数变化造成假差异
  return out;
}
function diff(a, b, path, acc) {
  if (typeof a !== typeof b) { acc.push(`${path}: 类型不同 ${typeof a} → ${typeof b}`); return; }
  if (a === null || b === null || typeof a !== 'object') { if (a !== b) acc.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) acc.push(`${path}: 长度 ${a.length} → ${b.length}`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, acc);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diff(a[k], b[k], path ? `${path}.${k}` : k, acc);
}

if (cmd === 'save') {
  const html = render();
  mkdirSync(BASE, { recursive: true });
  const d = digest(html);
  writeFileSync(join(BASE, LABEL + '.json'), JSON.stringify(d, null, 2));
  writeFileSync(join(BASE, LABEL + '.html'), norm(html));
  console.log(`基线已记录 [${LABEL}]`);
  console.log(`  HTML ${(d.htmlBytes / 1024).toFixed(0)} KB · 竖版 ${d.svgs.portrait.nodes} 节点/${d.svgs.portrait.edges} 连线/${d.svgs.portrait.bands.length} 分组带 · 横版 ${d.svgs.landscape.nodes}/${d.svgs.landscape.edges}/${d.svgs.landscape.bands.length}`);
  console.log(`  缩略指纹：横幅 viewBox=${d.viewBox.portrait} | 页面脚本 ${d.pageScriptHash} | SVG 样式 ${d.svgs.portrait.styleHash}`);
} else if (cmd === 'check') {
  const bj = join(BASE, LABEL + '.json'), bh = join(BASE, LABEL + '.html');
  if (!existsSync(bj)) { console.error(`没有基线 [${LABEL}]，先跑：node regress.mjs save ${LABEL}`); process.exit(2); }
  const html = render();
  const before = JSON.parse(readFileSync(bj, 'utf8')), after = digest(html);
  const deltas = [];
  diff(before, after, '', deltas);
  const geoKeys = deltas.filter((x) => /svgs\.(portrait|landscape)\.(nodeCoords|bands|nodes|edges|edgeLabels)|viewBox/.test(x));
  const other = deltas.filter((x) => !geoKeys.includes(x));

  const oldHtml = readFileSync(bh, 'utf8');
  const now = norm(html);
  const same = oldHtml === now;
  let firstDiff = '';
  if (!same) {
    const A = oldHtml.split('\n'), B = now.split('\n');
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      if (A[i] !== B[i]) {
        // 长行（flow-data 是一整行 JSON）要定位到列，否则只看到两个相同的前缀
        const a = A[i] || '', b = B[i] || '';
        let k = 0; while (k < Math.min(a.length, b.length) && a[k] === b[k]) k++;
        firstDiff = `首个不同在第 ${i + 1} 行、第 ${k + 1} 列：\n    基线: …${a.slice(Math.max(0, k - 50), k + 70)}\n    现在: …${b.slice(Math.max(0, k - 50), k + 70)}`;
        break;
      }
    }
  }
  const rawSame = readFileSync(bh, 'utf8') === html;
  console.log(`回归对比 [${LABEL}]  仓库=${REPO.replace(/.*\//, '')}`);
  console.log(`  产物（忽略渲染时间戳）：${same ? '逐字节相同 ✓' : '有差异 ✗'}`);
  if (!same) console.log('  ' + firstDiff);
  else if (!rawSame) console.log('  （原始字节只差流程索引里的 mtime/updated——产物本身没变）');
  if (!same) console.log('  ' + firstDiff);
  console.log(`  几何数据：${geoKeys.length ? geoKeys.length + ' 处变化 ✗' : '完全一致 ✓'}`);
  geoKeys.slice(0, 12).forEach((d) => console.log('    - ' + d));
  console.log(`  其它字段：${other.length ? other.length + ' 处变化（样式/脚本/文本）' : '无 ✓'}`);
  other.slice(0, 8).forEach((d) => console.log('    · ' + d));
  const broken = geoKeys.length > 0;
  console.log(`\n结论：${broken ? '几何变了 —— 需要人工确认是不是有意的' : same ? '产物完全没变（重构类改动的理想结果）' : '几何没变，只是样式/脚本/文本变了（前端重构的正常结果）'}`);
  process.exit(broken ? 1 : 0);
} else {
  console.log('用法：node regress.mjs save|check [label] [--repo 目录] [--spec 规格]');
  process.exit(2);
}
