// 解析与校验的验收测试（批次 B 的目标规格）
//
// 用法：node tools/tests/parse-errors.mjs
// 期望：全部通过（退出码 0）。当前未实现的行为会打印 ✗ 并给出行号，方便逐条推进。
//
// 约定（要实现的错误契约）：
//   · 输入/参数类错误 → 退出码 2，信息写到 stderr，格式形如  flow: <文件>:<行>:<列>: <说明>
//   · 单个错误里必须能定位到具体行（至少 "<行>:" 出现）
//   · 合法输入必须仍然成功（退出码 0），且标签里的 ; " [ ] 等字符不能触发误判
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FLOW = join(REPO, 'scripts', 'flow.mjs');
const TMP = join(HERE, '.tmp');
mkdirSync(TMP, { recursive: true });

function runCli(args) {
  const outFile = join(TMP, 'cli-out.txt');
  const fd = openSync(outFile, 'w');
  let status = 0;
  try {
    execFileSync(process.execPath, [FLOW, ...args], { stdio: ['ignore', fd, fd] });
  } catch (e) {
    status = typeof e.status === 'number' ? e.status : -1;
  } finally {
    closeSync(fd);
  }
  return { status, text: readFileSync(outFile, 'utf8') };
}

let seq = 0;
const writeSpec = (name, content) => {
  const p = join(TMP, `${String(++seq).padStart(2, '0')}-${name}`);
  writeFileSync(p, content, 'utf8');
  return p;
};

const cases = [];
const bad = (name, file, expect) => cases.push({ name, file, kind: 'error', expect });
const good = (name, file, expect) => cases.push({ name, file, kind: 'ok', expect });

// ── 合法输入必须继续成功 ──
good('合法 JSON', writeSpec('ok.json', JSON.stringify({
  title: 'ok', nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }], edges: [{ from: 'a', to: 'b' }],
})), { status: 0, has: '结构检查通过' });

good('合法 Mermaid', writeSpec('ok.mmd', 'flowchart TD\n  A[甲] --> B[乙]\n'), { status: 0, has: '结构检查通过' });

good('标签里含分号与引号（不能被误切）', writeSpec('quoted.mmd', 'flowchart TD\n  A["半角;分号"] --> B["引号\\"内"]\n'), { status: 0, has: '节点 2' });

good('一条语句里多个分号链接', writeSpec('semicolon.mmd', 'flowchart TD\n  A[一] --> B[二]; B --> C[三]\n'), { status: 0, has: '节点 3' });

// ── 错误输入必须报错，且能定位 ──
bad('未闭合的节点形状', writeSpec('unclosed.mmd', 'flowchart TD\n  A[unterminated --> B\n'), { status: 2, has: '1|2:', words: ['未闭合', '语法', '形状'] });

bad('未配对的 subgraph', writeSpec('subgraph.mmd', 'flowchart TD\n  subgraph 分组\n    A[甲]\n'), { status: 2, has: ':', words: ['subgraph', 'end', '配对'] });

good('配对的 subgraph（合法）', writeSpec('subgraph-ok.mmd', 'flowchart TD\n  subgraph 分组\n    A[甲] --> B[乙]\n  end\n'), { status: 0, has: '节点 2' });

bad('JSON 里 kind 未知', writeSpec('badkind.json', JSON.stringify({
  title: 't', nodes: [{ id: 'a', label: '甲', kind: 'weird' }], edges: [],
})), { status: 2, words: ['kind', 'weird'] });

bad('nodes 不是数组', writeSpec('notarray.json', JSON.stringify({ title: 't', nodes: { a: 1 }, edges: [] })), { status: 2, words: ['nodes', '数组'] });

bad('分组引用了不存在的节点', writeSpec('badgroup.json', JSON.stringify({
  title: 't', groups: [{ id: 'g', label: '组', members: ['a', 'ghost'] }],
  nodes: [{ id: 'a', label: '甲' }], edges: [],
})), { status: 2, words: ['ghost', '分组'] });

bad('边引用了不存在的节点', writeSpec('badedge.json', JSON.stringify({
  title: 't', nodes: [{ id: 'a', label: '甲' }], edges: [{ from: 'a', to: 'ghost' }],
})), { status: 2, words: ['ghost'] });

bad('非法 JSON', writeSpec('broken.json', '{ "title": "t", "nodes": [ }'), { status: 2, words: ['JSON'] });

let pass = 0;
const failures = [];
for (const c of cases) {
  const r = runCli(['check', c.file]);
  const problems = [];
  if (r.status !== c.expect.status) {
    problems.push(`退出码 ${r.status}（期望 ${c.expect.status}）`);
  }
  if (c.expect.has && !r.text.includes(c.expect.has)) {
    // 'has' 里用 | 分隔多个可接受写法
    const alts = c.expect.has.split('|');
    if (!alts.some((a) => r.text.includes(a))) problems.push(`输出缺少「${c.expect.has}」`);
  }
  if (c.expect.words) {
    const miss = c.expect.words.filter((w) => !r.text.includes(w));
    if (miss.length === c.expect.words.length) problems.push(`输出没有提到任何关键词（${c.expect.words.join(' / ')}）`);
  }
  if (!problems.length) { pass++; console.log(`  ✓ ${c.name}`); continue; }
  failures.push({ c, problems, r });
  console.log(`  ✗ ${c.name}\n      ${problems.join('；')}\n      实际输出: ${JSON.stringify(r.text.trim().slice(0, 160))}`);
}

console.log(`\n解析/校验验收：${pass}/${cases.length} 通过`);
if (failures.length) {
  console.log('未达标项（批次 B 的目标）：');
  failures.forEach(({ c }) => console.log(`  · ${c.name}`));
}
process.exit(failures.length ? 1 : 0);
