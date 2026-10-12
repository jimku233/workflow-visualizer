// Mermaid 往返一致性测试：JSON → toMermaid → parseMermaid → 比较语义（节点/边标签）
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(REPO, 'tools/tests/.tmp');
mkdirSync(OUT, { recursive: true });
const flow = REPO + '/scripts/flow.mjs';
const run = (args) => execFileSync(process.execPath, [flow, ...args], { stdio: 'ignore' });

const cases = [
  { name: '普通中英文 + 数字', spec: { title: 't', nodes: [{ id: 'a', label: '写口播稿' }, { id: 'b', label: 'Review 2' }], edges: [{ from: 'a', to: 'b', label: '4–6 条' }] } },
  { name: '标签含方括号/花括号/竖线', spec: { title: 't', nodes: [{ id: 'a', label: '含 [方] 与 {花}' }, { id: 'b', label: '普通' }], edges: [{ from: 'a', to: 'b', label: 'a|b' }] } },
  { name: '含引号', spec: { title: 't', nodes: [{ id: 'a', label: '他说"可以"' }, { id: 'b', label: 'x' }], edges: [{ from: 'a', to: 'b' }] } },
  { name: '分组 + 形状', spec: { title: 't', direction: 'LR', groups: [{ id: 'g', label: '阶段（一）', members: ['a', 'b'] }], nodes: [{ id: 'a', label: '判断?', kind: 'decision' }, { id: 'b', label: '终点', kind: 'end' }], edges: [{ from: 'a', to: 'b', label: '是' }] } },
];

function readFlowData(html) {
  const m = /<script id="flow-data"[^>]*>([\s\S]*?)<\/script>/.exec(readFileSync(html, 'utf8'));
  return JSON.parse(m[1]);
}
const key = (s) => JSON.stringify({ n: s.nodes.map((n) => [n.id, n.label, n.kind]), e: s.edges.map((e) => [e.from, e.to, e.label || '']), g: s.groups.map((g) => [g.label, g.members]) });

let pass = 0, fail = 0;
for (const c of cases) {
  const json = OUT + '/rt-in.json', mmd = OUT + '/rt-out.mmd', html = OUT + '/rt-out.html';
  writeFileSync(json, JSON.stringify(c.spec, null, 2));
  run(['mermaid', json, '--out', mmd]);
  run(['render', mmd, '--out', html, '--all']);
  const before = { nodes: c.spec.nodes.map((n) => [n.id, n.label]), edges: c.spec.edges.map((e) => [e.from, e.to, e.label || '']), groups: (c.spec.groups || []).map((g) => [g.label, g.members]) };
  const d = readFlowData(html);
  const after = { nodes: d.nodes.map((n) => [n.id, n.label]), edges: d.edges.map((e) => [e.from, e.to, e.label || '']), groups: d.groups.map((g) => [g.label, g.members]) };
  const same = JSON.stringify(before) === JSON.stringify(after);
  if (same) { pass++; console.log(`  ✓ ${c.name}`); }
  else {
    fail++;
    console.log(`  ✗ ${c.name}`);
    console.log('      输入:', JSON.stringify(before));
    console.log('      往返:', JSON.stringify(after));
  }
}
console.log(`\n往返一致性：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
