// Bootstrapper. Copilot CLI loads this file. We can't statically import npm
// deps here because they may not be installed yet on a fresh checkout — so
// `bootstrap` runs `npm install` if needed, then we dynamically import main.
//
// Native modules (better-sqlite3) need to match the CLI's Node ABI. The CLI
// embeds its own Node version, which may be newer than the user's system
// Node — so prebuild-install (run by npm install) needs to be told to fetch
// the prebuild for THIS Node, not the system one. Setting these env vars
// before bootstrap is enough; npm reads them from the inherited environment.
//
// Use unconditional assignment (not `??=`) so a stale value inherited from
// the user's shell (e.g. left over from another native build) can't bypass
// the ABI fix.
process.env.npm_config_runtime = "node";
process.env.npm_config_target = process.versions.node;

import { bootstrap } from "./lib/copilot-webview.js";

await bootstrap(import.meta.dirname);
await import("./main.mjs");
