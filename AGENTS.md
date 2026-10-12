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

## 文档地图

| 文件 | 给谁看 |
|---|---|
| [`SKILL.md`](SKILL.md) | agent：技能定义、用法、经验、踩坑 |
| [`README.md`](README.md) | 人：安装、上手、CLI、更新机制 |
| [`references/spec.md`](references/spec.md) | 写规格时查：字段 / Mermaid 子集 / 布局 / 主题 |
| [`docs/interfaces.md`](docs/interfaces.md) | 改代码前查：不能破坏的契约 |
| [`CHANGELOG.md`](CHANGELOG.md) | 使用者能看到的变化 |
| `docs/demo.html` | 双击就能看效果（示例流程的完整产物） |
