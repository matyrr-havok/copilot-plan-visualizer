# plan-visualizer themes

A theme is a single CSS file containing one `:root { … }` block that sets
the colour variables used by the page. Drop a `.css` file into any of
the locations the extension scans, then reopen the **Theme ▸** submenu —
it picks up new files on the fly, no extension reload needed.

## Where to put your theme

- **Built-in themes** (tracked in this repo):
  ```
  <extension-install-dir>\content\themes\
  ```
  Editing files here works, but they're owned by the repo and will be
  overwritten on upgrade.

- **User themes** (preserved across `install.ps1` upgrades):
  ```
  <extension-install-dir>\themes\
  ```
  This is the default place for your own themes. The install script
  backs them up before overwriting and restores them after — so you can
  upgrade the extension without losing your colours.

- **User themes (env override)**, useful for syncing themes across
  machines via a personal folder:
  ```
  $env:COPILOT_PLAN_VIZ_THEMES_DIR
  ```
  When set, every `.css` file in that directory is also loaded.

If the same theme name appears in more than one location, **user
themes win over built-in themes**, and the env-override location is
loaded last (so it can shadow both).

## CSS variable reference

The page's stylesheet falls back to its own defaults when a variable is
missing, so a minimal theme can set just `--bg`, `--fg`, `--accent`,
`--border` and the rest will follow. For polish, set them all.

| Variable | Purpose |
| --- | --- |
| `--bg` | Page background |
| `--fg` | Body text |
| `--fg-muted` | Secondary / dimmed text (paths, hints, header timestamps) |
| `--accent` | Primary accent (live dot, splitter hover, links, focus) |
| `--border` | Pane borders, separators, splitter idle colour |
| `--header-bg` | Top bar background (the footer uses `--status-bg` instead) |
| `--subheader-bg` | Pane header background (column titles) |
| `--panel-bg` | Pane body background |
| `--code-bg` | Inline `code` and `pre` backgrounds |
| `--card-bg` | Todo card background |
| `--card-border` | Default left edge of todo cards |
| `--button-bg` | Header button (Refresh) background |
| `--button-bg-hover` | Header button hover background |
| `--button-fg-hover` | Header button hover text |
| `--menu-bg` | Right-click context menu background |
| `--menu-hover-bg` | Context menu / submenu hover background |
| `--pill-bg` | Status group count pill background |
| `--pill-fg` | Status group count pill text |
| `--badge-bg` | Dependency badge background |
| `--badge-fg` | Dependency badge text |
| `--status-bg` | Footer (status bar) background — typically a strong accent |
| `--status-fg` | Footer (status bar) text — must contrast against `--status-bg` |
| `--status-in_progress` | Left edge + group label colour, todos in progress |
| `--status-pending` | Left edge + group label colour, pending todos |
| `--status-done` | Left edge + group label colour, completed todos |
| `--status-blocked` | Left edge + group label colour, blocked todos |

The window's light-vs-dark mode is **auto-detected** from the relative
luminance of `--bg`. You don't need to set a flag.

## Starter template

Save this as `<extension-install-dir>\themes\my-theme.css`, tweak the
values, and pick **My Theme** from the right-click → Theme submenu.

```css
:root {
    --bg: #1a1b26;
    --fg: #c0caf5;
    --fg-muted: #565f89;
    --panel-bg: #1a1b26;
    --header-bg: #16161e;
    --subheader-bg: #1f2335;
    --border: #292e42;
    --accent: #7aa2f7;
    --button-bg: #1f2335;
    --button-bg-hover: #7aa2f7;
    --button-fg-hover: #1a1b26;
    --code-bg: #1f2335;
    --card-bg: #1f2335;
    --card-border: #414868;
    --pill-bg: #292e42;
    --pill-fg: #c0caf5;
    --badge-bg: #292e42;
    --badge-fg: #c0caf5;
    --menu-bg: #1f2335;
    --menu-hover-bg: #7aa2f7;
    --status-bg: #7aa2f7;
    --status-fg: #1a1b26;
    --status-in_progress: #e0af68;
    --status-pending: #7aa2f7;
    --status-done: #9ece6a;
    --status-blocked: #f7768e;
}
```

The file's basename (without `.css`) is the theme name shown in the
menu — keep it filesystem-friendly.
