#!/usr/bin/env node
/**
 * check-release.mjs — 发布前的一条命令自检（零依赖，只用 node: 内建模块）。
 *
 * 为什么有这个脚本：曾经用 `git add -A` 把一次性能测试产生的 `index.html`
 * （渲染器顺手写在仓库根的首页，里面带着 `<code id="rootpath">D:\…</code>` 本机路径）
 * 一起提交，仓库公开后那条路径就进了历史和发布包。人记不住，就交给脚本记。
 *
 * 用法：
 *   node tools/check-release.mjs                # 全套（含产物回归，约 2–4 秒）
 *   node tools/check-release.mjs --skip-regress # CI 里跑（回归门由另一步单独跑）
 *   node tools/check-release.mjs --quiet        # 只打结论
 *
 * 退出码：0 = 可以发布；1 = 有问题（逐条列出）。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SKIP_REGRESS = argv.includes('--skip-regress');
const QUIET = argv.includes('--quiet');

const problems = [];
const notes = [];
const say = (s) => { if (!QUIET) process.stdout.write(s + '\n'); };
const bad = (where, msg) => problems.push(`${where}：${msg}`);

/* ── 工具 ─────────────────────────────────────────────── */
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const gitRaw = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** 仓库里被跟踪的文件（不转义中文路径） */
function trackedFiles() {
  const out = git(['-c', 'core.quotePath=false', 'ls-files']);
  return out ? out.split('\n').filter(Boolean) : [];
}

/* ── 1. 生成物：仓库里不该有渲染产物 ───────────────────── */
say('发布前检查（tools/check-release.mjs）');

const files = trackedFiles();
if (!files.length) bad('git', '没有读到任何被跟踪的文件（不在 git 仓库里？）');

/** 允许存在的同名文件（GitHub Pages 落地页） */
const ALLOW = new Set(['docs/index.html']);

const isGenerated = (p) => {
  if (ALLOW.has(p)) return false;
  const base = p.split('/').pop();
  if (p === 'index.html') return '仓库根不该有渲染首页（flow.mjs 会写一个带本机路径的 index.html）';
  if (base === '流程索引.json') return '清单是运行时产物，不该提交（.gitignore 已含）';
  if (/-(竖版|横版)\.svg$/.test(base)) return 'SVG 是渲染产物，示例请放 examples/ 或 out/';
  if (/(^|\/)(\.tmp|out|\.trash-[^/]+)\//.test(p)) return '临时/产物目录不该提交';
  if (/\.pre-(split|shell)$/.test(base)) return '拆分脚本的备份不该提交';
  return '';
};

const stray = files.map((f) => [f, isGenerated(f)]).filter(([, why]) => why);
if (stray.length) stray.forEach(([f, why]) => bad('生成物', `${f} — ${why}`));
say(` 1/5 生成物          ${stray.length ? '✗ ' + stray.length + ' 个' : '✓ 无'}`);

/* ── 2. 敏感串（当前文件） ─────────────────────────────── */
// 注意：本脚本自己也会被扫描，所以「用户名」这类模式要拼出来，
// 不能把字面量直接写在源码里（否则脚本会举报自己）。
const LOCAL_USER = ['8613', '6'].join('');

const SECRET_PATTERNS = [
  [new RegExp(LOCAL_USER, 'g'), '本机用户名'],
  [/D:\\服务质量pdf|D:\/服务质量pdf/g, '本机绝对路径'],
  [/\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, '内网 IP'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'GitHub fine-grained token'],
  [/\bsk-[A-Za-z0-9]{20,}/g, 'API key（sk-）'],
  [/BEGIN (?:RSA|OPENSSH|EC|PGP) PRIVATE KEY/g, '私钥'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
];
/** 用于 git grep 的合并正则（历史扫描一次扫完） */
const GREP_RE = [
  LOCAL_USER,
  'D:\\\\?服务质量pdf',
  '(192\\.168|10\\.[0-9]{1,3}|172\\.(1[6-9]|2[0-9]|3[01]))\\.[0-9]{1,3}\\.[0-9]{1,3}',
  'gh[pousr]_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'sk-[A-Za-z0-9]{20,}',
  'BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
].join('|');

let fileHits = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }   // 二进制/图片读不出来就跳过
  for (const [re, label] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      bad('敏感串', `${f}:${line} 命中「${label}」→ ${m[0].slice(0, 40)}`);
      fileHits++;
      if (fileHits > 20) break;
    }
  }
}
say(` 2/5 敏感串（文件）   ${fileHits ? '✗ ' + fileHits + ' 处' : `✓ ${files.length} 个文件`}`);

/* ── 3. 敏感串（全历史：含已删除文件） ─────────────────── */
let histHits = 0;
try {
  const revs = git(['rev-list', '--all']).split('\n').filter(Boolean);
  if (revs.length) {
    // 一次 git grep 扫全部提交，避免 N 次进程启动
    let out = '';
    try {
      out = gitRaw(['grep', '-l', '-I', '-E', GREP_RE, ...revs, '--']);
    } catch (e) {
      // git grep 无命中时退出码 1
      out = e.stdout ? String(e.stdout) : '';
    }
    const hits = String(out).split('\n').filter(Boolean)
      // 例外：扫描器自身的历史版本里含「模式字面量」（如用户名的正则源码），不是泄漏
      .filter((h) => !h.endsWith('tools/check-release.mjs'));
    if (hits.length) {
      histHits = hits.length;
      hits.slice(0, 10).forEach((h) => bad('敏感串（历史）', `${h}（提交:文件）`));
      if (hits.length > 10) notes.push(`历史命中还有 ${hits.length - 10} 处未逐条列出`);
    }
    say(` 3/5 敏感串（历史）   ${histHits ? '✗ ' + histHits + ' 处' : `✓ ${revs.length} 次提交`}`);
  } else {
    say(' 3/5 敏感串（历史）   （无提交，跳过）');
  }
} catch (e) {
  say(' 3/5 敏感串（历史）   （git 不可用，跳过）');
  notes.push('历史扫描被跳过：' + e.message.split('\n')[0]);
}

/* ── 4. 版本号一致性 ──────────────────────────────────── */
const readText = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');

const verFromFlow = (readText('scripts/flow.mjs').match(/FLOW_VERSION\s*=\s*'([\d.]+)'/) || [])[1] || '';
const verFromDemo = (readText('docs/demo.html').match(/<meta name="flow-version" content="([\d.]+)"/) || [])[1] || '';
const verFromBaseline = (readText('tools/tests/baseline/demo.html').match(/<meta name="flow-version" content="([\d.]+)"/) || [])[1] || '';
const verFromChangelog = (readText('CHANGELOG.md').match(/^##\s*v([\d.]+)/m) || [])[1] || '';

const versions = [
  ['scripts/flow.mjs FLOW_VERSION', verFromFlow],
  ['docs/demo.html', verFromDemo],
  ['tools/tests/baseline/demo.html', verFromBaseline],
  ['CHANGELOG.md 最新一节', verFromChangelog],
];
const missing = versions.filter(([, v]) => !v);
const uniq = [...new Set(versions.map(([, v]) => v).filter(Boolean))];

if (missing.length) missing.forEach(([k]) => bad('版本号', `${k} 里没读到版本号`));
else if (uniq.length > 1) bad('版本号', `四处不一致：${versions.map(([k, v]) => `${k}=${v}`).join('，')}`);
else if (verFromDemo && verFromDemo !== verFromChangelog) bad('版本号', 'demo.html 与 CHANGELOG 最新一节不一致');
say(` 4/5 版本一致性        ${problems.some((p) => p.startsWith('版本号')) ? '✗' : `✓ 全部 ${uniq[0] || '?'}`}`);

/* ── 5. 产物回归 + 包内容 ─────────────────────────────── */
if (SKIP_REGRESS) {
  say(' 5/5 产物回归          （--skip-regress，交给 CI 的独立步骤）');
} else {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'tools/tests/regress.mjs'), 'check', 'demo'], {
      cwd: ROOT, encoding: 'utf8',
    });
    const same = /逐字节相同/.test(out);
    if (!same) bad('产物回归', '产物与基线不一致（若非预期，确认差异后跑 regress.mjs save demo 重录）');
    say(` 5/5 产物回归          ${same ? '✓ 逐字节相同' : '✗ 有差异'}`);
  } catch (e) {
    bad('产物回归', 'regress.mjs 运行失败：' + String(e.message).split('\n')[0]);
    say(' 5/5 产物回归          ✗ 运行失败');
  }
}

/* ── 附加：.gitignore 关键规则是否还在（防手滑回退） ──── */
const gi = readText('.gitignore');
for (const rule of ['out/', '流程索引.json', 'tools/tests/.tmp/', '/index.html']) {
  if (!gi.includes(rule)) bad('.gitignore', `缺少关键规则「${rule}」`);
}
say(` ·  .gitignore 护栏    ${gi.includes('/index.html') ? '✓' : '✗ 缺 /index.html'}`);

/* ── 结论 ─────────────────────────────────────────────── */
say('');
if (notes.length) notes.forEach((n) => say('说明：' + n));
if (problems.length) {
  process.stdout.write(`✗ 发现 ${problems.length} 个问题，不能发布：\n`);
  problems.forEach((p) => process.stdout.write('  · ' + p + '\n'));
  process.exit(1);
}
process.stdout.write('✓ 可以发布（生成物 / 敏感串 / 历史 / 版本号 / 产物 全部通过）\n');
