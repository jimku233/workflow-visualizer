# 开发/验证辅助脚本（可选）

这里的脚本跟渲染主流程**无关**，普通使用者完全不需要它们。它们只服务两件事：**用真实浏览器验证产物**、**把历史上写死在渲染器里的模板拆成 `assets/`**。

| 脚本 | 作用 | 依赖 |
|---|---|---|
| `cdp.mjs` | 通过 CDP 连一个已启动的调试浏览器，跑几何 / 控制台异常检查 | 本机 `127.0.0.1:9222` 上有调试版 Edge/Chrome |
| `probe.mjs` | 同上，做更轻量的探测（页面高度、面板状态、点击是否生效） | 同上 |
| `devshot.mjs` | 批量截图（手机 / 电脑两种尺寸，含设备模拟） | 同上 + Edge/Chrome 可执行文件 |
| `split-home.mjs` | **一次性脚本**：把首页模板从 `serve.mjs` 拆到 `assets/home.*`，并校验拆分前后产物逐字节相同（已完成，留档） | 无 |
| `split-shell.mjs` | **一次性脚本**：把 HTML 骨架从 `flow.mjs` 拆到 `assets/shell.html`，同样校验逐字节相同（已完成，留档） | 无 |
| `contrast.py` | 早期算对比度用的独立 Python 版；现在主线用 `tools/tests/contrast.mjs`（读真实令牌） | Python 3 |

启动调试浏览器（Windows，Edge 示例）：

```powershell
& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\edge-debug"
```

只做渲染和查看流程图的话，`scripts/flow.mjs` + `scripts/serve.mjs` 就够了；改完代码要自证请跑 `tools/tests/` 那四道门（见 [`../AGENTS.md`](../AGENTS.md)）。
