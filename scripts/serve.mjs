#!/usr/bin/env node
/**
 * serve.mjs — 零依赖静态文件服务器：把产物目录暴露到局域网，手机连同一个 Wi-Fi 直接输网址就能看。
 *
 * 为什么需要：流程图是本地 HTML 文件，手机上没有「双击打开」这回事。
 * 把文件发到手机（微信里点开常被内置浏览器拦）不如让手机直接访问电脑上的这份。
 *
 * 用法：
 *   node serve.mjs [目录] [端口]        默认 . 与 8765
 *   node serve.mjs .\out 8765
 *
 * 注意：绑定 0.0.0.0，同一局域网内的任何设备都能读到该目录下的文件——只暴露产物目录，别指向工作区根。
 */

import { createServer } from 'node:http';
import { readFile, stat, readdir, rename, mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, relative, sep, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 8765);
/** 与本 skill 的 flow.mjs 约定一致的清单文件名。 */
const FLOW_MANIFEST_NAME = '流程索引.json';
/** 本次进程启动时间：用来判断浏览器看到的是不是最新版（自检页会显示）。 */
const BUILD = new Date().toLocaleString('zh-CN', { hour12: false });

/** 首页前端资源：../assets/home.css、home.js，渲染时内联回页面（产物仍是自包含的单页）。
 *  与 flow.mjs 里的 loadAsset 同一约定；这里不缓存，改了资源刷新页面即生效。
 *  统一成 LF、去掉 BOM：这些文本以前写在模板字符串里，换行天然是 LF；
 *  拆成独立文件后，Windows 上被 git / 编辑器存成 CRLF 也不能让输出变样。 */
const loadAsset = (name) => {
  const t = readFileSync(new URL('../assets/' + name, import.meta.url), 'utf8');
  return (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t).replace(/\r\n/g, '\n');
};

/** 名字归一化：去掉空格、去掉 -横版/-竖版，用来把 HTML 与它的 SVG / MMD 归成一家人。 */
const normName = (s) => String(s).replace(/\s+/g, '');
const famKey = (s) => normName(s.replace(/\.(html?|svg|mmd)$/i, '')).replace(/-(横版|竖版)/g, '');

/** 32 位 FNV-1a：够用来判断两份是不是同一份内容。 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 一次读取拿到一个流程图页面的全部信息：
 *   fp       流程语义指纹（只含流程本身，忽略页面级字段 → 同内容的不同渲染指纹相同）
 *   title    标题（直接来自 flow-data，比读 <head> 里的 meta 可靠 —— meta 可能落在 4KB 之外）
 *   节点/连线/分组数、状态汇总、两版画布尺寸
 * 解析不出来（不是本 skill 的页面）时返回 null。
 */
async function flowInfo(file) {
  try {
    const text = await readFile(file, 'utf8');
    const m = /<script id="flow-data" type="application\/json">([\s\S]*?)<\/script>/.exec(text);
    if (!m) return null;
    const d = JSON.parse(m[1].replace(/<\\\//g, '</'));
    const core = [
      d.title || '', d.subtitle || '', d.direction || '',
      (d.groups || []).map((g) => [g.id, g.label, (g.members || []).join(',')].join(':')).join(';'),
      (d.nodes || []).map((n) => [n.id, n.label, n.kind, n.status, n.time, n.owner, n.detail, n.note].join('~')).join(';'),
      (d.edges || []).map((e) => [e.from, e.to, e.label || '', e.style || ''].join('~')).join(';'),
    ].join('|');
    const counts = {};
    for (const n of d.nodes || []) if (n.status) counts[n.status] = (counts[n.status] || 0) + 1;
    const mm = /<meta name="flow-stats" content="([^"]*)"/.exec(text);
    const parts = mm ? mm[1].split('|') : [];
    return {
      fp: hash32(core),
      title: d.title || '',
      nodes: (d.nodes || []).length,
      edges: (d.edges || []).length,
      groups: (d.groups || []).length,
      status: Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(','),
      portrait: parts[3] || '',
      landscape: parts[4] || '',
    };
  } catch { return null; }
}

/** 读取同目录的「流程索引.json」（本 skill 生成的清单），拿标题/节点数/画布尺寸给首页卡片用。 */
async function readManifest(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, '流程索引.json'), 'utf8'));
    const map = new Map();
    for (const f of raw.flows ?? []) map.set(f.file, f);
    return map;
  } catch {
    return new Map();
  }
}

/** 清单缺失时，退而求其次：从 HTML 头部的 meta 里抠出标题与统计（窗口要够大，页面 CSS 有好几 KB）。 */
async function metaFromHtml(file) {
  try {
    const head = (await readFile(file, 'utf8')).slice(0, 131072);
    const pick = (name) => {
      const m = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(head);
      return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
    };
    const [nodes, edges, groups, portrait, landscape] = pick('flow-stats').split('|');
    return { title: pick('flow-title'), nodes, edges, groups, portrait, landscape };
  } catch {
    return {};
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const VIRTUAL = /(vpn|virtual|vmware|virtualbox|hyper-v|vethernet|loopback|radmin|tailscale|zerotier|docker|wsl|bluetooth)/i;

function lanUrls(port) {
  const good = [];
  const other = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const url = `http://${a.address}:${port}/`;
      // 169.254.x.x 是没拿到 DHCP 的自动地址；VPN/虚拟网卡手机也连不上
      if (a.address.startsWith('169.254.') || VIRTUAL.test(name)) other.push({ name, url });
      else good.push({ name, url });
    }
  }
  return { good, other };
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<script>
/* 首页只反映「总设置」（单张图的单独设置与锁定在各自页面里生效）。
   键统一为 JSON：{mode:'system|dark|light', ts}；旧版纯字符串也兼容。*/
(function(){try{
  var v=localStorage.getItem('flowviz-theme'), o={mode:'system',ts:0};
  if(v){ try{ o=JSON.parse(v); }catch(e){ o={mode:v,ts:0}; } }
  var d=(o.mode==='system')?((window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'):o.mode;
  document.documentElement.setAttribute('data-theme', d==='light'?'light':'dark');
}catch(e){}})();
</script>
<style>\n${loadAsset('home.css')}</style>
</head><body>${body}</body></html>`;
}

/** 自检块（?diag=1）：页面自己把关键状态显示出来，便于远程判断问题。 */
function diagBox(build, show) {
  if (!show) return '';
  return `<div class="diag"><b>自检</b><div id="diag-list" class="dline">检测中…</div>
    <div class="dline">服务进程启动时间：${build}　（如果你看到的这个时间很旧，说明浏览器用了缓存的旧页面 → Ctrl+F5 强刷）</div>
  </div>`;
}

/** 重复流程图提示框：同一标题下多个文件时，按「内容是否相同」给不同的处理动作。 */
function dupBox(dups, canAct) {
  if (!dups || !dups.length) return '';
  const groups = dups.map((d) => {
    const rows = d.files.map((c, i) => `<div class="dupfile${i === 0 ? ' keep' : ''}">
      <code>${c.name}</code><span>${c.mtime || ''}${c.size ? ' · ' + Math.round(c.size / 1024) + ' KB' : ''}${i === 0 ? ' · 最新' : ''}</span></div>`).join('');
    let actions = '<span class="duphint">在电脑上打开这一页才能一键处理（手机 / 本地文件模式只读）</span>';
    if (canAct) {
      actions = d.same
        ? `<button class="mini act" data-act="trash" data-remove="${d.files.slice(1).map((c) => c.name).join('|').replace(/"/g, '&quot;')}">只保留最新的一份（其余 ${d.files.length - 1} 个移入回收文件夹）</button>`
        : d.files.slice(0, 3).map((c) => {
          const suggest = c.name.replace(/\.html?$/i, '') + '（旧版 ' + (c.mtime || '').slice(0, 10) + '）.html';
          return `<button class="mini act" data-act="rename" data-file="${c.name.replace(/"/g, '&quot;')}" data-suggest="${suggest.replace(/"/g, '&quot;')}">给「${c.name}」改名…</button>`;
        }).join(' ');
    }
    return `<div class="dupgroup">
      <div class="duptitle">${d.title}　<span class="duptag ${d.same ? 'same' : 'diff'}">${d.files.length} 个文件 · ${d.same ? '内容相同，可以只留一个' : '内容不同，建议改名区分'}</span></div>
      ${rows}
      <div class="dupact">${actions}</div>
    </div>`;
  }).join('');
  return `<div class="dupbox"><b>⚠️ 发现 ${dups.length} 组重名流程图</b>
    <p class="duplead">标题一样但可能是不同版本。「内容相同」的可以只留最新那份（其余移入回收文件夹，可随时取回）；「内容不同」的不会删，只帮你改名。</p>
    ${groups}</div>`;
}

/** 首页顶部：面包屑 + 人话版说明 + 检索/排序 + 明暗设置。 */
function homeHeader(count, crumb, rootPath) {
  return `<div class="crumbs">${crumb}</div>
  <div class="head">
    <h1>🪄 流程图 · 共 ${count} 张</h1>
    <button class="gear" id="help-btn" title="如何使用（点开看说明）" aria-controls="help" aria-expanded="false"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M6.3 6.2a1.8 1.8 0 113 1.4c-.6.4-.9.7-.9 1.4"/><circle cx="8" cy="11.6" r=".7" fill="currentColor" stroke="none"/></svg><span>如何使用</span></button>
    <button class="gear" id="gear" title="显示设置"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.4"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3"/></svg>显示设置</button>
  </div>
  <p class="sub">点卡片打开；手机和电脑看到的是同一批文件。</p>
  <div class="pathbox">
    <span class="plabel">文件在磁盘这里</span>
    <code id="rootpath">${rootPath}</code>
    <button class="mini" id="copypath">复制路径</button>
  </div>
  <div class="bars">
    <input id="filter" type="search" placeholder="过滤：标题 / 文件名">
    <select id="sort">
      <option value="recent">最近打开优先</option>
      <option value="name">按名称</option>
      <option value="mtime">按修改时间</option>
    </select>
    <span id="sum" class="sum"></span>
  </div>
  <p class="quickhint">
    <span class="only-pc">点卡片看图。看图时可滚轮缩放、按住拖拽平移；外观随时在右上角「显示设置」里改。</span>
    <span class="only-touch">点卡片看图。图上可单指拖动、双指缩放、点环节看详情；外观在右上角「显示设置」里改。</span>
  </p>
  <div id="help">
    <p class="st">三件最重要的事</p>
    <div class="row"><span class="k">① 看图</span><span>点卡片打开流程图；在图上<b>点任意环节</b>看时间 / 负责人 / 说明，再点空白收起。底部工具栏能切 <b>竖版 / 横版</b>、切明暗、导出 SVG / PNG；<b>🔒</b> 只锁这一张的颜色。</span></div>
    <div class="row"><span class="k">② 搜索</span><span>搜环节名、负责人、说明。结果清单里：<b>蓝边</b>=标题 / id / 时间命中，<b>黄色点线</b>=只在说明或备注里命中（所以命中数常比图上看到的多）。<b>↑ ↓</b> 或 <b>Enter</b> 连着翻命中，<b>Esc</b> 清空；勾选「自动聚焦命中」会跟着跳到那一步。</span></div>
    <div class="row"><span class="k">③ 键盘</span><span><b>Tab</b> 停在每个环节上、<b>Enter</b>/空格 打开详情；<b>+</b> <b>-</b> 缩放、<b>0</b> 适配整幅。抽屉（全部流程图）用 <b>Esc</b> 关闭。</span></div>
    <p class="st" style="margin-top:14px">手机上看</p>
    <div class="row"><span class="k">同一 Wi-Fi</span><span>在电脑上跑 <code>node scripts/serve.mjs &lt;产物目录&gt; 8765</code>，手机浏览器打开 <code>http://&lt;电脑的局域网IP&gt;:8765/</code>。手机端：单指拖动、双指缩放、轻点环节看详情。</span></div>
    <p class="st" style="margin-top:14px">更新与文档</p>
    <div class="row"><span class="k">图是快照</span><span>产物是自包含 HTML，<b>不会自动更新</b>：改了流程要重新渲染。首页会把用旧版本渲染的文件标成「旧版渲染」，跑 <code>node scripts/flow.mjs refresh &lt;目录&gt;</code> 一次全刷。</span></div>
    <div class="row"><span class="k">删了还在？</span><span>侧栏和这个首页在 <code>file://</code> 下都是<b>生成当时的清单快照</b>：删掉文件后跑一次 <code>node scripts/flow.mjs index &lt;目录&gt;</code>（或 <code>refresh</code>）就会更新；用 <code>node scripts/serve.mjs &lt;目录&gt; 8765</code> 以 HTTP 打开则是实时刷新，页面里删/改名后服务器会自动重建清单。</span></div>
    <div class="row"><span class="k">文档在哪</span><span>技能目录里（用编辑器打开）：<code>README.md</code> 给人看 · <code>SKILL.md</code> 给 agent 看 · <code>CHANGELOG.md</code> 改了什么 · <code>docs/interfaces.md</code> 接口契约。</span></div>
  </div>
  <div id="settings">
    <p class="st">外观</p>
    <div class="opts">
      <div class="opt" data-mode="system">跟随系统<small><span class="only-pc">跟着 Windows 的深色设置走</span><span class="only-touch">跟着手机的深色模式走</span></small></div>
      <div class="opt" data-mode="dark">始终深色<small>暗环境下看着舒服</small></div>
      <div class="opt" data-mode="light">始终浅色（米色）<small>白天、投屏、打印更清楚</small></div>
    </div>
    <p class="st" style="margin-top:14px">只改某一张 / 锁定</p>
    <p class="minihint">在流程图页面里能单独调这一张的明暗，也能 🔒 锁定它。<b>哪边后改听哪边</b>：先改单张、再改这里 → 全部跟着这里变；先改这里、再改单张 → 只动那一张。</p>
  </div>`;
}

/** 卡片下方：详细说明（默认折叠，避免手机上把卡片顶到屏幕外）。 */
function homeExtras() {
  return `<details class="howto">
    <summary>如何使用 / 搜索为什么会出现两个命中</summary>
    <div class="tip">
      <div class="row"><span class="k">看图时</span><span>点任意环节看时间 / 负责人 / 说明；底部工具栏能切 <b>竖版 / 横版</b>、明暗、导出图片；右上角 🏠 回本页；🔒 可以锁定这张图的颜色。</span></div>
      <div class="row"><span class="k">搜到两个</span><span>搜索会连<b>说明和备注</b>一起找，所以有时命中数比你在图上看到的多：<span class="swatch"></span> 蓝边 = 标题 / id / 时间 / 负责人命中；<span class="swatch soft"></span> 橙色虚线圈 = 只在说明或备注里命中（计数会写明"几个只在说明/备注里"）。搜索会自动展开右侧结果清单，↑/↓ 或 Enter 逐个跳。</span></div>
      <div class="row"><span class="k">手势（手机）</span><span>单指拖动平移、双指捏合缩放、轻点节点看详情、点空白收起；电脑上则是滚轮缩放 + 按住拖拽。</span></div>
    </div>
  </details>`;
}

/** 署名：显示在首页右下角。改这一行即可；留空字符串则不显示。 */
const SIGNATURE = '由 <你的名字> 制作 · 感谢 <朋友的名字> 参与测试';

/** 首页脚注：设置与主题说明。 */
function homeFooter(port, manifestPath, fileMode) {
  const fileLine = fileMode
    ? `当前是<b>本地文件模式</b>（你直接双击打开 HTML）：手机要访问就得起服务 —— 双击工作区里的 <code>打开流程图首页.bat</code>，或自己跑 <code>node serve.mjs &lt;目录&gt; ${port}</code>，然后手机浏览器打开打印出来的那个地址。<br>`
    : '';
  return `<p class="foot">
    外观偏好只存在你这台设备的浏览器里，<b>服务重启也不会丢</b>；换 IP、换端口或清浏览器数据才会重置。<br>
    ${fileLine}清单文件：<code>${manifestPath}</code>。${fileMode ? '' : `这一页由 <code>node serve.mjs &lt;目录&gt; ${port}</code> 动态生成，不占磁盘空间；要停掉服务，跟我说一声或关掉那个终端。`}
  </p>${SIGNATURE ? `\n  <p class="sign">${SIGNATURE}</p>` : ''}`;
}

/** 首页脚本：设置面板 + 明暗切换（与流程图页面共用 flowviz-theme）。 */
function homeScript() {
  return `<script>\n${loadAsset('home.js')}</script>`;
}

/**
 * 生成「首页」HTML。既给 HTTP 服务用，也给 flow.mjs 写出静态 index.html 用
 * （本地 file:// 打开时浏览器只会给一个纯文件名目录列表，那份静态页就是替代品）。
 * @param {{dir:string, baseHref?:string, rootPath?:string, port?:number, build?:string, fileMode?:boolean, diag?:boolean, crumb?:string}} opts
 */
export async function buildHome(opts) {
  const {
    dir, baseHref = '/', rootPath = dir, port = Number(process.env.FLOW_PORT || 8765),
    build = BUILD, fileMode = false, diag = false, crumb,
  } = opts;

  const dirents = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
  const names = new Set(dirents.map((e) => e.name));
  const manifest = await readManifest(dir);

  // 旧版检测：清单里记了每个产物的渲染器版本，与清单自身的 generatorVersion 比对
  const staleFiles = new Set();
  let generatorVersion = '';
  try {
    const mf = JSON.parse(readFileSync(join(dir, FLOW_MANIFEST_NAME), 'utf8'));
    generatorVersion = mf.generatorVersion || '';
    if (generatorVersion) {
      for (const f of mf.flows || []) if (f.version !== generatorVersion) staleFiles.add(f.file);
    }
  } catch (e) { /* 没有清单就算了 */ }

  const cards = [];
  const others = [];
  const dirs = [];
  // 缩略图索引：把 SVG 名字归一化（去掉空格、去掉 -横版/-竖版）后按流程图名匹配，
  // 这样「示例流程 - 副本.html」也能配上「示例流程-横版 - 副本.svg」（后缀位置不同）
  const normName = (s) => s.replace(/\s+/g, '');
  const thumbMap = new Map();
  for (const n of names) {
    if (!/\.svg$/i.test(n)) continue;
    const base = normName(n.replace(/\.svg$/i, ''));
    const key = base.replace(/-(横版|竖版)/g, '');
    const isLand = base.indexOf('-横版') >= 0;
    const prev = thumbMap.get(key);
    if (!prev || (isLand && !prev.land)) thumbMap.set(key, { name: n, land: isLand });
  }
  for (const e of dirents) {
    const href = baseHref + encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '');
    if (e.isDirectory()) { dirs.push({ e, href }); continue; }
    if (/^index\.html?$/i.test(e.name)) continue;            // 首页自己，不要列成卡片
    if (!/\.html?$/i.test(e.name)) { others.push({ e, href }); continue; }
    const dev = e.name.startsWith('【') || e.name.startsWith('_');
    const stem = e.name.replace(/\.html?$/i, '');
    // 缩略图：优先横版 SVG，其次竖版，最后退回同名 SVG（副本类文件常是这个命名）
    const hit = thumbMap.get(normName(stem));
    const thumb = hit ? hit.name
      : names.has(stem + '.svg') ? stem + '.svg' : null;
    const mf = manifest.get(e.name) || null;
    // 指纹一律现算：清单（流程索引.json）里只有标题/计数，没有语义指纹，
    // 若在清单里就不算，会出现"同一份内容一个有一个没有"从而漏判重复（踩过）。
    const fi = dev ? null : await flowInfo(join(dir, e.name));
    if (!dev && !mf && !(fi && fi.nodes)) { others.push({ e, href }); continue; }
    const info = {
      title: (fi && fi.title) || (mf && mf.title) || '',
      nodes: (fi && fi.nodes) || (mf && mf.nodes) || 0,
      edges: (fi && fi.edges) || (mf && mf.edges) || 0,
      groups: (fi && fi.groups) || (mf && mf.groups) || 0,
      status: (fi && fi.status) || (mf && mf.status) || '',
      portrait: (fi && fi.portrait) || (mf && mf.portrait) || '',
      landscape: (fi && fi.landscape) || (mf && mf.landscape) || '',
      fp: fi && fi.fp ? fi.fp : null,
    };
    const bits = [];
    if (info.nodes) bits.push(`${info.nodes} 环节`);
    if (info.edges) bits.push(`${info.edges} 连接`);
    if (info.groups) bits.push(`${info.groups} 分组`);
    if (info.landscape) bits.push(`横版 ${info.landscape}`);
    if (info.portrait) bits.push(`竖版 ${info.portrait}`);
    cards.push({
      name: e.name, href, dev, thumb,
      title: info.title || stem,
      meta: bits.join(' · ') || '流程图',
      status: info.status || '',
      mtimeMs: info.mtimeMs || 0,
      mtime: info.mtime || (await stat(join(dir, e.name)).then((s) => new Date(s.mtimeMs).toLocaleString('zh-CN', { hour12: false })).catch(() => '')),
      size: await stat(join(dir, e.name)).then((s) => s.size).catch(() => 0),
      fp: dev ? null : (info.fp || null),
    });
  }

  // ── 重复检测 ──
  // 先按「流程语义指纹」分组：内容相同就是重复，跟标题、文件名都无关
  // （无标题的流程 —— 例如从 Mermaid 生成的 —— 标题会退回文件名，只按标题分组会漏判）。
  // 再按标题分组，把"同名但内容不同"的挑出来（这类不删，只提示改名）。
  const byFp = new Map();
  const byTitle = new Map();
  for (const c of cards) {
    if (c.dev) continue;
    if (c.fp) {
      if (!byFp.has(c.fp)) byFp.set(c.fp, []);
      byFp.get(c.fp).push(c);
    }
    if (!byTitle.has(c.title)) byTitle.set(c.title, []);
    byTitle.get(c.title).push(c);
  }
  const byMtime = (list) => list.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const dups = [];
  const grouped = new Set();
  for (const list of byFp.values()) {
    if (list.length < 2) continue;
    for (const c of list) grouped.add(c.name);
    dups.push({ title: list[0].title || list[0].name, files: byMtime(list), same: true });
  }
  for (const [title, list] of byTitle) {
    const rest = list.filter((c) => !grouped.has(c.name));
    if (rest.length < 2) continue;
    dups.push({ title, files: byMtime(rest), same: false });
  }

  // 同名流程图（例如 xxx-副本.html）光看标题分不清，这时把文件名也显示出来
  const titleCount = {};
  for (const c of cards) if (staleFiles.has(c.name)) c.stale = true;
  for (const c of cards) titleCount[c.title] = (titleCount[c.title] || 0) + 1;

  const card = (c) => `<a class="card${c.dev ? ' dev-row' : ''}" href="${c.href}" data-file="${c.name.replace(/"/g, '&quot;')}" data-status="${c.status}" data-mtime="${c.mtimeMs}" title="${c.name.replace(/"/g, '&quot;')}">
    <div class="thumb">${c.thumb ? `<img src="${encodeURIComponent(c.thumb)}" alt="" loading="lazy">` : '<span class="noimg">无预览图</span>'}</div>
    <div class="cbody">
      <span class="ctitle">${c.title}</span>
      ${titleCount[c.title] > 1 ? `<span class="cfile">${c.name}</span>` : ''}
      <span class="cmeta">${c.meta}</span>
      <span class="badge${c.dev ? ' dev' : ' touchonly'}">${c.dev ? '并排对照页 · 给电脑看的' : (fileMode ? '流程图' : '手机上点这个')}</span>
${c.stale ? '<span class="badge stale">旧版渲染</span>' : ''}
    </div>
  </a>`;

  const crumbHtml = crumb || (fileMode
    ? `<b>📁 ${basename(dir)}（本地文件夹）</b>`
    : `<a href="/">🏠 流程图（当前）</a>`);

  const body = diagBox(build, diag)
    + homeHeader(cards.length, crumbHtml, rootPath, join(rootPath, FLOW_MANIFEST_NAME))
    + dupBox(dups, !!opts.canAct)
    + `<div class="tip"><b>workflow-visualizer v${generatorVersion || '?'}</b>`
              + ` · 文档在这个技能目录里（用编辑器打开）：<code>README.md</code> 给人看 · <code>SKILL.md</code> 给 agent 看 · <code>CHANGELOG.md</code> 改了什么`
              + (cards.some((c) => c.stale) ? `<div class="row"><span class="k">有 ${cards.filter((c) => c.stale).length} 个文件是旧版渲染的</span><span>跑 <code>node scripts/flow.mjs refresh &lt;目录&gt;</code> 全部刷新</span></div>` : '')
              + '</div>'
      + (cards.length ? `<div class="grid">${cards.map(card).join('')}</div>` : '<small>这个目录里还没有流程图</small>')
    + (dirs.length ? `<p class="st2">子目录</p>` + dirs.map(({ e, href }) => `<a class="file" href="${href}">📁 ${e.name}</a>`).join('') : '')
    + (others.length ? `<p class="st2">其它文件（矢量图 / Mermaid 源码 / 清单）</p><div class="plain">${others.map(({ e, href }) => `<a href="${href}">${e.name}</a>`).join('')}</div>` : '')
    + homeExtras()
    + homeFooter(port, join(rootPath, FLOW_MANIFEST_NAME), fileMode)
    + homeScript();
  return page('流程图', body);
}

/**
 * 文件被移动/改名后，把**派生产物**同步刷新：
 *   1) 静态首页 index.html（本地 file:// 打开时用的就是它，不刷新会一直显示旧名单）
 *   2) 流程索引.json（去掉已经不在目录里的条目）
 * 早期版本只移动文件、不刷新这两样，用户看到"回收了首页还在显示"。
 */
async function refreshDerived(dir) {
  const out = {};
  try {
    const html = await buildHome({ dir, baseHref: '', rootPath: dir, fileMode: true, canAct: false });
    await writeFile(join(dir, 'index.html'), html, 'utf8');
    out.index = true;
  } catch (e) { out.indexError = e.message; }
  try {
    const p = join(dir, FLOW_MANIFEST_NAME);
    const m = JSON.parse(await readFile(p, 'utf8'));
    const names = new Set(await readdir(dir));
    const before = (m.flows ?? []).length;
    m.flows = (m.flows ?? []).filter((f) => names.has(f.file));
    m.updated = new Date().toLocaleString('zh-CN', { hour12: false });
    await writeFile(p, JSON.stringify(m, null, 2) + '\n', 'utf8');
    out.manifest = { before, after: m.flows.length };
  } catch (e) { out.manifestError = e.message; }
  return out;
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    // ── 重名流程图的处理动作：只允许本机（127.0.0.1）调用；删除一律改成"移入回收文件夹" ──
    if (req.method === 'POST' && urlPath.endsWith('/__flow/act')) {
      const ip = req.socket.remoteAddress || '';
      const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      const reply = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      if (!local) { reply(403, { ok: false, error: '只允许在电脑本机上操作（当前来自 ' + ip + '）' }); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload = {};
      try { payload = JSON.parse(body.replace(/^\uFEFF/, '') || '{}'); } catch { reply(400, { ok: false, error: '请求体不是 JSON' }); return; }
      const safe = (n) => typeof n === 'string' && n.length > 0 && n.length < 200
        && !/[\\/]/.test(n) && n !== '.' && n !== '..';
      const names = await readdir(root);
      const familyOf = (name) => {
        const key = famKey(name);
        return names.filter((n) => /\.(html?|svg|mmd)$/i.test(n) && famKey(n) === key);
      };

      if (payload.op === 'trash') {
        // remove：要移走的文件列表（HTML 或 SVG/MMD 都行，会连同它的同名 SVG/MMD 一起走）
        const list = (Array.isArray(payload.remove) ? payload.remove : [payload.file]).filter((n) => safe(n));
        if (!list.length) { reply(400, { ok: false, error: '没有指定要移走的文件' }); return; }
        for (const n of list) {
          if (!names.includes(n)) { reply(404, { ok: false, error: '文件不存在：' + n }); return; }
        }
        const dirName = '.trash-' + new Date().toISOString().slice(0, 10);
        await mkdir(join(root, dirName), { recursive: true });
        const moved = [];
        const seen = new Set();
        for (const n of list) {
          for (const f of familyOf(n)) {
            if (seen.has(f)) continue;
            seen.add(f);
            await rename(join(root, f), join(root, dirName, f));
            moved.push(f);
          }
        }
        const derived = await refreshDerived(root);
        reply(200, { ok: true, op: 'trash', moved, trash: dirName, derived });
        return;
      }
      if (payload.op === 'rename') {
        const html = String(payload.file || '');
        if (!safe(html) || !/\.html?$/i.test(html)) { reply(400, { ok: false, error: '文件名不合法' }); return; }
        if (!names.includes(html)) { reply(404, { ok: false, error: '文件不存在：' + html }); return; }
        const to = String(payload.to || '').trim();
        if (!safe(to) || !/\.html?$/i.test(to)) { reply(400, { ok: false, error: '新文件名不合法（不能含路径分隔符，要以 .html 结尾）' }); return; }
        if (names.includes(to)) { reply(409, { ok: false, error: '已存在同名文件：' + to }); return; }
        const newStem = to.replace(/\.html?$/i, '');
        const out = [];
        for (const n of familyOf(html)) {
          const base = normName(n.replace(/\.(html?|svg|mmd)$/i, ''));
          const ext = n.slice(n.replace(/\.(html?|svg|mmd)$/i, '').length);
          const variant = /-横版/.test(base) ? '-横版' : (/-竖版/.test(base) ? '-竖版' : '');
          await rename(join(root, n), join(root, newStem + variant + ext));
          out.push(newStem + variant + ext);
        }
        const derived = await refreshDerived(root);
        reply(200, { ok: true, op: 'rename', renamed: out, derived });
        return;
      }
      reply(400, { ok: false, error: '未知操作：' + payload.op });
      return;
    }

    const target = resolve(join(root, urlPath));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403).end('403');
      return;
    }
    const info = await stat(target).catch(() => null);
    if (!info) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 找不到：' + urlPath); return; }

    if (info.isDirectory()) {
      const depthSegs = urlPath.split('/').filter(Boolean);
      let acc = '/';
      const crumbParts = [`<a href="/">🏠 流程图${depthSegs.length ? '' : '（当前）'}</a>`];
      depthSegs.forEach((seg, i) => {
        acc += encodeURIComponent(seg) + '/';
        const last = i === depthSegs.length - 1;
        crumbParts.push(`<span class="sep2">/</span>` + (last
          ? `<b>${decodeURIComponent(seg)}（当前）</b>`
          : `<a href="${acc}">${decodeURIComponent(seg)}</a>`));
      });
      const html = await buildHome({
        dir: target,
        baseHref: urlPath.endsWith('/') ? urlPath : urlPath + '/',
        rootPath: root,
        port,
        build: BUILD,
        diag: /[?&]diag=1/.test(req.url || ''),
        crumb: crumbParts.join(' '),
        canAct: ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || ''),
      });
      // no-store：目录页是动态生成的，浏览器缓存过就看不到新版（踩过一次）
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

// 只有直接运行本文件时才起服务；被 flow.mjs import 时只取 buildHome()
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) server.listen(port, '0.0.0.0', () => {
  const { good, other } = lanUrls(port);
  process.stdout.write('flow-serve: 目录 ' + root + '\n');
  process.stdout.write('  本机    http://127.0.0.1:' + port + '/\n');
  if (good.length) {
    process.stdout.write('  手机 →  ' + good[0].url + '   ✔ 用这个（' + good[0].name + '）\n');
    for (const { name, url } of good.slice(1)) process.stdout.write('          ' + url + '   (' + name + ')\n');
  } else {
    process.stdout.write('  手机 →  没找到可用的局域网地址，先让电脑连上 Wi-Fi\n');
  }
  for (const { name, url } of other) process.stdout.write('  (忽略)  ' + url + '   ' + name + ' —— VPN/虚拟/未获取地址，手机连不上\n');
  process.stdout.write('  提示：手机与电脑连同一个 Wi-Fi；Windows 首次会弹防火墙询问，勾「专用网络」允许入站。\n');
});
