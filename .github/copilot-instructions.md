# copilot-plan-visualizer

A GitHub Copilot CLI extension (Windows-only in practice) that opens a
native desktop webview rendering the current session's `plan.md` and
`todos` / `todo_deps` rows from the per-session SQLite DB, updating in
real time.

## Architecture

Three processes cooperate at runtime:

1. **Copilot CLI host** loads `extension.mjs`. The bootstrapper sets
   `process.env.npm_config_target = process.versions.node` (so a fresh
   `npm install` builds / fetches `better-sqlite3` for the **CLI's**
   embedded Node ABI, not the user's system Node), then calls
   `bootstrap()` from `lib/copilot-webview.js`. `bootstrap()` runs
   `npm install --omit=dev` if `package-lock.json` is missing or older
   than `package.json`. After that it dynamically imports `main.mjs`
   (deps can't be statically imported on a fresh checkout).

2. **Extension process** (`main.mjs`) calls `joinSession()` from
   `@github/copilot-sdk/extension`, registers the `/plan-visualizer`
   slash command, the three webview tools (`plan_visualizer_show`,
   `_eval`, `_close`), the `onPostToolUse` hook (for the agent's `sql`
   tool), and an `on("session.plan_changed")` event subscription.

3. **Webview child process** (`lib/webview-child.mjs`) is spawned by
   the `CopilotWebview` helper. It uses `@webviewjs/webview` (WebView2
   on Windows) and **blocks its event loop in `app.run()`** — that's
   why it has to be a separate Node process. All communication happens
   over a WebSocket served by the parent on a random localhost port.

The page ↔ extension bridge is `lib/copilot-webview.js`:

- The parent runs an `http.createServer` + `ws.WebSocketServer` on
  `127.0.0.1:<random>`. It serves `contentDir` statically and injects
  `/__bridge.js` on demand. `index.html` must `<script src="/__bridge.js">`
  before its own scripts.
- `BRIDGE_JS` exposes `window.copilot` as a Proxy: any property access
  becomes an RPC call, dispatched server-side to the matching key in the
  `callbacks` object passed to `new CopilotWebview({ callbacks })`.
  Page-side calls look like `await window.copilot.getState()`.
- The reverse direction is `webview.eval(code)` from extension → page;
  the bridge `eval`s the code in the page and returns the
  JSON-serializable result.

`lib/` is intentionally generic and reusable. Treat `copilot-webview.js`
as a vendored library — feature work for *this* extension belongs in
`main.mjs` and `content/`.

## Conventions

- **ES modules everywhere.** `package.json` has `"type": "module"`; use
  `.mjs` for entry points, `.js` for library files imported via ESM.
- **Node 20+** (per README). Uses top-level `await`,
  `import.meta.dirname`. The CLI itself ships an embedded Node 24, so
  the `npm_config_target` env in `extension.mjs` is essential — without
  it `prebuild-install` picks the wrong ABI binary for `better-sqlite3`.

## Real-time triggers (in order of authority)

`pushState()` is the single funnel. It rebuilds the state, hashes it,
and `webview.eval('window.__plan?.update?.(<state>)').catch(() => {})`
when the hash changed. Triggers:

1. `session.on("session.plan_changed", e)` — primary plan signal.
   `e.data.operation` is `"create" | "update" | "delete"`. On `"create"`
   we also call `webview.show()` to auto-open the window (idempotent).
2. `hooks.onPostToolUse` — when `toolName === "sql"` AND
   `toolArgs.query` matches `/\b(todos|todo_deps)\b/i` → re-read DB,
   push.
3. `fs.watchFile(planPath, {interval: 1000})` — fallback for direct
   external edits the SDK didn't surface.
4. `setInterval(5000)` while the window is open — DB-snapshot diff
   backstop for any path the above missed.

State payloads carry a monotonically increasing `version` integer. The
page ignores any `update(state)` whose `version <= lastAppliedVersion`,
so out-of-order pushes (older `getState` resolving after a newer hook
fire) can't clobber the UI.

## Persistence

All UI choices live in **one** JSON file:

```
~/.copilot/plan-visualizer/state.json
```

Shape:

```json
{
  "theme": "default-dark",
  "themeMode": "dark",
  "showPlan": true,
  "showTodos": true,
  "splitFraction": 0.58
}
```

`main.mjs`'s `getLayout()` / `setLayout()` callbacks own the
`showPlan` / `showTodos` / `splitFraction` keys; `getInitialTheme()` /
`setThemeChoice()` own the `theme` keys. They share the same shallow
read-modify-write helpers (`readPersistedState` / `writePersistedState`)
so neither set ever clobbers the other.

`setLayout` validates inputs server-side: booleans for the show flags,
finite numbers for `splitFraction` (clamped to `[0.05, 0.95]`). Unknown
keys are dropped on the floor.

## Theme machinery

`listThemes()` in `main.mjs` is called fresh on every `Theme ▸` submenu
open (no caching), so a dropped CSS file appears the next time you
right-click. Sources, in order of precedence (later sources override
earlier on name collision):

1. Built-in: `<extDir>/content/themes/*.css` → `source: "builtin"`
2. User (per-install): `<extDir>/themes/*.css` → `source: "user"`
3. User (env override): `$env:COPILOT_PLAN_VIZ_THEMES_DIR/*.css` →
   `source: "user"`

The page applies the chosen theme's CSS by injecting it into a
`<style id="active-theme">` element in `<head>`. Mode (light/dark) is
sniffed from the theme's `--bg` luminance.

See `content/themes/README.md` for the variable reference and a
copy-pastable starter.

## Layout state

The page stores the layout state on `<main id="layout">` via
`data-layout="both" | "plan-only" | "todos-only" | "none"` and CSS
custom properties `--col-plan` / `--col-todos` (in `fr` units, so the
6 px splitter track is auto-subtracted from the available width). The
splitter drag uses pointer events + `setPointerCapture`, with cleanup
on `pointerup` / `pointercancel` / `lostpointercapture` /
`window.blur`. The pixel-aware drag clamp keeps the smaller column at
least `max(15%, 220px)`.

## Hot-reload during development

- Editing files under `content/` does **not** require restarting the
  CLI. Trigger `plan_visualizer_show` with `reload: true` (or call
  `webview.show({ reload: true })`) to refresh the page.
- Editing `main.mjs` or `lib/` requires a full extension reload
  (`/reload-extensions` or restart the CLI). The webview child
  process holds a lock on
  `node_modules\@webviewjs\…\webview.win32-x64-msvc.node`; close the
  window first to release it (otherwise a reinstall via
  `scripts\install.ps1` will fail at `Remove-Item`).

## Install / dev workflow (Windows PowerShell)

```powershell
git clone https://github.com/pacovidal/copilot-plan-visualizer.git
cd copilot-plan-visualizer

# Install for your user (available in every Copilot CLI session):
.\scripts\install.ps1 -Scope Global

# Or install for one project:
.\scripts\install.ps1 -ProjectPath C:\path\to\project
```

For live development, prefer a junction so edits are picked up by
`extensions_reload`:

```powershell
New-Item -ItemType Junction `
    -Path "$env:USERPROFILE\.copilot\extensions\plan-visualizer" `
    -Target "D:\DEV_TESTS\PLAN_VISUALIZER"
```

Note: Copilot CLI's discovery treats directory junctions as files, not
directories, so junctions in `.copilot\extensions\` may not be picked
up at all. Fall back to a real `robocopy` or `scripts\install.ps1
-Scope Global -Force` between iterations.

End-user install / uninstall is via `scripts\install.ps1` /
`scripts\uninstall.ps1` (parameters: `-Scope Project|Global`,
`-ProjectPath`, `-Ref`, `-RepoUrl`, `-Force`).

There are no tests, lint, or build steps in this repo.
