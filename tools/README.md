# 开发/验证辅助脚本（可选）

这三个脚本是我开发这个技能时用来做**真实浏览器验证**的，跟渲染主流程无关，普通使用者不需要它们：

| 脚本 | 作用 | 依赖 |
|---|---|---|
| `cdp.mjs` | 通过 CDP 连一个已启动的调试浏览器，跑几何/异常检查 | 本机 127.0.0.1:9222 上有调试版 Edge/Chrome |
| `probe.mjs` | 同上，做更轻量的探测（页面高度、面板状态） | 同上 |
| `devshot.mjs` | 批量截图（手机/电脑两种尺寸） | 同上 + Edge/Chrome 可执行文件 |

启动调试浏览器（Windows，Edge 示例）：

```powershell
& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\edge-debug"
```

只做渲染和查看流程图的话，`scripts/flow.mjs` + `scripts/serve.mjs` 就够了。
