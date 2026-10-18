# workflow-visualizer

[![CI](https://github.com/jimku233/workflow-visualizer/actions/workflows/ci.yml/badge.svg)](https://github.com/jimku233/workflow-visualizer/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

**English** | [简体中文](README.md)

Turn a **business process** into an **interactive flowchart** you can click, search and export — one HTML file, zero dependencies, fully offline (no CDN, no network), plus **Mermaid source** you can paste into Notion / Confluence / GitHub / any markdown editor.

This repository root **is** an [Agent Skill](https://code.claude.com/docs/en/skills) directory (`SKILL.md` lives at the root), so `git clone` into a skill discovery path is all it takes.

**See it first** → live demo: <https://jimku233.github.io/workflow-visualizer/> (click nodes, search, switch portrait/landscape). Offline: **download** [`docs/demo.html`](docs/demo.html) and double-click it (opening it on GitHub shows source, not a rendered page).

| Phone · portrait (light) | Desktop · landscape (dark) |
|---|---|
| <img src="docs/screenshot-portrait.png" width="240" alt="Portrait view on a phone"> | <img src="docs/screenshot-landscape.png" width="620" alt="Landscape view on a desktop"> |

## The three things that matter

1. **Look** — open a card / the HTML file → **click any step** to see time, owner and notes; the bottom toolbar switches **portrait / landscape**, toggles light/dark and exports **SVG / PNG**.
2. **Search** — search step names, owners and notes. In the result list, a **blue border** means the title matched and a **dotted yellow line** means only the notes matched; **↑ ↓** or **Enter** walks through matches, **Esc** clears. The keyboard is a first-class citizen: **Tab** moves between steps, **Enter** opens details.
3. **Update** — the output is a **self-contained snapshot and never updates itself**; re-render after editing the spec. The home page flags files rendered by an older version as “旧版渲染” (stale), and `node scripts/flow.mjs refresh <dir>` re-renders everything at once.

> A freshly installed skill only takes effect in a **new session** (skill directories are scanned at startup). The same note lives in the “如何使用” (How to use) panel on the home page.

## Features

One spec renders **two layouts**; the page picks one based on window ratio and you can switch manually:

| Layout | Purpose |
|---|---|
| portrait | Single column; one step per row on a phone, full detail |
| landscape | Long flows auto-split into columns (rows per column configurable); whole flow visible on a desktop |

- Click a node for **time / owner / description / notes**; upstream and downstream are highlighted, the rest fades
- Search steps, owners and notes; **↑ ↓ / Enter** walks the matches, non-matches fade out
- Filter by status (done / in progress / needs review / not started / blocked)
- Light / dark theme (follows the system, can be locked); when zoomed out enough that small text would blur, the view **simplifies** and increases contrast
- Export the current layout as **SVG / PNG**, copy the **Mermaid** source at any time
- A “全部流程图” (all flows) drawer switches between flows in the same folder; single-finger pan and pinch zoom on phones
- Group bands (phases / shifts) are drawn automatically with centered titles and counts; capsules for start/end, diamonds for decisions, dashed borders for risks
- **Keyboard accessible**: `Tab` moves between steps, `Enter`/`Space` opens details; the drawer is a proper dialog (`Esc` closes it and returns focus)
- **Measurable readability**: contrast for both themes is recomputed by a script against WCAG (small text ≥4.5:1, non-text ≥3:1)

## Install

### As an agent skill (recommended)

Skill discovery looks for a `SKILL.md` **one level below** a discovery root. So **this repository root is the skill directory**:

```bash
# User level (available to every project)
git clone https://github.com/jimku233/workflow-visualizer.git ~/.dsh/skills/workflow-visualizer      # DSH
git clone https://github.com/jimku233/workflow-visualizer.git ~/.claude/skills/workflow-visualizer   # Claude Code and other SKILL.md-aware agents

# Or per project only
git clone https://github.com/jimku233/workflow-visualizer.git <your-project>/.dsh/skills/workflow-visualizer

# Update
cd ~/.dsh/skills/workflow-visualizer && git pull
```

Windows (PowerShell):

```powershell
git clone https://github.com/jimku233/workflow-visualizer.git "$env:USERPROFILE\.dsh\skills\workflow-visualizer"
```

If you would rather not move the checkout, register its **parent** directory in the DSH config:

```jsonc
{
  "skills": {
    "filesystem": {
      "customSkillDirs": ["/absolute/path/to/the/parent/directory"]
    }
  }
}
```

Then just ask in a session: “turn these flows into diagrams”, or call `/workflow-visualizer`.

> Do **not** nest another `skills/` level (e.g. `~/.dsh/skills/<repo>/skills/`) — discovery only looks one level down. The repository root must be the directory that contains `SKILL.md`.

### Which agents work

| Environment | What you get |
|---|---|
| **DSH / Claude Code** | Full functionality (native `SKILL.md`): read the skill → write a spec → run `flow.mjs` → HTML/Mermaid ✓ |
| **Codex CLI / Cursor and other `AGENTS.md` agents** | Full functionality: [`AGENTS.md`](AGENTS.md) at the root points them at `SKILL.md` first ✓ |
| **VS Code + GitHub Copilot** | Full functionality: ships `.github/copilot-instructions.md` and a `/画流程图` prompt file (or run `node scripts/flow.mjs …` in the terminal) ✓ |
| **Any AI with code execution / agent mode** (ChatGPT · Codex · Claude Code · Cursor terminal · Doubao agent mode · CI) | Full functionality ✓ — if Node is available the renderer just runs. **Output is byte-identical to a local run**: rendering is deterministic (same spec + same version = same result, which is exactly what the regression tests prove) |
| **Chat-only AI (no code execution)** | Cannot render; it can still read `SKILL.md` + `references/spec.md` and help you **write a spec** (JSON / Mermaid) to render elsewhere |
| **DeepSeek mobile app** | Currently **not usable**: no code execution environment, so Node cannot run. Render on a desktop and send the HTML to the phone, or start `serve.mjs` and open the LAN address in the phone browser |
| **Someone who just wants a web page** | No agent needed: send them the HTML produced by `node scripts/flow.mjs render …`; double-click and it works ✓ |

The only requirement is **Node.js ≥ 18** (zero third-party dependencies, no `npm install`).

> **Why is the output identical on another machine?** The renderer contains nothing random or time-dependent: layout, coordinates, SVG and CSS are all derived from the spec and the code. Only the “rendered at” timestamp in the footer changes (the regression script compares “byte-identical after ignoring timestamps”). Local, agent, sandbox — same result.

> ⚠️ **Chat-only AI cannot produce a real artifact.** A web chat without a code execution environment (DeepSeek web, for example) cannot run **Node.js**, so what it “generates” is usually either ① our published `docs/demo.html` with the **data swapped**, or ② a **hand-written lookalike** page.
>
> **Three quick checks** (open the HTML in a browser and Ctrl+F):
> 1. `flow-viz`, `flow-version`, `flowviz-zoom` must all be present — if none are, this tool did not produce it;
> 2. Search `饮品店` — if it appears, the page is our example with swapped data (the example SVG labels, coordinates and edges are still inside);
> 3. Check that the node text is your process, and that positions and edges look sane.
>
> Want a **real artifact**? Run `node scripts/flow.mjs render …` on a machine with Node, or let an agent that can run commands do it (DSH / Claude Code / Codex / VS Code Copilot all work).

## 30-second quick start (CLI, no agent)

```bash
# 1. Write a sample spec, then edit it
node scripts/flow.mjs sample --out 我的流程.json

# 2. Structural check (orphans / unreachable / no end / cycles)
node scripts/flow.mjs check 我的流程.json

# 3. Render: one HTML (both layouts) + two SVGs + Mermaid source
node scripts/flow.mjs render 我的流程.json --out out/我的流程.html --all
```

Mermaid input works directly (supports `flowchart`/`graph`, `subgraph`, `{}` diamonds, `-.->` dashed edges, `|labels|`):

```bash
node scripts/flow.mjs render examples/示例-报销审批.mmd --out out/示例-报销审批.html --all
```

> Keep `--out out/…`: without it, output lands next to the input file, which can overwrite the example **input** (`examples/*.mmd`) and dirty the repository. `out/` is already in `.gitignore`.

To view the same directory on a phone (the “全部流程图” drawer refreshes automatically):

```bash
node scripts/serve.mjs ./out 8765
#  local   http://127.0.0.1:8765/
#  phone → http://<your-LAN-IP>:8765/     ← phone and computer on the same Wi-Fi
```

Double-clicking the HTML locally also works (`file://` mode), but a **phone** needs the server.

## Will old diagrams update themselves after a new release?

**No, by design.** The output is a **self-contained HTML**: CSS, JS and data are inlined at render time, so an existing file keeps exactly the look it had (offline, no CDN, no service worker, nothing silently upgrades it).

Updating happens when you **re-render**, in one of three ways:

| Way | How |
|---|---|
| Batch refresh (recommended) | `node scripts/flow.mjs refresh <dir>` — re-renders every spec in the directory (`*.json` containing `nodes`, `*.mmd` / `*.md`) and rebuilds the manifest and home page |
| Single re-render | `node scripts/flow.mjs render <spec> --out <same-name>.html --all` |
| Ask an agent | Just say “re-render my diagrams” — the skill is designed for that |

Each artifact carries `<meta name="flow-version" content="x.y.z">` and the manifest (`流程索引.json`) records the renderer version; **the home page marks mismatched files as “旧版渲染”** and suggests running `refresh`, so nothing silently goes stale.

### Deleted a file but the drawer / home page still shows it?

Under **`file://`**, the drawer (top-right “全部流程图”) and the static home page are **a snapshot of the manifest at render time**, so deleting a file does not remove it:

```bash
node scripts/flow.mjs index <output-dir>     # rebuild manifest + static home page
node scripts/flow.mjs refresh <output-dir>   # also re-render every flow (drawer snapshot included)
```

When served over HTTP (`node scripts/serve.mjs <output-dir> 8765`) everything is **live**: deleting or renaming a file in the page rebuilds the manifest and home page automatically.

### First time you open the home page and it is empty?

The empty state prints the first command and offers a **“先看个演示 →”** (see a demo) button: the demo is the [`docs/demo.html`](docs/demo.html) shipped with the skill (served through `/__demo`, or via a relative path when you double-click a local `index.html`).

It **only appears while the directory has no flows**, and stops rendering as soon as you draw the first one. The demo file always stays inside the skill package — nothing is written into your output directory, nothing to clean up.

### Sent a single HTML to someone and “首页” (home) gives 404?

Expected: “首页” and “全部流程图” are **directory-level** features (relative links to `index.html` and `流程索引.json` in the same folder). **Sending one HTML file** means those files are missing, hence the 404. Send the **whole output directory** (or a zip) if you want to keep them.

## Input formats

Two input types; the field and syntax reference is [`references/spec.md`](references/spec.md):

- **JSON spec**: `title / subtitle / direction / wrap / groups / nodes / edges`;
  node fields `kind` (`start`, `end`, `task`, `milestone`, `decision`, `risk`),
  `status` (`done / doing / todo / risk / hold`), `time / owner / detail / note`.
- **Mermaid subset**: `flowchart TD/LR`, `subgraph` groups, `A[square]`, `B{diamond}`, `C(capsule)`, `-.->` dashed, `|labels|`.
  - Real directives that do not affect rendering (`classDef` / `class` / `style` / `linkStyle` / `click` / `direction` / `accTitle` / `accDescr`) are **ignored with a console note**, so snippets pasted from elsewhere still render;
  - Unsupported syntax **fails with file:line:col** instead of silently drawing something wrong (see the error contract in `docs/interfaces.md`);
  - When an edge label contains `|`, the exported Mermaid uses the visually equivalent `∣` (U+2223), because `|…|` cannot hold a pipe.

`examples/` holds one JSON example (a fictional coffee shop day) and one Mermaid example (a fictional expense approval) — edit them directly.

## CLI reference

| Command | What it does |
|---|---|
| `render <spec> [--out x.html] [--all] [--wrap N] [--debug]` | Render HTML + two SVGs + Mermaid; `--all` also writes the SVG/MMD files |
| `refresh <dir>` | **Batch re-render** every spec in the directory, then rebuild manifest and home page |
| `mermaid <spec.json> [--out x.mmd]` | Emit Mermaid source only |
| `check <spec>` | Structural check (orphans / unreachable / no end / cycles) |
| `index <dir>` | Rebuild `流程索引.json` and the static home page used by `file://` |
| `preview <flow.html>` | Side-by-side comparison of the portrait / landscape layouts |
| `sample [--out x.json]` | Write a sample spec |
| `serve.mjs <dir> [port]` | Local / LAN server (home page, trash, rename) |

**Exit codes**: `0` success · `1` `check` found structural problems · `2` bad arguments or input (errors look like `flow: file:line:col: message`).
**Unknown flags fail loudly** (no silent ignoring); `--wrap` requires an integer ≥ 0 (`0` disables column splitting).

> Want to change the code or build your own variant? Read [AGENTS.md](AGENTS.md) (hard constraints + the four regression gates you must run) and [docs/interfaces.md](docs/interfaces.md) (contracts you must not break).

## Privacy and security

- **Fully offline**: rendering performs no network requests, uses no CDN and has no telemetry.
- **Self-contained output**: whatever you put in the spec (owners, notes) is embedded verbatim in the HTML and in exported SVG/PNG — keep that in mind before sharing.
- **`serve.mjs` listens on a local port and is reachable from your LAN**: it exposes a “trash / rename” endpoint callable **only from loopback** (deletion moves files into `.trash-YYYY-MM-DD/`, it never deletes outright). Do not start this server if you do not want other devices on the network to reach it.
- All examples in this repository use **fictional data** and contain no real business information.

## Credits

- **LK-zui** (GitHub) — tested real workflows and gave interaction and readability feedback
- Author on Bilibili: **@jimi绝不吐槽**

## Feedback

Bug reports and improvement ideas are welcome:

- **GitHub**: [open an issue](https://github.com/jimku233/workflow-visualizer/issues) — including the error output and your spec (or a minimal reproduction) helps most
- **Bilibili**: leave a comment under **@jimi绝不吐槽**'s videos or posts

If it saved you time, or you simply find it useful, a **Star ⭐** is appreciated. Thanks 🙂

## License

[MIT](LICENSE) © 2026 jimku233

Free to use, modify, sell and redistribute — just keep the copyright and license notice.
