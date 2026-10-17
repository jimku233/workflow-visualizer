# 测试与回归（零依赖，直接 `node` 跑）

四个脚本都是自包含的，只依赖 Node 内建模块；临时产物写在各自的 `.tmp/` 下，基线写在 `baseline/`（都在 `.gitignore` 里，只有基线会提交）。

| 命令 | 作用 | 期望结果 |
|---|---|---|
| `node tools/tests/parse-errors.mjs` | **解析与校验的验收测试**：合法输入必须继续成功、非法输入必须按契约报错 | 16/16 通过（退出码 0） |
| `node tools/tests/mermaid-roundtrip.mjs` | JSON → `toMermaid` → `parseMermaid` → 比对节点/边/分组语义 | 4/4 通过（退出码 0） |
| `node tools/tests/contrast.mjs` | 按 WCAG 复算深浅两套主题的文字/非文本对比度（令牌直接读 `assets/app.css`） | 小字 ≥4.5:1、非文本 ≥3:1 |
| `node tools/tests/regress.mjs save demo` | 记录「当前产物」基线（几何数据 + 归一化后的完整 HTML） | 写出 `baseline/demo.{json,html}` |
| `node tools/tests/regress.mjs check demo` | 重新渲染并与基线比对 | 几何一致 + 忽略渲染时间戳后逐字节相同 → 退出码 0 |

## 错误契约（`parse-errors.mjs` 在验的东西）

```
退出码  0 = 成功（check 通过）
        1 = check 发现结构问题（孤立节点 / 不可达 / 无终点）
        2 = 参数、输入文件或规格校验错误
格式    flow: <文件名>:<行>:<列>: <说明>        ← 至少要能定位到行
```

具体要求见脚本里的用例注释：未闭合的形状、未配对的 `subgraph`、未知 `kind`、`nodes` 不是数组、
分组/边引用不存在的节点、非法 JSON —— 都必须报错并指到位置，不能静默接受或抛原始 TypeError。

## 两个语义上的「坑」（已解决，用例仍守着）

1. **边标签里的 `|`**：Mermaid 的 `|…|` 语法装不下竖线，导出时替换成视觉等价的 `∣`（U+2223）—— 这是有意替换，不是 bug。
2. **节点标签里的 `"`**：导出的是合法 Mermaid，但早期版本的本仓库解析器读不回来（`他说"可以"` 被拆成两个节点），
   根因是语句切分与节点识别用宽松正则、不看引号/括号嵌套。现已按引号/括号配对切分，`parse-errors.mjs` 里有对应用例守着。

## 用法建议

改动前后各跑一遍：

```bash
node tools/tests/regress.mjs check demo     # 纯重构：应当「逐字节相同」
node tools/tests/parse-errors.mjs           # 解析/校验改动：应当 16/16
node tools/tests/mermaid-roundtrip.mjs      # 导出/解析配套：应当 4/4
node tools/tests/contrast.mjs               # 动了任何颜色/令牌：必须仍达标
```

> 改了**文案**（页脚、抽屉说明、署名、版本号）也会改变产物字节，同样要 `regress.mjs save demo` 重录基线 —— 详见 [`AGENTS.md`](../../AGENTS.md)。
