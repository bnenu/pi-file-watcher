# pi-file-watcher

Aider-style watch mode for [pi](https://shittycodingagent.ai). Watch any folder for source file saves — when a line ending with `#pi!` is detected, it's automatically sent to the LLM as a prompt.

## Install

```bash
pi install npm:pi-file-watcher
```

## Usage

Start watching a directory:

```
/watch start ./src
```

Then in any source file, add `#pi!` at the end of a comment line and save:

```ts
// refactor this function to use async/await  ← add #pi! and save
```

```python
# rename this variable to something descriptive  ← add #pi! and save
```

```sql
-- optimise this query  ← add #pi! and save
```

Pi picks it up instantly and starts working. The marker is automatically removed from the file when the task is complete.

## Commands

| Command | Description |
|---|---|
| `/watch start <path>` | Start watching a directory |
| `/watch stop [path]` | Stop watching one or all directories |
| `/watch status` | Show watched paths and current marker |
| `/watch marker <marker>` | Change the trigger marker (default: `#pi!`) |

## How it works

When a trigger fires, the file watcher closes immediately — the OS drops any events that arrive while the LLM is processing. After the LLM finishes its turn, the watcher restarts fresh. This means **no storage, no seen-set, no extra files** — the OS kernel provides the deduplication guarantee. The same approach used by [aider](https://aider.chat/docs/usage/watch.html).

The LLM is also instructed to remove the `#pi!` marker from the file as part of completing the task, preventing accidental re-triggers on subsequent saves.

## License

MIT
