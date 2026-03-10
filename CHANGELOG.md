# Changelog

## 1.2.0 — 2026-03-10

### Added
- **Deferred execution** — append a time annotation to `#pi!` to schedule the prompt instead of firing immediately:
  - Relative: `#pi! @5m`, `#pi! @2h`, `#pi! @1h30m`, `#pi! @30s`
  - Absolute clock time (local): `#pi! @09:30`, `#pi! @18:00` (schedules next day if already past)
  - Re-saving the file before the timer fires cancels the old job and re-evaluates — latest-save-wins
  - `/watch status` now shows pending deferred jobs with time remaining
  - `/watch cancel [path]` cancels pending deferred job(s)

### Fixed
- `--watch` flag now reads from `process.argv` directly so `pi --watch` (without a path) correctly watches the current directory

## 1.1.0

### Added
- **`--watch` flag** — auto-start watching on launch; pass a path (`pi --watch ./src`) or omit to watch the current directory (`pi --watch`)
- **`--ignore <dirs>` flag** — comma-separated extra directories to skip, merged with the built-in defaults. Persistable via `settings.json`: `{ "flags": { "--ignore": "tmp,fixtures" } }`
- **`/watch start` defaults to `.`** — omitting the path now watches the current directory

### Changed
- The watcher now skips a broad set of noisy directories by default (`node_modules`, `.git`, `dist`, `build`, `.next`, `.nuxt`, `coverage`, `__pycache__`, `.cache`, `.turbo`, `.svelte-kit`, `out`, `.output`, `.vercel`, `.netlify`)

## 1.0.0 — initial release

- `/watch start <path>` — watch a directory for `#pi!` trigger comments
- `/watch stop [path]` — stop watching one or all directories
- `/watch status` — show watched paths and active marker
- `/watch marker <marker>` — change the trigger marker for the current session
- `--marker <marker>` flag — set the trigger marker persistently
- Aider-style deduplication: watcher closes on trigger and reopens after the LLM turn
