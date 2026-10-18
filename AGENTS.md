# AGENTS.md — 给任何 coding agent 的入口（Codex / Cursor / Claude Code / Copilot / …）

这个仓库是一个**自包含的 Agent 技能**：把业务流程渲染成 **Mermaid 源码 + 交互式 HTML 流程图**。
零依赖、纯离线、只用 `node:` 内建模块，要求 **Node.js ≥ 18**。

## 你要做什么

1. **先读 [`SKILL.md`](SKILL.md)** —— 那是这个技能的正经定义（frontmatter 里的 `name` / `description` / `whenToUse`，加上完整用法、经验规则、踩坑记录）。本文件只是给不认 `SKILL.md` 的 agent 一个指路牌。
2. 用户说"把流程画出来 / 画个流程图"时：
   - 把用户口述或文档里的流程整理成 JSON 规格（字段见 [`references/spec.md`](references/spec.md)），或直接收下用户的 Mermaid；
   - `node scripts/flow.mjs check <规格>` 先做结构自检；
   - `node scripts/flow.mjs render <规格> --out out/<名字>.html --all` 出图（一个 HTML 内含竖版+横版，外加两版 SVG 与 Mermaid 源码）。
3. 想批量刷新旧产物：`node scripts/flow.mjs refresh <目录>`。

## 不要做的事（硬约束）

- **不要引入依赖或构建步骤**，不要联网（渲染全程零网络请求，产物必须自包含单文件 HTML、`file://` 双击可用）。
- **不要改动 [`docs/interfaces.md`](docs/interfaces.md) 里写死的东西**：JSON 数据结构、DOM 的 id / 类名 / `data-*`、五个 localStorage 键、视图语义、内联契约。
- 前端源码在 [`assets/`](assets)（渲染时内联回产物）；改样式请改 `assets/app.css` / `assets/svg.css` / `assets/home.css`，不要往 `scripts/*.mjs` 里塞字符串模板。

## 改完必须自证

```bash
node tools/tests/parse-errors.mjs        # 解析/校验契约（16 例）
node tools/tests/mermaid-roundtrip.mjs   # 导出再解析是否等价（4 例）
node tools/tests/contrast.mjs            # 深浅主题对比度（小字 ≥4.5:1）
node tools/tests/regress.mjs check demo  # 产物回归：几何 + 忽略时间戳后的逐字节比对
```

- 纯重构必须让 `regress` 报「逐字节相同」；确实要改行为时，确认差异只在你预期的地方，再 `node tools/tests/regress.mjs save demo` 重录基线。
- 不确定怎么用就 `node scripts/flow.mjs help`。

## 前端改动要点

- 前端是**独立资源文件**（`assets/app.js` / `app.css` / `svg.css` / `home.js` / `home.css` / `shell.html`），渲染时被内联回单文件 HTML —— 改样式改这里，不要往 `scripts/*.mjs` 里塞模板字符串。
- 首页与流程页的 `{{占位符}}`、DOM 的 id / 类名 / `data-*`、五个 localStorage 键、视图语义，全在 [`docs/interfaces.md`](docs/interfaces.md)，动之前先读第 7 节（内联契约）。
- 浅色主题的正文小字用 `--accent-text` / `--ok-text` / `--warn-text` / `--risk-text` 这组「文字专用」令牌（`contrast.mjs` 守这一层），不要直接拿 `--accent` 当文字色。

## 发布前：一条命令自检（+ 一条关于 `git add` 的血泪教训）

```bash
node tools/check-release.mjs          # 生成物 / 敏感串（含全历史）/ 版本号 / 产物回归
node tools/check-release.mjs --skip-regress   # CI 里用（回归由独立步骤跑）
```

它检查四件事：仓库里有没有**渲染产物**（根目录 `index.html`、`流程索引.json`、`*-竖版/-横版.svg`、`.tmp/`）、**被跟踪文件与全部历史**里有没有本机路径 / 用户名 / 内网 IP / token 特征、**版本号是否四处一致**（`FLOW_VERSION` / `docs/demo.html` / 基线 / `CHANGELOG` 最新一节）、产物是否与基线逐字节相同。

> **不要用 `git add -A` / `git add .`。** 这个仓库里 `flow.mjs` 会在产物目录旁边顺手写 `index.html`，`render` 也可能在 `examples/` 落 SVG —— `-A` 会把它们一起提交（曾经因此把 `<code id="rootpath">D:\…</code>` 本机路径带进公开仓库与发布包）。
>
> 规矩：**先 `git status` 看一眼未跟踪文件，然后 `git add <具体文件>`**。只有在你确认「工作区里没有任何生成物」时才可以用 `-A`，比如刚 clone 完的干净树上只改了三份文档。

## 基线怎么重录（这里踩过两次坑）

`regress.mjs check demo` 是「现渲染产物 vs `tools/tests/baseline/`」的逐字节比对。**任何会改变产物字节的改动都要重录基线** —— 包括只改**文案**（页脚提示、抽屉说明、署名、版本号），不只是改布局或几何。

重录前先确认差异只在预期位置：

```bash
node tools/tests/regress.mjs check demo     # 看「首个不同」落在哪一行
node tools/tests/regress.mjs save demo      # 确认差异合理后重录
```

## 仓库结构

```
workflow-visualizer/          ← 仓库根 = 技能目录（发现根下面一层）
├── SKILL.md                  # 技能定义（frontmatter + 用法 + 经验 + 踩坑）
├── AGENTS.md                 # 本文件：给 coding agent 的入口与开发约束
├── README.md                 # 给使用者（中文）：安装、上手、CLI、更新机制
├── README.en.md              # 同上，英文版（与中文版一一对应，改一份记得同步另一份）
├── CONTRIBUTORS.md           # 作者与致谢
├── CHANGELOG.md              # 使用者能看到的版本变化
├── LICENSE                   # MIT
├── references/spec.md        # 字段 / Mermaid 子集 / 布局 / 主题完整手册
├── docs/
│   ├── interfaces.md         # 接口契约：数据结构 / DOM / 视图 / localStorage / 内联契约
│   ├── demo.html             # 示例产物（双击就能看效果）
│   └── index.html            # GitHub Pages 落地页（指向 demo.html）
├── .github/workflows/ci.yml  # CI：push/PR 自动跑四道回归门（Node 18/20/22）
├── scripts/flow.mjs          # 渲染器：解析 → 布局 → SVG → 交互 HTML
├── scripts/serve.mjs         # 本地 / 局域网服务 + 首页生成 + 回收站 / 重命名
├── assets/                   # 前端源码（渲染时内联，产物仍是单文件 HTML）
├── tools/tests/              # 四道回归门 + 基线
├── tools/check-release.mjs   # 发布前自检（生成物 / 敏感串含历史 / 版本号 / 产物）
├── tools/                    # 开发期验证脚本（CDP 截图 / 探测 / 一次性拆分脚本）
└── examples/                 # 中性示例（虚构数据）
```

## 文档地图

| 文件 | 给谁看 |
|---|---|
| [`SKILL.md`](SKILL.md) | agent：技能定义、用法、经验、踩坑 |
| [`README.md`](README.md) | 人（中文）：安装、上手、CLI、更新机制 |
| [`README.en.md`](README.en.md) | 人（英文）：与中文版一一对应，改一份请同步另一份 |
| [`references/spec.md`](references/spec.md) | 写规格时查：字段 / Mermaid 子集 / 布局 / 主题 |
| [`docs/interfaces.md`](docs/interfaces.md) | 改代码前查：不能破坏的契约 |
| [`CHANGELOG.md`](CHANGELOG.md) | 使用者能看到的变化 |
| `docs/demo.html` | 双击就能看效果（示例流程的完整产物） |
