// Child process: opens the native window. The Node event loop is blocked
// by app.run() — all communication happens via the page's WebSocket.
// The one exception is the IPC handler below, which lets the page update
// the OS title bar at runtime (webview2/wry does NOT propagate
// `document.title` to the native title bar automatically).
import { Application } from "@webviewjs/webview";

const { CW_URL, CW_TITLE, CW_WIDTH, CW_HEIGHT } = process.env;
const app = new Application();
const win = app.createBrowserWindow({ title: CW_TITLE, width: +CW_WIDTH, height: +CW_HEIGHT });
const webview = win.createWebview({ url: CW_URL, enableDevtools: true });

// IPC handler. Pages call:
//   window.ipc.postMessage(JSON.stringify({ type: "setTitle", value: "..." }))
// to push a new native title at runtime. Going through the WebSocket round-
// trip (page → extension parent → child) is not viable because the child's
// Node event loop is blocked by app.run() and has no parent-side channel
// into win.setTitle(). The wry IPC fires inside the event-loop callback
// context, where calling win.setTitle() is safe.
webview.onIpcMessage((msg) => {
    try {
        const body = msg?.body;
        if (!body) return;
        const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
        const parsed = JSON.parse(text);
        if (parsed && parsed.type === "setTitle" && typeof parsed.value === "string") {
            win.setTitle(parsed.value);
        }
    } catch {
        // Best-effort: bad payloads are ignored.
    }
});

app.run();
