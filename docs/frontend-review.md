# 前端改进建议（assets/app.js · app.css · svg.css · shell.html）

格式：问题 → 影响 → 最小改法（按文件）→ 验证方式。不改后端、不加依赖、不动 id / 类名 / data-* / localStorage 键 / 视图语义；只新增属性和少量规则。

**怎么得出的**：全部来自读代码 + 脚本算对比度（`contrast.py`，可复跑）。沙箱里没有浏览器，**触控手感和实际布局我没在设备上跑过**，标「需实机」的条目请在手机上过一遍。

## 优先级

| 级 | 条目 | 一句话 |
|---|---|---|
| P0 | C1 | `--hit` 在页面 CSS 里没定义：搜索结果清单的高亮和当前行描边**完全不生效** |
| P0 | B3 | 全部流程图抽屉：`aria-hidden` 永远是 true，关着时还能 Tab 进屏外按钮 |
| P0 | B5 | 浅色主题页面小字对比度 2.3–3.9:1，全部低于 4.5:1 |
| P1 | B1 B2 | 节点键盘到不了；全站没有焦点环 |
| P1 | A1 A2 A3 A4 | 捏合每帧写 localStorage；双指不能平移；触屏双通路；触控目标 24–34px |
| P2 | 其余 | 状态播报、reduced-motion、storage 同步、面板渲染入口、浅色分组带标题字、命中高亮 |

---

## 一、手机体验

### A1 捏合 / 滚轮每一帧都同步写 localStorage　【P1】
- **问题**：`zoomAt()` 末尾调 `rememberZoom()`，后者 `lsSet`（同步 `localStorage.setItem`）。双指捏合每个 `touchmove` 都进来，约 60 次/秒。
- **影响**：低端手机捏合时主线程被同步 I/O 卡住，是"跟手度"差的常见原因。
- **最小改法**（app.js）：
```diff
-  function rememberZoom(v){ lsSet('flowviz-zoom:'+SELF+':'+variantKey(v), {k:v.view.K, ts:Date.now()}); }
+  var zoomT=null;
+  function rememberZoom(v){ clearTimeout(zoomT); zoomT=setTimeout(function(){ lsSet('flowviz-zoom:'+SELF+':'+variantKey(v), {k:v.view.K, ts:Date.now()}); },250); }
```
- **验证**：控制台先 `var n=0,s=Storage.prototype.setItem;Storage.prototype.setItem=function(){n++;return s.apply(this,arguments)}`，滚轮连续滚 1 秒后看 `n`：改前约 60，改后 1。键名与值形状没变。

### A2 双指只缩放、不平移；双指变单指会跳　【P1，需实机】
- **问题**：`pinch` 只存了两指距离 `d`。`zoomAt` 以当前中点为锚点缩放，但**中点自身的移动被丢掉**，所以双指拖着走时画面不跟。另外 2→1 指时 `drag` 为 null，剩下那根手指要先抬起再按才能拖。
- **影响**：手机上"边捏边挪"这个最自然的手势缺了一半。
- **最小改法**（app.js，touchstart / touchmove / touchend 三处）：
```diff
 touchstart: else if(e.touches.length===2){ drag=null; pinch={d:touchDist(e)}; }
+ touchstart: else if(e.touches.length===2){ var r0=v.svg.getBoundingClientRect(); drag=null;
+   pinch={d:touchDist(e), x:(e.touches[0].clientX+e.touches[1].clientX)/2-r0.left, y:(e.touches[0].clientY+e.touches[1].clientY)/2-r0.top}; }

 touchmove（两指分支）:
-  if(pinch&&pinch.d>0) zoomAt(v, (e.touches[0].clientX+e.touches[1].clientX)/2-r.left, (e.touches[0].clientY+e.touches[1].clientY)/2-r.top, d/pinch.d);
-  pinch={d:d}; e.preventDefault(); return;
+  var mx=(e.touches[0].clientX+e.touches[1].clientX)/2-r.left, my=(e.touches[0].clientY+e.touches[1].clientY)/2-r.top;
+  if(pinch&&pinch.d>0){ zoomAt(v,mx,my,d/pinch.d); v.view.TX+=mx-pinch.x; v.view.TY+=my-pinch.y; paintActive(); }
+  pinch={d:d,x:mx,y:my}; e.preventDefault(); return;

 touchend 里 `if(!e.touches.length){ drag=null; pinch=null; }` 之前加：
+  if(e.touches.length===1){ var t1=e.touches[0]; drag={n:n,x:t1.clientX,y:t1.clientY,ox:v.view.TX,oy:v.view.TY,moved:true}; pinch=null; }
```
- **验证**（需实机 / Chrome 设备模拟的双指）：捏合同时整体向右挪 100px，缩放中心应跟手；捏完留一指继续拖，不应跳动，也不应触发选中（`moved:true`）。

### A3 轻点后触屏与鼠标两条通路各跑一遍　【P1】
- **问题**：`touchend` 已处理轻点选中，但没 `preventDefault`，浏览器随后补发 `mousedown / mouseup / click`，`mouseup` 又 `select()` 一次。
- **影响**：每次轻点 `setPanel → relayout → renderPanel` 执行两遍；`mousedown` 还会重建 `drag`，和触屏状态互相覆盖。目前不出错，但属于"碰巧没坏"。
- **最小改法**（app.js，touchend 的轻点分支末尾）：
```diff
         if(g) select(g.getAttribute('data-id')); else select(null);
+        e.preventDefault();   // 轻点已处理，别再让浏览器补发鼠标事件
```
  `touchend` 监听器没设 `passive`，可以直接 `preventDefault`。
- **验证**：在 `select()` 首行临时 `console.count('select')`，手机模式下轻点一个节点，改前计数 +2，改后 +1。

### A4 窄屏触控目标偏小　【P1，需实机】
- **问题**：≤600px 页脚图标按钮约 34×28px，`.legend` 胶囊约 24px 高。
- **影响**：低于常见的 40–48px 触控建议；WCAG 2.2 的 2.5.8 最低线是 24×24，图例胶囊只是勉强踩线。
- **最小改法**（app.css，加在 ≤600px 块之后）：
```css
@media (pointer:coarse){
  button,a.icon-btn{min-height:40px;min-width:40px;justify-content:center}
  .legend button{min-height:36px}
  .hit-nav button{min-height:36px;min-width:36px}
}
@supports (max-height:1dvh){ @media (max-width:600px){ aside{max-height:58dvh} } }  /* 地址栏收放时不抖 */
```
- **取舍**：按钮变大后页脚在 390px 宽会换成两行，画布约少 48px。若不想要，可在 ≤600px 隐藏 `#export-svg,#export-png,#mmd-toggle`（手机上很少用）——这是产品取舍，我不替你定。
- **验证**：设备模拟 390×844，量页脚高度与每个按钮的 `getBoundingClientRect()`；画布高度别低于改前的 85%。

---

## 二、可访问性

### B1 节点只响应点击，键盘到不了　【P1】
- **问题**：`g.node` 没有 `tabindex` / `role`，核心功能"选中环节看详情"键盘用户做不到。
- **影响**：键盘 / 读屏用户只能用搜索结果清单间接到达。
- **最小改法**（app.js 初始化处加，不动后端生成的 SVG；svg.css 加焦点样式）：
```js
eachSvg(function(s){
  s.querySelectorAll('.node').forEach(function(g){
    var n=meta[g.getAttribute('data-id')]||{};
    g.setAttribute('tabindex','0'); g.setAttribute('role','button');
    g.setAttribute('aria-label',(n.label||n.id)+(n.statusLabel?'，'+n.statusLabel:'')+(n.time?'，'+n.time:''));
  });
  s.addEventListener('keydown',function(e){
    var g=e.target.closest&&e.target.closest('.node');
    if(g&&(e.key==='Enter'||e.key===' ')){ e.preventDefault(); select(g.getAttribute('data-id')); }
  });
});
```
```css
/* svg.css */
.node:focus{outline:none}
.node:focus-visible .node-bg{stroke:var(--accent);stroke-width:3;stroke-dasharray:none}
```
  导出 SVG 时 `svgSource()` 克隆的是活 DOM，会带上这些属性；想保持导出与以前一致，在克隆后加一行：`c.querySelectorAll('[tabindex],[role],[aria-label]').forEach(function(x){x.removeAttribute('tabindex');x.removeAttribute('role');x.removeAttribute('aria-label');});`
- **验证**：键盘 Tab 能依次停在各节点并出现描边，Enter / 空格打开详情；隐藏的那版 SVG 是 `display:none`，不会进 Tab 序。

### B2 全站没有焦点环，搜索框 / Mermaid 框还 `outline:none`　【P1】
- **问题**：`app.css` 里没有 `:focus-visible`；按钮只有 hover 样式。
- **最小改法**（app.css 末尾）：
```css
:focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:2px}
.search input:focus-visible,#mmd-src:focus-visible{outline:none}      /* 搜索框已有 .search:focus-within 描边，再补一圈 */
.search:focus-within{box-shadow:0 0 0 2px var(--accent-text,var(--accent))}
#mmd-src:focus-visible{outline:2px solid var(--accent-text,var(--accent))}
```
- **对比度**：深色 `--accent #5aa9ff` 对面板 6.90:1；浅色原 `--accent #bf6b3a` 对画布仅 2.86:1（<3:1），改用 B5 的 `--accent-text #884c29`：对面板 5.90、对画布 4.93、对节点底 6.63。
- **验证**：Tab 遍历整页，每个可聚焦元素都能看见焦点；深浅两套各截一张。

### B3 全部流程图抽屉：读屏看不见，关着还能 Tab 进去　【P0】
- **问题**：shell.html 里 `<div id="flows-drawer" aria-hidden="true">` 从未被改过；关闭时只是 `translateX(102%)` 移出屏幕，里面的按钮和链接仍可聚焦。
- **影响**：打开后对读屏是隐藏的（ARIA 规范明确不允许在可聚焦内容外加 `aria-hidden`）；关着时 Tab 会掉进屏外。
- **最小改法**：
```diff
 shell.html
-<div id="flows-drawer" aria-hidden="true">
+<div id="flows-drawer" role="dialog" aria-modal="true" aria-label="全部流程图" aria-hidden="true">
```
```css
/* app.css */
#flows-drawer:not(.open){visibility:hidden;transition:transform .18s ease,visibility 0s .18s}
```
```diff
 /* app.js openFlows */
+  var dr=document.getElementById('flows-drawer'); dr.setAttribute('aria-hidden',open?'false':'true');
+  if(open) document.getElementById('flows-close').focus(); else document.getElementById('flows-toggle').focus();
 /* app.js 全局 keydown，最前面 */
+  if(e.key==='Escape'&&document.getElementById('flows-drawer').classList.contains('open')){ openFlows(false); return; }
```
- **验证**：关着时 Tab 不会停到抽屉里；打开后焦点落在 ✕，Esc 关闭并回到触发按钮；读屏能读到对话框名称。

### B4 状态播报与按钮状态　【P2】
- **问题**：`#search-count`、`#toast` 变化时读屏没有任何播报；图例 / 版式切换这类开关按钮没有 `aria-pressed`；搜索框只靠 placeholder 命名。
- **最小改法**：
```diff
 shell.html
-<span id="search-count"></span>
+<span id="search-count" role="status"></span>
-<div id="toast"></div>
+<div id="toast" role="status"></div>
-<input id="search" type="search" placeholder="搜索环节 / 负责人 / 说明">
+<input id="search" type="search" placeholder="搜索环节 / 负责人 / 说明" aria-label="搜索环节">
```
```diff
 /* app.js applyFilter 里已有的 forEach */
-  if(hidden[...]) b.classList.add('off'); else b.classList.remove('off');
+  var off=!!hidden[b.getAttribute('data-status')]; b.classList.toggle('off',off); b.setAttribute('aria-pressed',off?'false':'true');
 /* app.js setVariant 里 */
+  b.setAttribute('aria-pressed', b.getAttribute('data-variant-btn')===name ? 'true':'false');
```
- **验证**：读屏下搜索会播报「N 个匹配」；点图例会播报按下 / 弹起。

### B5 浅色主题页面小字对比度全部不达标　【P0】
实测（`contrast.py`，小字要求 4.5:1，取三种面板底中最差的一个）：

| 令牌 | 浅色现值 | 最低对比度 | 建议文字色 | 新对比度 |
|---|---|---|---|---|
| `--muted` | `#6f6553` | 3.89 | `#645b4b` | 4.54 |
| `--accent` | `#bf6b3a` | 2.65 | `#884c29` | 4.58 |
| `--ok` | `#35935f` | 2.59 | `#256843` | 4.54 |
| `--warn` | `#b8801a` | 2.32 | `#795411` | 4.61 |
| `--risk` | `#c2403f` | 3.47 | `#a43534` | 4.54 |

深色全部达标（最低 4.76:1），不用改。

- **改法思路**：**只给"文字用途"新增令牌**，圆点 / 描边 / 填充保持原色，视觉基调不变。
```css
/* app.css */
:root{--accent-text:var(--accent);--ok-text:var(--ok);--warn-text:var(--warn);--risk-text:var(--risk)}
html[data-theme='light']{--muted:#645b4b;--accent-text:#884c29;--ok-text:#256843;--warn-text:#795411;--risk-text:#a43534}
```
  然后把以下 `color:` 换成对应的 `-text` 令牌：`button:hover` / `button.on` / `a.icon-btn:hover` / `.jump:hover` / `.flow-row:hover` / `.fr-cur` 的 `var(--accent)`；`.chip.st-done|doing|hold|risk` 的文字色（`border-color` 不动）；`.hit-row.soft .hr-snip` 的 `var(--warn)`。
- **注意**：`--muted` 在浅色下变深一点会影响所有次要文字，是整体观感的小变化；SVG 内的 `--t-meta` 在 svg.css 里单独定义，不受影响。
- **验证**：`python3 contrast.py` 重跑；浅色下肉眼过一遍概览 / 详情 / 搜索结果三个面板。

### B6 `prefers-reduced-motion`　【P2】
- **问题**：背景 .22s、画布平移 .28s、抽屉 .18s、toast、按钮 .14s，全都不尊重系统"减少动态效果"。
- **最小改法**（app.css 末尾）：
```css
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms !important;animation-duration:.01ms !important}}
```
  `vp-anim` 靠 CSS transition，一并生效，JS 不用改。
- **验证**：系统开启"减少动态效果"后，搜索跳转和抽屉开合无过渡。

---

## 三、主题 / 缩放 / 搜索 / 筛选的耦合

### C1 `--hit` 只在 `<svg>` 上定义，页面 CSS 里用不到　【P0，真 bug】
- **问题**：`--hit` 定义在 `svg.css` 的 `svg{}` 与 `svg[data-theme='light']{}` 上；而 `app.css` 的 `.hit-row.cur`、`.hit-row.cur .hr-n`、`.hit-row mark` 在 `<aside>` 里，拿不到这个变量。
- **影响**：自定义属性未定义 → 这些声明在计算时失效：**搜索结果清单里关键词没有高亮底色，当前行没有描边，当前序号圆点没有底色**。（画布上的节点命中描边正常，因为在 svg 内。）
- **最小改法**（app.css）：
```diff
 :root{... --ok:#46c886;
+  --hit:#4a9dff;
 ...}
 html[data-theme='light']{... --ok:#35935f;
+  --hit:#1a5fb0;
 ...}
-  .hit-row.cur .hr-n{background:var(--hit);color:#fff}
+  .hit-row.cur .hr-n{background:transparent;color:var(--text);box-shadow:inset 0 0 0 1.5px var(--hit)}
```
- **数值**：深色 `#4a9dff` 对 panel3 5.13:1；浅色沿用 svg 里的 `#2b7fe0` 只有 2.73:1（<3:1），所以页面里改用 `#1a5fb0`（对 panel3 4.31、panel2 5.23、panel 5.55）。序号圆点原来"白字压 `--hit` 底"深色只有 2.78:1，所以改成描边圈 + 正文色，文字对比度 12.26 / 10.07。
- **验证**：搜一个词，看结果清单里 `<mark>` 有底色、当前行有描边；DevTools 里 `.hit-row.cur` 的计算样式 `border-color` 不再是 `currentcolor`。

### C2 主题：三份解析逻辑，但契约要求保持——只补一个缺口　【P2】
- **现状**：shell 里的首帧引导脚本、`app.js` 的 `effective()`、`home.js` 的 `read()` 各解析一遍 `{mode, ts}`。引导脚本必须内联在首帧前，合并不了；三键 + 比 `ts` 的语义是接口契约，不能简化。所以我**不建议重构**。
- **真缺口**：另一个标签页（比如首页「显示设置」）改了主题，已打开的流程图页不会变，要刷新。
- **最小改法**（app.js，`applyTheme();` 那行之后）：
```js
window.addEventListener('storage',function(e){ if(!e.key||e.key.indexOf('flowviz-')===0) applyTheme(); });
```
- **验证**：开两个标签页，一个是首页一个是流程图；在首页切深 / 浅，流程图页立刻跟着变（锁定的那张不变）。

### C3 右侧面板有 5 处各自决定"画概览还是画详情"　【P2】
- **问题**：`select()`、`applyFilter()`、搜索 `input`、`jumpHit()`、命中行点击各自写 `renderPanel(null)` 或 `renderPanel(meta[sel])`，规则散落（如 `if(!sel) renderPanel(null)` 出现多次）。
- **影响**：目前行为正确，但后面再加状态时容易漏一处。
- **最小改法**（app.js）：新增 `function refreshPanel(){ renderPanel(sel?meta[sel]:null); }`，把上述几处统一调用它。不改任何 DOM 与行为。
- **验证**：沿用你的人工回归清单中"搜索 / 筛选 / 选中"三项。
- **产品问题（未改）**：已选中某节点时再搜索，右栏仍显示该节点详情，命中清单不可见，只有顶栏计数。是否改成"搜索时回到概览"由你定。

---

## 四、视觉细节

### D1 浅色主题下分组带标题字几乎看不见　【P1】
- **问题**：分组带文字颜色是 `flow.mjs` 写进 SVG 的行内 `fill`（调色板为深色底设计）。浅色画布 `#e8dbc4` 上，六种颜色对比度分别是 1.83 / 1.64 / 1.60 / 1.83 / 2.08 / 1.31:1。
- **影响**：浅色下每个阶段的标题（如「采集与下载」）几乎读不出来。
- **最小改法**（只改 svg.css，不碰后端）：CSS 规则能压过 `fill` 属性，用 `filter` 压暗，保留色相：
```css
svg[data-theme='light'] .band-label,
svg[data-theme='light'] .band-count{filter:brightness(.5)}
svg[data-theme='light'] .band-count{opacity:1}   /* 行内 opacity=.8 会把对比度再拉低到 3.3–4.0 */
```
  `brightness(.5)` 后六色最低 4.54:1（`#2dd4bf` 那条），其余 5.2–6.1。深色不动（本来 5.5–8.6）。
- **验证**：`contrast.py` 里已有这张表；浅色下用 12 个分组的样例肉眼过。

### D2 命中高亮：软命中的虚线和"风险点"的虚线外观相近　【P2，需肉眼】
- **问题**：`.is-hit-soft` 用 `stroke-dasharray:5 4`，而 `k-risk` 节点本身就是 `6 4` 的虚线描边，搜索时二者不好分。
- **最小改法**（svg.css）：`.node.is-hit-soft .node-bg{stroke-dasharray:2 3.5;stroke-linecap:round}`，改成点线。
- **验证**：搜一个只在说明里命中、且命中节点是风险点的词，两主题各看一眼；这条是审美判断，不满意可以不改。

### 没发现问题的部分
角标 / 时间药丸的位置已经由 `fitBadge()` / `fitPill()` 按形状算过留白，我没有发现需要改的地方，这里不动。

---

## 建议的落地顺序
1. 先做 P0：C1、B3、B5（都只动 app.css / shell.html / 少量 app.js）。
2. 再做 B1 + B2（键盘）和 A1–A4（手机），其中 A2、A4 需要实机确认。
3. 每做完一批，用 `split-home.mjs --verify` / `split-shell.mjs --verify` 的思路对比渲染产物，确认没有意外改动（这些改动本来就会改变产物，所以对比的是"只出现预期的差异"）。


