// plan-visualizer page logic.
//
// On load: fetch initial state via `copilot.getState()`. Then accept push
// updates via `window.__plan.update(state)` (called by the extension via
// `webview.eval`). Stale pushes (lower `version`) are ignored.

const planContentEl = document.getElementById("plan-content");
const planPathEl = document.getElementById("plan-path");
const todosContentEl = document.getElementById("todos-content");
const todosCountEl = document.getElementById("todos-count");
const todosMetaEl = document.getElementById("todos-meta");
const sessionInfoEl = document.getElementById("session-info");
const footerStatusEl = document.getElementById("footer-status");
const footerThemeEl = document.getElementById("footer-theme");
const liveDot = document.getElementById("live-dot");
const refreshBtn = document.getElementById("refresh-btn");
const activeStyleEl = document.getElementById("active-theme");

let lastVersion = -1;
let lastState = null;

// ---- Markdown rendering + sanitisation -----------------------------------

function renderMarkdown(md) {
    // marked is loaded as a global script tag in index.html.
    // We disable raw-HTML pass-through where possible and post-sanitise.
    let html;
    try {
        if (typeof marked?.parse === "function") {
            html = marked.parse(md, { mangle: false, headerIds: false });
        } else if (typeof marked === "function") {
            html = marked(md);
        } else {
            html = `<pre>${escapeHtml(md)}</pre>`;
        }
    } catch (e) {
        html = `<pre>${escapeHtml(md)}</pre>`;
    }
    return sanitizeHtml(html);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Strip <script> elements and any attribute starting with `on`. Also remove
// javascript: URLs from href/src.
function sanitizeHtml(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const walk = (node) => {
        if (node.nodeType !== 1) return;
        const tag = node.tagName?.toLowerCase();
        if (tag === "script" || tag === "iframe" || tag === "object" || tag === "embed") {
            node.remove();
            return;
        }
        for (const attr of Array.from(node.attributes)) {
            const n = attr.name.toLowerCase();
            if (n.startsWith("on")) node.removeAttribute(attr.name);
            else if ((n === "href" || n === "src") && /^\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
        }
        for (const c of Array.from(node.childNodes)) walk(c);
    };
    for (const c of Array.from(tpl.content.childNodes)) walk(c);
    const out = document.createElement("div");
    out.appendChild(tpl.content);
    return out.innerHTML;
}

// ---- Render --------------------------------------------------------------

function applyState(state) {
    if (!state || typeof state.version !== "number") return;
    if (state.version <= lastVersion) return;
    lastVersion = state.version;
    lastState = state;

    // Header / session info
    const sess = state.session || {};
    const sid = sess.id ? `${sess.id.slice(0, 8)}…` : "(no session id)";
    sessionInfoEl.textContent = `${sid}   ·   ${sess.cwd || ""}`;
    sessionInfoEl.title = `session ${sess.id || ""}\ncwd ${sess.cwd || ""}\nworkspace ${sess.workspacePath || ""}`;

    // Plan
    if (state.plan?.exists && typeof state.plan.content === "string") {
        planContentEl.innerHTML = renderMarkdown(state.plan.content);
    } else {
        planContentEl.innerHTML = `<p class="placeholder">No plan yet. The agent will create one when you ask for a plan.</p>`;
    }
    planPathEl.textContent = state.plan?.path || "";
    planPathEl.title = state.plan?.path || "";

    // Todos
    renderTodos(state);

    // Footer
    const ts = new Date(state.timestamp || Date.now()).toLocaleTimeString();
    footerStatusEl.textContent = `Updated ${ts}   ·   v${state.version}`;

    // Pulse the live dot
    liveDot.classList.remove("pulse");
    void liveDot.offsetWidth;
    liveDot.classList.add("pulse");
}

const STATUS_ORDER = ["in_progress", "pending", "blocked", "done"];
const STATUS_LABELS = {
    in_progress: "In progress",
    pending: "Pending",
    blocked: "Blocked",
    done: "Done",
};

// ---- Persistent todos overview (status pills + thin progress bar) --------
//
// Built ONCE and mutated in place on every push, so the progress bar's
// flex-grow transition has a previous value to animate from. The cards
// (groups) live in a separate replaceable #todos-groups container.
let overviewEl = null;
let groupsEl = null;
let overviewPillEls = null;        // {status -> {pill, count, dot, label}}
let overviewSegEls = null;         // {status -> seg}
let overviewBarEl = null;
let overviewCountEl = null;

function buildTodosScaffold() {
    if (overviewEl) return;

    todosContentEl.innerHTML = "";

    overviewEl = document.createElement("div");
    overviewEl.id = "todos-overview";
    overviewEl.setAttribute("role", "region");
    overviewEl.setAttribute("aria-label", "Todos overview");

    const pillsRow = document.createElement("div");
    pillsRow.className = "overview-pills";
    overviewPillEls = Object.create(null);
    for (const s of STATUS_ORDER) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "overview-pill";
        btn.dataset.status = s;
        const dot = document.createElement("span");
        dot.className = "overview-dot";
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = "0";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = STATUS_LABELS[s];
        btn.append(dot, count, label);
        pillsRow.appendChild(btn);
        overviewPillEls[s] = { pill: btn, count, dot, label };
    }

    overviewBarEl = document.createElement("div");
    overviewBarEl.className = "overview-bar";
    overviewBarEl.setAttribute("role", "progressbar");
    overviewSegEls = Object.create(null);
    for (const s of STATUS_ORDER) {
        const seg = document.createElement("div");
        seg.className = "overview-bar-seg";
        seg.dataset.status = s;
        seg.style.flexGrow = "0";
        overviewBarEl.appendChild(seg);
        overviewSegEls[s] = seg;
    }

    overviewCountEl = document.createElement("div");
    overviewCountEl.className = "overview-count";
    overviewCountEl.textContent = "0 todos";

    overviewEl.append(pillsRow, overviewBarEl, overviewCountEl);

    groupsEl = document.createElement("div");
    groupsEl.id = "todos-groups";

    todosContentEl.append(overviewEl, groupsEl);
}

function updateOverview(byStatus, total) {
    overviewEl.hidden = false;
    let doneCount = 0;
    for (const s of STATUS_ORDER) {
        const n = byStatus.get(s)?.length ?? 0;
        const ent = overviewPillEls[s];
        ent.count.textContent = String(n);
        ent.pill.classList.toggle("is-zero", n === 0);
        overviewSegEls[s].style.flexGrow = String(n);
        if (s === "done") doneCount = n;
    }
    if (total > 0) {
        overviewBarEl.setAttribute("aria-valuemin", "0");
        overviewBarEl.setAttribute("aria-valuemax", String(total));
        overviewBarEl.setAttribute("aria-valuenow", String(doneCount));
        overviewBarEl.setAttribute("aria-label", `${doneCount} of ${total} todos done`);
        overviewCountEl.textContent = `${doneCount} / ${total} done`;
    } else {
        overviewBarEl.removeAttribute("aria-valuemin");
        overviewBarEl.removeAttribute("aria-valuemax");
        overviewBarEl.removeAttribute("aria-valuenow");
        overviewBarEl.setAttribute("aria-label", "No todos");
        overviewCountEl.textContent = "0 todos";
    }
}

function renderTodos(state) {
    buildTodosScaffold();

    const todos = state.todos || [];
    const deps = state.deps || [];

    if (state.todosError) {
        overviewEl.hidden = true;
        groupsEl.innerHTML = `<div class="todos-error">${escapeHtml(state.todosError)}</div>`;
        todosCountEl.textContent = "";
        todosMetaEl.textContent = state.session?.workspacePath ? "session.db" : "";
        return;
    }
    if (state.todosAvailable === false) {
        overviewEl.hidden = true;
        groupsEl.innerHTML = `<div class="todos-error">better-sqlite3 not loaded — run <code>npm install</code> in the extension dir.</div>`;
        todosCountEl.textContent = "";
        todosMetaEl.textContent = "";
        return;
    }

    todosCountEl.textContent = todos.length ? `(${todos.length})` : "";
    todosMetaEl.textContent = state.session?.workspacePath ? "session.db" : "";

    const byStatus = new Map();
    for (const s of STATUS_ORDER) byStatus.set(s, []);
    for (const t of todos) {
        const s = STATUS_ORDER.includes(t.status) ? t.status : "pending";
        byStatus.get(s).push(t);
    }

    updateOverview(byStatus, todos.length);

    if (!todos.length) {
        groupsEl.innerHTML = `<p class="empty-todos">No todos yet.</p>`;
        return;
    }

    const depsByTodo = new Map();
    for (const d of deps) {
        if (!depsByTodo.has(d.todo_id)) depsByTodo.set(d.todo_id, []);
        depsByTodo.get(d.todo_id).push(d.depends_on);
    }
    const todoStatus = new Map(todos.map((t) => [t.id, t.status]));

    const out = [];
    for (const s of STATUS_ORDER) {
        const items = byStatus.get(s);
        if (!items.length) continue;
        out.push(`<div class="todo-group" data-status="${escapeHtml(s)}">
            <div class="todo-group-header">
                <span>${escapeHtml(STATUS_LABELS[s])}</span>
                <span class="pill">${items.length}</span>
            </div>`);
        for (const t of items) {
            const depList = depsByTodo.get(t.id) || [];
            const depHtml = depList.length
                ? `<div class="dep-row">${depList.map((d) => {
                    const ds = todoStatus.get(d) || "missing";
                    return `<span class="dep-badge dep-${escapeHtml(ds)}" title="depends on ${escapeHtml(d)} (${escapeHtml(ds)})">⟶ ${escapeHtml(d)}</span>`;
                }).join("")}</div>`
                : "";
            out.push(`<div class="todo-card status-${escapeHtml(t.status || "pending")}">
                <div class="title-row">
                    <span class="title">${escapeHtml(t.title || t.id)}</span>
                    <span class="id">${escapeHtml(t.id)}</span>
                </div>
                ${t.description ? `<div class="desc">${escapeHtml(t.description)}</div>` : ""}
                ${depHtml}
            </div>`);
        }
        out.push(`</div>`);
    }
    groupsEl.innerHTML = out.join("");
}

// Replay a CSS animation that may already be on the element. The
// remove → reflow → add sequence forces the keyframes to restart so
// repeat clicks always animate.
function replayAnimation(el, className) {
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
}

const reducedMotionMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
function isReducedMotion() {
    return !!(reducedMotionMq && reducedMotionMq.matches);
}

// Delegated pill-click handler — installed once on the persistent
// #todos-overview, scrolls to the matching group inside #todos-content.
function handleOverviewPillClick(e) {
    const pill = e.target?.closest?.(".overview-pill");
    if (!pill) return;
    const status = pill.dataset.status;
    if (!status) return;
    const group = groupsEl?.querySelector(`.todo-group[data-status="${CSS.escape(status)}"]`);
    if (!group) {
        if (!isReducedMotion()) replayAnimation(pill, "shake");
        return;
    }
    const behavior = isReducedMotion() ? "auto" : "smooth";
    const top = group.offsetTop - todosContentEl.offsetTop;
    todosContentEl.scrollTo({ top: Math.max(0, top), behavior });
    if (!isReducedMotion()) {
        const header = group.querySelector(".todo-group-header");
        if (header) replayAnimation(header, "pulse-highlight");
    }
}

// Expose update API for extension pushes.
window.__plan = { update: applyState };

// ---- Theme machinery -----------------------------------------------------

let themesCache = null;
let activeThemeName = null;

async function ensureThemes() {
    if (themesCache) return themesCache;
    try { themesCache = await copilot.listThemes(); }
    catch { themesCache = []; }
    return themesCache;
}

function applyTheme(name, css, mode) {
    activeThemeName = name;
    activeStyleEl.textContent = css;
    footerThemeEl.textContent = `Theme: ${name}`;
    copilot.setThemeChoice({ name, mode }).catch(() => {});
}

async function initTheme() {
    const themes = await ensureThemes();
    let persisted = null;
    try { persisted = await copilot.getInitialTheme(); } catch {}
    let pick = persisted ? themes.find((t) => t.name === persisted) : null;
    if (!pick) {
        const wantedDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        const wanted = wantedDark ? "default-dark" : "default-light";
        pick = themes.find((t) => t.name === wanted) || themes.find((t) => t.name === "default-dark") || themes[0];
    }
    if (pick) applyTheme(pick.name, pick.css, pick.mode);
}

// ---- Layout state --------------------------------------------------------

const LAYOUT_DEFAULTS = { showPlan: true, showTodos: true, splitFraction: 0.58 };
let layoutState = { ...LAYOUT_DEFAULTS };
const layoutEl = document.getElementById("layout");
const splitterEl = document.getElementById("splitter");

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// Pixel-aware fraction clamp: smaller side is at least max(15%, 220px).
function clampFraction(frac) {
    const usable = Math.max(40, layoutEl.clientWidth - 6);
    const minPx = 220;
    const minFrac = Math.min(0.45, minPx / usable);
    return clamp(frac, minFrac, 1 - minFrac);
}

function dataLayoutFor({ showPlan, showTodos }) {
    if (showPlan && showTodos) return "both";
    if (showPlan) return "plan-only";
    if (showTodos) return "todos-only";
    return "none";
}

function applyLayout(next) {
    layoutState = { ...layoutState, ...next };
    const dl = dataLayoutFor(layoutState);
    layoutEl.dataset.layout = dl;
    if (dl === "both") {
        const f = clampFraction(layoutState.splitFraction);
        layoutEl.style.setProperty("--col-plan", `${f}fr`);
        layoutEl.style.setProperty("--col-todos", `${1 - f}fr`);
    }
    // Refresh menu if currently open so the ✓ marks reflect the new state.
    if (!contextMenu.hidden) renderContextMenu();
}

async function initLayout() {
    let loaded = LAYOUT_DEFAULTS;
    try {
        const fromExt = await copilot.getLayout();
        if (fromExt && typeof fromExt === "object") {
            loaded = {
                showPlan: typeof fromExt.showPlan === "boolean" ? fromExt.showPlan : LAYOUT_DEFAULTS.showPlan,
                showTodos: typeof fromExt.showTodos === "boolean" ? fromExt.showTodos : LAYOUT_DEFAULTS.showTodos,
                splitFraction: Number.isFinite(fromExt.splitFraction)
                    ? clamp(fromExt.splitFraction, 0.05, 0.95)
                    : LAYOUT_DEFAULTS.splitFraction,
            };
        }
    } catch { /* defaults */ }
    applyLayout(loaded);
    document.body.classList.remove("layout-loading");
}

function persistLayout(patch) {
    copilot.setLayout(patch).catch(() => {});
}

// ---- Splitter drag --------------------------------------------------------

let dragPointerId = null;
let dragSavedFraction = null;

function endDrag(persist) {
    if (dragPointerId === null) return;
    try { splitterEl.releasePointerCapture(dragPointerId); } catch {}
    dragPointerId = null;
    document.body.classList.remove("dragging-splitter");
    delete document.body.dataset.dragging;
    if (persist && Number.isFinite(layoutState.splitFraction)) {
        if (dragSavedFraction !== layoutState.splitFraction) {
            persistLayout({ splitFraction: layoutState.splitFraction });
        }
    }
    dragSavedFraction = null;
}

splitterEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (layoutEl.dataset.layout !== "both") return;
    e.preventDefault();
    dragPointerId = e.pointerId;
    dragSavedFraction = layoutState.splitFraction;
    try { splitterEl.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add("dragging-splitter");
    document.body.dataset.dragging = "1";
    hideContextMenu();
});

splitterEl.addEventListener("pointermove", (e) => {
    if (dragPointerId !== e.pointerId) return;
    const rect = layoutEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const usable = Math.max(40, rect.width - 6);
    const raw = x / usable;
    const frac = clampFraction(raw);
    applyLayout({ splitFraction: frac });
});

splitterEl.addEventListener("pointerup", (e) => {
    if (dragPointerId !== e.pointerId) return;
    endDrag(true);
});
splitterEl.addEventListener("pointercancel", (e) => {
    if (dragPointerId !== e.pointerId) return;
    endDrag(true);
});
splitterEl.addEventListener("lostpointercapture", (e) => {
    if (dragPointerId !== e.pointerId) return;
    endDrag(true);
});
window.addEventListener("blur", () => endDrag(true));

// ---- Right-click context menu --------------------------------------------

const contextMenu = document.createElement("div");
contextMenu.id = "context-menu";
contextMenu.hidden = true;
document.body.appendChild(contextMenu);

const themeSubmenu = document.createElement("div");
themeSubmenu.id = "theme-submenu";
themeSubmenu.hidden = true;
document.body.appendChild(themeSubmenu);

function renderContextMenu() {
    contextMenu.innerHTML = "";
    const add = (action, label, opts = {}) => {
        const btn = document.createElement("button");
        btn.dataset.action = action;
        if (opts.disabled) btn.disabled = true;
        const prefix = opts.checked ? "✓ " : opts.indent ? "  " : "";
        if (opts.html) btn.innerHTML = prefix + label;
        else btn.textContent = prefix + label;
        contextMenu.appendChild(btn);
        return btn;
    };
    const sep = () => {
        const s = document.createElement("div");
        s.className = "separator";
        contextMenu.appendChild(s);
    };

    add("toggle:showPlan", "Show plan", { checked: layoutState.showPlan, indent: true });
    add("toggle:showTodos", "Show todos", { checked: layoutState.showTodos, indent: true });
    add("reset-layout", "Reset layout", { indent: true });
    sep();
    add("refresh", "Refresh", { indent: true });
    sep();
    add("theme", `Theme<span class="submenu-arrow">▸</span>`, { html: true, indent: true });
}

function renderThemeSubmenu(themes) {
    themeSubmenu.innerHTML = "";
    if (!themes.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "(no themes found)";
        themeSubmenu.appendChild(empty);
        return;
    }
    const dark = themes.filter((t) => t.mode === "dark");
    const light = themes.filter((t) => t.mode !== "dark");
    const addGroup = (label, items) => {
        if (!items.length) return;
        const lbl = document.createElement("div");
        lbl.className = "label";
        lbl.textContent = label;
        themeSubmenu.appendChild(lbl);
        for (const t of items) {
            const btn = document.createElement("button");
            btn.dataset.theme = t.name;
            const checked = t.name === activeThemeName;
            btn.textContent = (checked ? "✓ " : "  ") + t.name;
            themeSubmenu.appendChild(btn);
        }
    };
    addGroup("Dark", dark);
    if (dark.length && light.length) {
        const sep = document.createElement("div");
        sep.className = "separator";
        themeSubmenu.appendChild(sep);
    }
    addGroup("Light", light);
}

function showThemeSubmenu(anchorRect) {
    themeSubmenu.hidden = false;
    const w = window.innerWidth, h = window.innerHeight;
    let left = anchorRect.right;
    let top = anchorRect.top;
    if (left + themeSubmenu.offsetWidth > w - 4) left = anchorRect.left - themeSubmenu.offsetWidth;
    if (top + themeSubmenu.offsetHeight > h - 4) top = h - themeSubmenu.offsetHeight - 4;
    themeSubmenu.style.left = `${Math.max(0, left)}px`;
    themeSubmenu.style.top = `${top}px`;
}

function hideContextMenu() {
    contextMenu.hidden = true;
    themeSubmenu.hidden = true;
}

contextMenu.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button");
    const action = btn?.dataset?.action;
    if (!action || btn.disabled) return;

    if (action === "refresh") {
        hideContextMenu();
        await pullState();
        return;
    }
    if (action === "reset-layout") {
        applyLayout({ ...LAYOUT_DEFAULTS });
        persistLayout({ ...LAYOUT_DEFAULTS });
        hideContextMenu();
        return;
    }
    if (action.startsWith("toggle:")) {
        const key = action.slice("toggle:".length);
        if (key === "showPlan" || key === "showTodos") {
            const next = !layoutState[key];
            applyLayout({ [key]: next });
            persistLayout({ [key]: next });
        }
        hideContextMenu();
        return;
    }
    if (action === "theme") {
        if (themeSubmenu.hidden) {
            const themes = await ensureThemes();
            renderThemeSubmenu(themes);
            showThemeSubmenu(btn.getBoundingClientRect());
        } else {
            themeSubmenu.hidden = true;
        }
        return;
    }
});

themeSubmenu.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button");
    const name = btn?.dataset?.theme;
    if (!name) return;
    const t = themesCache?.find((x) => x.name === name);
    if (t) applyTheme(t.name, t.css, t.mode);
    hideContextMenu();
});

document.addEventListener("contextmenu", (e) => {
    if (document.body.dataset.dragging === "1") return;
    e.preventDefault();
    renderContextMenu();
    contextMenu.hidden = false;
    themeSubmenu.hidden = true;
    contextMenu.style.left = "0px";
    contextMenu.style.top = "0px";
    const w = window.innerWidth, h = window.innerHeight;
    const { offsetWidth: mw, offsetHeight: mh } = contextMenu;
    contextMenu.style.left = `${Math.min(e.clientX, w - mw - 4)}px`;
    contextMenu.style.top = `${Math.min(e.clientY, h - mh - 4)}px`;
});

document.addEventListener("click", (e) => {
    if (contextMenu.contains(e.target) || themeSubmenu.contains(e.target)) return;
    hideContextMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });

// Re-clamp split fraction on window resize so the pixel-aware min still holds.
window.addEventListener("resize", () => {
    if (layoutEl.dataset.layout !== "both") return;
    const f = clampFraction(layoutState.splitFraction);
    if (f !== layoutState.splitFraction) {
        layoutState.splitFraction = f;
        layoutEl.style.setProperty("--col-plan", `${f}fr`);
        layoutEl.style.setProperty("--col-todos", `${1 - f}fr`);
    }
});

// ---- Boot ---------------------------------------------------------------

async function pullState() {
    try {
        const state = await copilot.getState();
        applyState(state);
    } catch (e) {
        footerStatusEl.textContent = `Error: ${e?.message || e}`;
    }
}

refreshBtn.addEventListener("click", pullState);

(async () => {
    await initTheme();
    await initLayout();
    // Build the persistent overview scaffold BEFORE the first pullState,
    // and install the delegated pill-click handler on it (the overview
    // element is persistent, so a single listener survives all pushes).
    buildTodosScaffold();
    overviewEl.addEventListener("click", handleOverviewPillClick);
    await pullState();
})();
