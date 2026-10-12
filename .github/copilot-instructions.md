# GitHub Copilot 说明（VS Code）

这个仓库是一个 Agent 技能：**业务流程 → Mermaid 源码 + 交互式 HTML 流程图**（零依赖、纯离线、Node ≥ 18）。

- 先读 [`SKILL.md`](../SKILL.md)：技能定义、用法、经验规则与踩坑记录。
- 需要画图时：
  1. 把用户给的流程整理成 JSON 规格（字段见 [`references/spec.md`](../references/spec.md)），或直接用用户的 Mermaid；
  2. `node scripts/flow.mjs check <规格>`；
  3. `node scripts/flow.mjs render <规格> --out out/<名字>.html --all`。
- 批量刷新旧产物：`node scripts/flow.mjs refresh <目录>`。
- **硬约束**：不引入依赖/构建步骤、不联网、产物必须是自包含单文件 HTML；不改 [`docs/interfaces.md`](../docs/interfaces.md) 里写死的结构、DOM 名、localStorage 键与视图语义。
- 改完请跑 `tools/tests/` 下的四道门（解析契约 / Mermaid 往返 / 对比度 / 产物回归），纯重构必须「逐字节相同」。