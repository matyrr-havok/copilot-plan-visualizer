// plan-visualizer — Copilot CLI extension entry point.
//
// Opens a native webview window that renders the current session's plan.md
// and todo state, updating in real-time via:
//   • session.on("session.plan_changed")  — primary plan signal (also auto-
//     opens the window on operation === "create")
//   • hooks.onPostToolUse                  — refresh todos when the agent's
//     `sql` tool touches `todos` / `todo_deps`
//   • fs.watchFile on plan.md              — fallback for direct external edits
//   • setInterval(5000)                    — DB poll backstop while open

import { joinSession } from "@github/copilot-sdk/extension";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CopilotWebview } from "./lib/copilot-webview.js";

const require = createRequire(import.meta.url);

// ---- better-sqlite3 (optional, native) -----------------------------------
// Lazy-loaded so an install/build failure degrades to "todos unavailable"
// instead of crashing the whole extension.
let DatabaseCtor = null;
let dbLoadError = null;
try {
    DatabaseCtor = require("better-sqlite3");
} catch (e) {
    dbLoadError = e?.message || String(e);
}

// ---- Theme persistence ----------------------------------------------------
const STATE_DIR = join(homedir(), ".copilot", "plan-visualizer");
const STATE_FILE = join(STATE_DIR, "state.json");

function readPersistedState() {
    try {
        if (!existsSync(STATE_FILE)) return {};
        return JSON.parse(readFileSync(STATE_FILE, "utf8")) || {};
    } catch {
        return {};
    }
}

function writePersistedState(patch) {
    try {
        mkdirSync(STATE_DIR, { recursive: true });
        const cur = readPersistedState();
        writeFileSync(STATE_FILE, JSON.stringify({ ...cur, ...patch }, null, 2), "utf8");
    } catch (e) {
        // Best-effort; do not crash the page on persistence failure.
        session?.log?.(`plan-visualizer: failed to persist state (${e.message})`, { level: "warning" }).catch(() => {});
    }
}

// ---- Themes ---------------------------------------------------------------
// Themes are read fresh on every listThemes() call (not cached) so users
// can drop a CSS file into the user-themes dir and see it appear by
// reopening the Theme submenu — no extension reload required.
//
// Sources, in order of precedence (later sources override earlier on name
// collision, so a user override of a built-in theme wins):
//   1. Built-in:    <extDir>/content/themes/*.css      (source: "builtin")
//   2. User:        <extDir>/themes/*.css              (source: "user")
//   3. User (env):  $env:COPILOT_PLAN_VIZ_THEMES_DIR/*.css (source: "user")
const CONTENT_DIR = join(import.meta.dirname, "content");
const BUILTIN_THEMES_DIR = join(CONTENT_DIR, "themes");
const USER_THEMES_DIR = join(import.meta.dirname, "themes");
const ENV_THEMES_DIR = process.env.COPILOT_PLAN_VIZ_THEMES_DIR || null;

function readThemesFromDir(dir, source) {
    if (!dir || !existsSync(dir)) return [];
    let entries;
    try { entries = readdirSync(dir); } catch { return []; }
    return entries
        .filter((f) => f.toLowerCase().endsWith(".css"))
        .map((f) => {
            const name = f.replace(/\.css$/i, "");
            let css = "";
            try { css = readFileSync(join(dir, f), "utf8"); } catch {}
            return { name, css, mode: sniffMode(css), source };
        });
}

function listThemes() {
    const builtins = readThemesFromDir(BUILTIN_THEMES_DIR, "builtin");
    const users = [
        ...readThemesFromDir(USER_THEMES_DIR, "user"),
        ...readThemesFromDir(ENV_THEMES_DIR, "user"),
    ];
    // Merge: later sources override earlier on name collision.
    const byName = new Map();
    for (const t of builtins) byName.set(t.name, t);
    for (const t of users) byName.set(t.name, t);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Crude relative-luminance check on the theme's --bg variable.
function sniffMode(css) {
    const m = css.match(/--bg\s*:\s*([^;]+);/i);
    if (!m) return "dark";
    const v = m[1].trim();
    let r = 0, g = 0, b = 0;
    if (v.startsWith("#")) {
        const hex = v.slice(1);
        const expand = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
        if (expand.length >= 6) {
            r = parseInt(expand.slice(0, 2), 16);
            g = parseInt(expand.slice(2, 4), 16);
            b = parseInt(expand.slice(4, 6), 16);
        }
    } else {
        const nums = v.match(/\d+(\.\d+)?/g);
        if (nums && nums.length >= 3) {
            r = +nums[0]; g = +nums[1]; b = +nums[2];
        }
    }
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.5 ? "light" : "dark";
}

// ---- DB reader ------------------------------------------------------------
//
// Distinguishes three states for the page:
//   • available === false → better-sqlite3 not loaded (install issue)
//   • dbMissing === true  → no session DB yet (not an error — agent just
//     hasn't created the DB or the todos/todo_deps tables yet). The page
//     shows a friendly empty-state message instead of a technical error.
//   • error !== null      → an actual SQLite or open-time failure.
function readTodos(dbPath) {
    if (!DatabaseCtor) {
        return { todos: [], deps: [], available: false, dbMissing: false, error: null };
    }
    if (!dbPath || !existsSync(dbPath)) {
        // No session.db on disk yet (or no workspace path at all).
        return { todos: [], deps: [], available: true, dbMissing: true, error: null };
    }
    let db;
    try {
        db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true, timeout: 2000 });
    } catch (e) {
        return { todos: [], deps: [], available: true, dbMissing: false, error: `failed to open ${dbPath}: ${e.message}` };
    }
    try {
        let todos = [];
        let deps = [];
        let queryError = null;
        let todosTableMissing = false;
        let depsTableMissing = false;
        try {
            // Use SELECT * to tolerate schema variations (the per-session
            // DB schema is created on first use of the SQL tool).
            todos = db.prepare("SELECT * FROM todos").all();
        } catch (e) {
            if (/no such table/i.test(e.message)) todosTableMissing = true;
            else queryError = `to-dos query failed: ${e.message}`;
        }
        try {
            deps = db.prepare("SELECT todo_id, depends_on FROM todo_deps").all();
        } catch (e) {
            if (/no such table/i.test(e.message)) depsTableMissing = true;
            else queryError = (queryError ? queryError + "; " : "") + `deps query failed: ${e.message}`;
        }
        // If both tables are missing, the DB exists but the SQL tool
        // hasn't initialised the default schema yet — same UX as no DB.
        const dbMissing = todosTableMissing && depsTableMissing;
        return { todos, deps, available: true, dbMissing, error: queryError };
    } finally {
        try { db.close(); } catch {}
    }
}

// ---- Session metadata (name + branch) -----------------------------------
// The SDK gives us `sessionId` and `_workspacePath` but not the AI-generated
// session name or git branch. We read them ourselves:
//   • Name: `<workspacePath>/workspace.yaml` (key `name`, falling back to
//     `summary`). Same source the host CLI uses.
//   • Branch: `<cwd>/.git/HEAD` parsed as `ref: refs/heads/<branch>` (or a
//     detached SHA if HEAD is a raw oid). null if not a git repo.
// Both are re-read fresh in `buildState()` because the session name can be
// regenerated by the host on any turn and the user can switch branches.

function readWorkspaceName(workspacePath) {
    if (!workspacePath || typeof workspacePath !== "string") return null;
    let yaml;
    try { yaml = readFileSync(join(workspacePath, "workspace.yaml"), "utf8"); }
    catch { return null; }
    // Tiny inline parse — only top-level scalar keys we care about. Avoids a
    // YAML dep. Block scalars (`|`, `>`) are treated as absent. The host
    // writes plain (sometimes quoted) scalars in practice.
    for (const key of ["name", "summary"]) {
        const m = yaml.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
        if (!m) continue;
        let val = m[1].trim();
        if (/^[|>][-+]?\d*$/.test(val)) continue;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (val) return val;
    }
    return null;
}

function readGitBranch(cwd) {
    if (!cwd) return null;
    let head;
    try { head = readFileSync(join(cwd, ".git", "HEAD"), "utf8").trim(); }
    catch { return null; }
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1].trim();
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
    return null;
}

// ---- State aggregator ----------------------------------------------------
let stateVersion = 0;
let lastPushedHash = "";
let cachedSessionInfo = null;

async function buildState() {
    stateVersion += 1;
    const planResult = await safeReadPlan();
    const dbPath = cachedSessionInfo?.workspacePath
        ? join(cachedSessionInfo.workspacePath, "session.db")
        : null;
    const todoState = readTodos(dbPath);
    const cwd = cachedSessionInfo?.cwd || process.cwd();

    return {
        version: stateVersion,
        plan: planResult,
        todos: todoState.todos,
        deps: todoState.deps,
        todosAvailable: todoState.available,
        todosError: todoState.error || (dbLoadError ? `better-sqlite3 not loaded: ${dbLoadError}` : null),
        todosDbMissing: !!todoState.dbMissing,
        todosDbPath: dbPath,
        session: {
            id: cachedSessionInfo?.sessionId || null,
            cwd,
            workspacePath: cachedSessionInfo?.workspacePath || null,
            name: readWorkspaceName(cachedSessionInfo?.workspacePath),
            branch: readGitBranch(cwd),
        },
        timestamp: new Date().toISOString(),
    };
}

async function safeReadPlan() {
    if (!session?.rpc?.plan?.read) {
        return { exists: false, content: null, path: null };
    }
    try {
        const r = await session.rpc.plan.read();
        return { exists: !!r?.exists, content: r?.content ?? null, path: r?.path ?? null };
    } catch {
        return { exists: false, content: null, path: null };
    }
}

// Hash everything except `version` and `timestamp` so we don't push duplicates.
function hashOf(state) {
    const { version, timestamp, ...rest } = state;
    return JSON.stringify(rest);
}

// ---- Push funnel (debounced + deduped) -----------------------------------
let pushTimer = null;
function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(async () => {
        pushTimer = null;
        try {
            const state = await buildState();
            const h = hashOf(state);
            if (h === lastPushedHash) return;
            lastPushedHash = h;
            const code = `window.__plan?.update?.(${JSON.stringify(state)})`;
            await webview.eval(code, { timeoutMs: 2000 }).catch(() => {});
        } catch (e) {
            try { await session.log(`plan-visualizer: pushState failed (${e.message})`, { level: "warning" }); } catch {}
        }
    }, 50);
}

// ---- Window lifecycle: arm polling + watcher on first show ---------------
let pollTimer = null;
let watcherPath = null;

function startBackstops(planPath) {
    if (!pollTimer) {
        pollTimer = setInterval(schedulePush, 5000);
    }
    if (planPath && watcherPath !== planPath) {
        if (watcherPath) {
            try { unwatchFile(watcherPath); } catch {}
        }
        watcherPath = planPath;
        try {
            watchFile(planPath, { interval: 1000 }, () => schedulePush());
        } catch {}
    }
}

function stopBackstops() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (watcherPath) {
        try { unwatchFile(watcherPath); } catch {}
        watcherPath = null;
    }
}

// ---- Webview instance + callbacks ---------------------------------------
let session;

const LAYOUT_DEFAULTS = { showPlan: true, showTodos: true, splitFraction: 0.58 };

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function getLayoutFromDisk() {
    const p = readPersistedState();
    return {
        showPlan: typeof p.showPlan === "boolean" ? p.showPlan : LAYOUT_DEFAULTS.showPlan,
        showTodos: typeof p.showTodos === "boolean" ? p.showTodos : LAYOUT_DEFAULTS.showTodos,
        splitFraction: Number.isFinite(p.splitFraction)
            ? clamp(p.splitFraction, 0.05, 0.95)
            : LAYOUT_DEFAULTS.splitFraction,
    };
}

function setLayoutOnDisk(patch = {}) {
    const out = {};
    if (typeof patch.showPlan === "boolean") out.showPlan = patch.showPlan;
    if (typeof patch.showTodos === "boolean") out.showTodos = patch.showTodos;
    if (Number.isFinite(patch.splitFraction)) out.splitFraction = clamp(patch.splitFraction, 0.05, 0.95);
    if (Object.keys(out).length) writePersistedState(out);
}

const BASE_TITLE = "Plan Visualizer";
const webview = new CopilotWebview({
    extensionName: "plan_visualizer",
    contentDir: CONTENT_DIR,
    title: BASE_TITLE,
    width: 1100,
    height: 760,
    callbacks: {
        getState: async () => buildState(),
        requestRefresh: async () => buildState(),
        listThemes: () => listThemes(),
        getInitialTheme: () => readPersistedState().theme || null,
        setThemeChoice: ({ name, mode } = {}) => {
            if (typeof name === "string") writePersistedState({ theme: name, themeMode: mode });
        },
        getLayout: () => getLayoutFromDisk(),
        setLayout: (patch) => { setLayoutOnDisk(patch || {}); },
        log: (msg, opts) => session.log(msg, opts),
    },
});

// Bootstraps the native window title at spawn time so the first paint
// shows "<session name> - Plan Visualizer" without flashing the bare
// "Plan Visualizer" placeholder. Live title updates after the window
// opens are pushed by the page over the wry IPC channel — see
// `setWindowTitle` in content/main.js.
function refreshWindowTitle() {
    const name = readWorkspaceName(cachedSessionInfo?.workspacePath);
    webview.title = name ? `${name} - ${BASE_TITLE}` : BASE_TITLE;
}

// Wrap webview.show so the first opened handle arms the polling + watcher
// and tears them down via handle.onClose. The lib has no public onClose,
// but the underlying handle exposes one — see lib/copilot-webview.js.
const baseShow = webview.show.bind(webview);
webview.show = async (opts) => {
    refreshWindowTitle();
    const handle = await baseShow(opts);
    if (!handle.__planVizArmed) {
        handle.__planVizArmed = true;
        const planPath = (await safeReadPlan()).path;
        startBackstops(planPath);
        handle.onClose(() => {
            stopBackstops();
            lastPushedHash = ""; // force a fresh push on next open
        });
        // Initial push (page also pulls via getState on load — this is best-effort).
        schedulePush();
    }
    return handle;
};

// ---- Join session and wire it all up -------------------------------------
session = await joinSession({
    tools: webview.tools,
    commands: [{
        name: "plan-visualizer",
        description: "Open the plan-visualizer webview window.",
        handler: async () => {
            await webview.show();
            return "plan-visualizer window opened.";
        },
    }],
    hooks: {
        onSessionEnd: async () => { try { stopBackstops(); webview.close(); } catch {} },
        onPostToolUse: async ({ toolName, toolArgs } = {}) => {
            if (toolName === "sql") {
                const q = typeof toolArgs?.query === "string" ? toolArgs.query : "";
                if (/\b(todos|todo_deps)\b/i.test(q)) schedulePush();
            }
            return undefined;
        },
    },
});

cachedSessionInfo = {
    sessionId: session.sessionId,
    cwd: process.cwd(),
    workspacePath: session.workspacePath || null,
};

if (dbLoadError) {
    await session.log(`plan-visualizer: better-sqlite3 not available — to-dos will be unavailable. (${dbLoadError})`, { level: "warning" }).catch(() => {});
}

// Subscribe to plan-change events. operation === "create" auto-opens the window.
session.on("session.plan_changed", async (event) => {
    try {
        const op = event?.data?.operation;
        if (op === "create") {
            await webview.show().catch(() => {});
        }
        schedulePush();
    } catch {}
});
