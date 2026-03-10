# pi-file-watcher

Aider-style watch mode for [pi](https://shittycodingagent.ai). Watch any folder for source file saves — when a line ending with `#pi!` is detected, it's automatically sent to the LLM as a prompt.

## Install

```bash
pi install npm:pi-file-watcher
```

## Usage

Start watching a directory (defaults to `.` if no path given):

```
/watch start
/watch start ./src
```

Then in any source file, add `#pi!` at the end of a comment line and save:

```ts
// refactor this function to use async/await  #pi!
```

```python
# rename this variable to something descriptive  #pi!
```

```sql
-- optimise this query  #pi!
```

Pi picks it up instantly and starts working. The marker is automatically removed from the file when the task is complete.

### Deferred execution

Add a time annotation after `#pi!` to schedule the prompt instead of firing immediately:

```ts
// refactor this to use async/await    #pi! @5m
// review this file for edge cases     #pi! @2h
// clean up before standup             #pi! @09:30
// come back to this tonight           #pi! @18:00
```

**Relative formats:** `30s`, `5m`, `2h`, `1h30m`
**Absolute format:** `HH:MM` local time (schedules next day if already past)

If you save again before the timer fires, the old job is cancelled and re-evaluated from the new file content. Use `/watch cancel` to cancel manually.

## Configuration

### Auto-start watching (recommended)

Launch pi and start watching immediately with `--watch`:

```bash
pi --watch ./src
pi --watch ./src --marker "#go!"
```

Or persist it in your settings file (`~/.pi/agent/settings.json` for global, `.pi/settings.json` for project):

```json
{ "flags": { "--watch": "./src", "--marker": "#go!" } }
```

### Extra ignored directories

By default the watcher skips `node_modules`, `.git`, `dist`, `build`, and a handful of other common output dirs. Add more with `--ignore` (comma-separated, merged with the defaults):

```bash
pi --ignore "tmp,fixtures,__snapshots__"
```

Or in settings:

```json
{ "flags": { "--ignore": "tmp,fixtures" } }
```

### Persistent marker

Set your preferred marker once via CLI flag — pi remembers it across sessions:

```bash
pi --marker "#go!"
```

Or add it to your settings file:

```json
{ "flags": { "--marker": "#go!" } }
```

### Runtime marker change

Change the marker for the current session only:

```
/watch marker #go!
```

## Commands

| Command | Description |
|---|---|
| `/watch start [path]` | Start watching a directory (defaults to `.`) |
| `/watch stop [path]` | Stop watching one or all directories |
| `/watch status` | Show watched paths, marker, and pending deferred jobs |
| `/watch marker <marker>` | Change the trigger marker for this session |
| `/watch cancel [path]` | Cancel pending deferred job(s) |

## How it works

When a trigger fires, the file watcher closes immediately — the OS drops any events that arrive while the LLM is processing. After the LLM finishes its turn, the watcher restarts fresh. This means **no storage, no seen-set, no extra files** — the OS kernel provides the deduplication guarantee. The same approach used by [aider](https://aider.chat/docs/usage/watch.html).

The LLM is also instructed to remove the `#pi!` marker from the file as part of completing the task, preventing accidental re-triggers on subsequent saves.

## License

MIT
