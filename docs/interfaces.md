# 接口契约（改代码前先读这份）

这份文档写的是**不能随便动**的边界。多人（或多个 AI）同时改这个项目时，前后端各自的改动只要守住这些契约，就不会互相打断。

## 0. 全局不变量（任何改动都不能破坏）

1. **零依赖**：只用 `node:` 内建模块，不引入 npm 包、不加构建步骤。
2. **完全离线**：运行时**不发起任何网络请求**，不用 CDN，无遥测。
3. **产物自包含**：`render` 出来的 `.html` 必须**单文件**可用（内联全部 CSS/JS/数据），`file://` 双击能跑。
4. Node ≥ 18；Windows / macOS / Linux 都要能用。
5. 导出物（`-竖版.svg` / `-横版.svg`）必须是独立可打开的 SVG（内联样式，不依赖外部资源）。

## 1. 数据契约：页面内嵌的 `flow-data`

渲染时把规格 JSON 内联进产物：

```html
<script id="flow-data" type="application/json">{…}</script>
```

前端**只认这个结构**（后端改字段＝破坏前端）：

| 层级 | 字段 |
|---|---|
| 顶层 | `slug`、`title`、`subtitle`、`direction`、`groups[]`、`statusLabels{}`、`kinds[]`、`nodes[]`、`edges[]`、`selfFile`、`flows[]` |
| node | `id`、`label`、`kind`、`kindLabel`、`status`、`statusLabel`、`time`、`owner`、`detail`、`note`、`preds[]`、`succs[]` |
| edge | `from`、`to`、`label`、`style`（`''`\|`dashed`） |
| group | `id`、`label`、`members[]` |

- `kind` 取值：`start` / `end` / `task` / `milestone` / `decision` / `risk`
- `status` 取值：`done` / `doing` / `todo` / `risk` / `hold`（空字符串＝无状态，走 `st-none`）
- `statusLabels` / `kinds` 由后端从规格里实际出现过的值生成，前端**只读**

## 2. SVG DOM 契约

每个版式一份 SVG，id 固定：`#flow-svg-portrait`、`#flow-svg-landscape`（带 `data-variant`、`data-theme`）。

| 选择器 | 含义 | 谁依赖它 |
|---|---|---|
| `#vp-<vid>` | 承载缩放的 `<g>`（`translate(...) scale(...)`） | 前端 `paint()`；导出脚本 |
| `.node.k-<kind>.st-<status>[data-id][data-status][data-kind]` | 节点分组 | 前端点击/搜索/筛选、几何脚本 |
| `.node-bg` | 节点轮廓（rect / polygon / capsule） | 主题变量作用于它 |
| `.accent`、`.kind-chip/.kind-ring/.kind-glyph`、`.time-pill` | 状态竖条、类型角标、时间药丸 | 视觉层，可重构但**保留类名**便于验证 |
| `.t-label` / `.t-meta` / `.t-time` | 文本行 | 简化模式靠这些类名隐藏 |
| `.edge`（`.dashed`）、`.edge-label-g`、`.edge-label-bg`、`.edge-label` | 连线与边标签 | 搜索命中、淡出 |
| `.band`、`.band-bg`、`.band-pill`、`.band-label`、`.band-count` | 分组带 | 同上 |
| `.canvas-grid`、`.grid-dot` | 点阵底纹 | 缩放时不露边 |
| 状态类 | `.is-sel`、`.is-hit`、`.is-hit-soft`、`.is-dim` | 选中/命中/淡出 |
| SVG 根类 | `svg.searching`、`svg.zoomed-out` | 搜索态与"缩小简化" |

**可以改**：类名之外的 DOM 结构、新增装饰元素、CSS 变量取值。
**别改**：上面列出的 id / 类名 / `data-*` 属性语义（验证脚本、导出、主题都挂在它们上面）。

## 3. 视图（缩放/平移）契约

SVG 的 `viewBox` 自身会按 `meet` 缩放一次，所以客户端在**元素像素空间**维护：

```js
view = { K, TX, TY }        // 每版式一份
map.s                        // "整幅适配"的比例（100% 的基准）
paint(): vp.setAttribute('transform', `translate(${(TX-map.cx)/map.s},${(TY-map.cy)/map.s}) scale(${K/map.s})`)
```

- 显示百分比 = `K / map.s`（`100%` = 整幅放下）
- 初始视野规则见 `spec.md`：「横而扁→整幅适配；竖版长流程→`min(铺满宽度, 整幅适配 × fitcap)`」，`fitcap` 默认 1.45
- URL 参数：`?zoom=N`（固定 `N × 整幅适配`）、`?fitcap=N`（临时改上限）
- **新增缩放行为必须仍走 `paintActive()`**，否则百分比标签、简化阈值（`K*15 < 8.5`）不会同步

## 4. localStorage 键（前端状态，改语义要兼容旧值）

| 键 | 形状 | 含义 |
|---|---|---|
| `flowviz-theme` | `{mode:'system'\|'dark'\|'light', ts}` | 全局明暗（首页「显示设置」写） |
| `flowviz-theme:<文件名>` | `{mode:'dark'\|'light', ts}` | 单张图的明暗（页面上的明暗键写） |
| `flowviz-lock:<文件名>` | `{locked:true, mode, ts}` | 锁定该图颜色 |
| `flowviz-zoom:<文件名>:<portrait\|landscape>` | `{k, ts}` | 上次手动缩放的档位 |
| `flowviz-recent` | `[{file, ts}]` | 首页「最近打开」 |

生效顺序（明暗）：锁定 → 单张与全局比 `ts` 取新 → 都没有则跟随系统。**任何读取都要能容忍旧格式**（旧版是纯字符串）。

## 5. CLI 契约

```
node flow.mjs render <spec> [--out x.html] [--all] [--wrap N] [--debug]
node flow.mjs mermaid <spec.json> [--out x.mmd]
node flow.mjs check <spec>            # 退出码非 0 = 结构有问题
node flow.mjs index <目录>            # 写 流程索引.json + 同步 file:// 静态首页
node flow.mjs preview <流程图.html>
node flow.mjs sample [--out x.json]
node serve.mjs <目录> [端口]           # 默认 8765
```

- 输出目录默认＝输入文件所在目录；`--all` 才额外写 `-竖版.svg` / `-横版.svg` / `.mmd`
- 产物文件名：`<输入名>.html`、`流程索引.json`（清单）、`index.html`（file:// 首页快照）
- 失败要写 stderr 且退出码非 0；成功一行摘要进 stdout（要稳定，脚本/CI 依赖它）

## 6. 服务契约（`serve.mjs`）

- `GET` 任何路径 → 静态文件（目录则给首页；带 `cache-control: no-store` 的列表）
- `POST */__flow/act` → 仅**本机回环**（`req.socket.remoteAddress`），接受 `{op:'trash'|'rename', …}`；删除＝移进 `.trash-YYYY-MM-DD/`，**绝不真删**
- 不得引入写权限之外的能力（上传、执行、任意路径读写）——它会被暴露到局域网

## 7. 前端资源与内联契约（已完成拆分）

前端不再以字符串模板内联在 `flow.mjs` 里，而是**真实文件 + 渲染时内联**：

```
assets/app.js      页面交互 JS（视图/缩放、选中、搜索命中导航、主题、导出、手机抽屉、触屏手势）
assets/app.css     流程图页面的整页 CSS（含移动端断点 <960px / <600px）
assets/svg.css     SVG 内的主题变量与"缩小简化"规则，含 {{vid}} 占位（每版式一份 SVG，id 要带后缀）
```

`scripts/flow.mjs` 里的加载契约（约 10 行）：

```js
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const assetCache = new Map();
const loadAsset = (name) => { if (!assetCache.has(name)) assetCache.set(name, readFileSync(join(ASSET_DIR, name), 'utf8')); return assetCache.get(name); };

const CLIENT_JS = loadAsset('app.js');                     // 原样内联成 <script>
function svgStyle(vid) { return loadAsset('svg.css').replace(/\{\{vid\}\}/g, vid); }   // {{vid}} → portrait / landscape
// renderHtml 里：<style>${loadAsset('app.css')}</style>
```

**硬要求**

1. 产物必须仍是**单文件自包含 HTML**（CSS / JS / 数据全部内联），`file://` 双击可用；
2. 改完 assets 后，`render` 的产物应与改动前**忽略渲染时间戳后逐字节相同**（除非你就是要改行为）——用 `_verify/regress.mjs` 判定；
3. `svg.css` 里凡是带 `-${vid}` 的 id（filters / markers / patterns / `#vp`）一律写 `{{vid}}`，不要写死 `portrait`；
4. 仍**不允许**引入构建步骤、npm 依赖或运行时网络请求 —— 内联在渲染时由 Node 完成，一次性。

**还没拆的两块**（下一步可做）：`serve.mjs` 首页的 CSS/JS（`buildHome()` 的 `<style>` 与 `homeScript()`，约 25 KB）、`flow.mjs` 里 `renderHtml()` 的 HTML 外壳骨架（动态插值约 30 处）。

## 8. 改动后的回归清单

```bash
node scripts/flow.mjs check examples/示例-饮品店日常.json      # 结构检查
node scripts/flow.mjs render examples/示例-饮品店日常.json --out out/a.html --all
node scripts/flow.mjs render examples/示例-报销审批.mmd      --out out/b.html --all
```

人工核对（每次前端改动都要过一遍）：

- [ ] `file://` 双击能用；`http://` 起服务也能用（两版式都切一下）
- [ ] 手机尺寸（~430×900）：竖版默认视野能看到大部分环节；单指拖动/双指缩放/轻点选中
- [ ] 桌面尺寸（~1440×900）：横版整幅适配；滚轮缩放、拖拽、双击空白适配
- [ ] 搜索：命中高亮、`↑↓`/`Enter` 翻命中、`Esc` 清空
- [ ] 明暗：跟随系统 / 手动切 / 锁定三档；刷新不闪色
- [ ] 导出 SVG / PNG 与右侧详情面板正常
