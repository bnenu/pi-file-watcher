# Changelog

## 1.1.0 — 2026-03-10

### Added
- **`--watch <path>` flag** — auto-start watching a directory on launch without needing `/watch start`.
  Can be persisted in `settings.json`: `{ "flags": { "--watch": "./src" } }`.
- **`--ignore <dirs>` flag** — comma-separated list of extra directory names to skip, merged with the built-in defaults (`node_modules`, `.git`, `dist`, `build`, etc.).
  Can be persisted in `settings.json`: `{ "flags": { "--ignore": "tmp,fixtures" } }`.
- **`/watch start` defaults to `.`** — omitting the path now watches the current directory instead of showing a usage error.

### Changed
- The watcher now skips a broad set of noisy directories by default (`node_modules`, `.git`, `dist`, `build`, `.next`, `.nuxt`, `coverage`, `__pycache__`, `.cache`, `.turbo`, `.svelte-kit`, `out`, `.output`, `.vercel`, `.netlify`). Previously every file save in these directories triggered a read and parse.

## 1.0.0 — initial release

- `/watch start <path>` — watch a directory for `#pi!` trigger comments
- `/watch stop [path]` — stop watching one or all directories
- `/watch status` — show watched paths and active marker
- `/watch marker <marker>` — change the trigger marker for the current session
- `--marker <marker>` flag — set the trigger marker persistently
- Aider-style deduplication: watcher closes on trigger and reopens after the LLM turn
