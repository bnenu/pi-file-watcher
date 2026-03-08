/**
 * File Watcher Extension for pi
 *
 * Watches directories for file saves and extracts lines ending with a trigger
 * marker (default: `#pi!`) as prompts, sending them to the LLM automatically.
 *
 * Installation:
 *   - Global:       ~/.pi/agent/extensions/file-watcher.ts
 *   - Project-local: .pi/extensions/file-watcher.ts
 *   Then run `/reload` inside pi, or restart pi.
 *
 * Commands:
 *   /watch start <path>      Start watching a directory
 *   /watch stop [path]       Stop watching one or all directories
 *   /watch status            Show watched paths and current marker
 *   /watch marker <marker>   Change the trigger marker (default: #pi!)
 *
 * Trigger syntax — add the marker at the end of any comment line:
 *   // refactor this to use async/await  ← add #pi! here to trigger
 *   # rename this variable               ← add #pi! here to trigger
 *   -- optimise this query               ← add #pi! here to trigger
 *
 * How deduplication works (no files, no storage):
 *   When a trigger fires, the watcher closes immediately (the OS drops any
 *   events that arrive during the gap). After the LLM finishes, the watcher
 *   restarts fresh. This means old comments never re-fire unless the user
 *   actively saves the file again — which is intentional re-triggering.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WatcherState {
	watchedPaths: Map<string, fs.FSWatcher>;
	pendingRestart: Set<string>;
	activeMarker: string;
	debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Build a regex that matches comment lines ending with the given marker.
 * Supports: // # -- ; * /* <!--
 */
function buildMarkerRegex(marker: string): RegExp {
	const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`^\\s*(?:\\/\\/|#|--|;+|\\*|\\/\\*|<!--)?\\s*(.*?)\\s*${escaped}\\s*$`,
		"i",
	);
}

/**
 * Returns true for JSDoc/block-comment continuation lines like " * foo".
 * These must be skipped even if they happen to contain the trigger marker
 * (e.g. doc examples in the extension's own header block).
 */
function isJsDocContinuationLine(line: string): boolean {
	return /^\s*\*\s/.test(line);
}

/**
 * Scan file content for trigger lines. Returns clean prompt strings
 * (comment prefix and marker stripped).
 */
function parsePrompts(content: string, marker: string): string[] {
	const regex = buildMarkerRegex(marker);
	const results: string[] = [];
	for (const line of content.split("\n")) {
		if (isJsDocContinuationLine(line)) continue;
		const match = regex.exec(line.trimEnd());
		if (match) {
			const prompt = match[1].trim();
			if (prompt.length > 0) {
				results.push(prompt);
			}
		}
	}
	return results;
}

/**
 * Returns true if the buffer likely contains binary data (null byte in first 512 bytes).
 */
function isBinary(buffer: Buffer): boolean {
	const check = buffer.subarray(0, 512);
	return check.includes(0);
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
// ---------------------------------------------------------------------------

function openWatcher(
	absPath: string,
	state: WatcherState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	let watcher: fs.FSWatcher;

	const eventHandler = (eventType: string, filename: string | null) => {
		if (!filename) return;
		const filePath = path.join(absPath, filename);

		// Debounce: clear existing timer and set a new 300 ms one
		const existing = state.debounceTimers.get(filePath);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			state.debounceTimers.delete(filePath);
			handleFileChange(filePath, state, ctx, pi);
		}, 300);

		state.debounceTimers.set(filePath, timer);
	};

	try {
		watcher = fs.watch(absPath, { recursive: true }, eventHandler);
	} catch {
		// Fallback for Linux / OS that doesn't support recursive
		try {
			watcher = fs.watch(absPath, { recursive: false }, eventHandler);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Recursive watch unavailable on this OS; watching top-level only",
					"warning",
				);
			}
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Failed to watch ${absPath}: ${String(err)}`, "error");
			}
			return;
		}
	}

	state.watchedPaths.set(absPath, watcher);
}

function closeAllWatchers(state: WatcherState): void {
	// Store paths for restart
	for (const p of state.watchedPaths.keys()) {
		state.pendingRestart.add(p);
	}
	// Close all watchers
	for (const watcher of state.watchedPaths.values()) {
		try {
			watcher.close();
		} catch {
			// ignore
		}
	}
	state.watchedPaths.clear();
	// Clear debounce timers
	for (const timer of state.debounceTimers.values()) {
		clearTimeout(timer);
	}
	state.debounceTimers.clear();
}

function reopenAllWatchers(
	state: WatcherState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	for (const absPath of state.pendingRestart) {
		openWatcher(absPath, state, ctx, pi);
	}
	state.pendingRestart.clear();
}

// ---------------------------------------------------------------------------
// File handler
// ---------------------------------------------------------------------------

function handleFileChange(
	filePath: string,
	state: WatcherState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return; // file deleted or inaccessible
	}

	// Skip files > 1 MB
	if (stat.size > 1_048_576) return;

	let buffer: Buffer;
	try {
		buffer = fs.readFileSync(filePath);
	} catch {
		return;
	}

	// Skip binary files
	if (isBinary(buffer)) return;

	const content = buffer.toString("utf-8");
	const prompts = parsePrompts(content, state.activeMarker);
	if (prompts.length === 0) return;

	submitPrompts(prompts, filePath, state, ctx, pi);
}

// ---------------------------------------------------------------------------
// Prompt submission
// ---------------------------------------------------------------------------

function submitPrompts(
	prompts: string[],
	filePath: string,
	state: WatcherState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	// Close all watchers immediately — OS drops any saves during the gap
	closeAllWatchers(state);

	const instruction = prompts.join("\n");
	const message = `File: ${filePath}\n\n${instruction}\n\nAfter completing the above, remove the \`${state.activeMarker}\` comment(s) from the file.`;
	const preview = prompts[0].slice(0, 60) + (prompts[0].length > 60 ? "…" : "");
	const basename = path.basename(filePath);

	if (ctx.isIdle()) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Prompt detected in ${basename}: ${preview}`, "info");
		}
		pi.sendUserMessage(message);
		// Watchers stay closed — agent_end handler will reopen them
	} else {
		if (ctx.hasUI) {
			ctx.ui.notify(`Prompt queued (agent is busy): ${preview}`, "info");
		}
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		// Watchers stay closed — agent_end handler will reopen after followUp runs
	}
}

// ---------------------------------------------------------------------------
// Public start/stop
// ---------------------------------------------------------------------------

function startWatching(
	rawPath: string,
	state: WatcherState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	const absPath = path.resolve(rawPath);

	if (!fs.existsSync(absPath)) {
		if (ctx.hasUI) ctx.ui.notify(`Path not found: ${absPath}`, "error");
		return;
	}

	if (state.watchedPaths.has(absPath)) {
		if (ctx.hasUI) ctx.ui.notify(`Already watching ${absPath}`, "warning");
		return;
	}

	openWatcher(absPath, state, ctx, pi);

	if (ctx.hasUI) {
		ctx.ui.notify(`Watching ${absPath} (marker: ${state.activeMarker})`, "info");
	}
}

function stopWatching(
	rawPath: string | undefined,
	state: WatcherState,
	ctx: ExtensionContext,
): void {
	if (!rawPath) {
		// Stop all
		for (const watcher of state.watchedPaths.values()) {
			try { watcher.close(); } catch { /* ignore */ }
		}
		state.watchedPaths.clear();
		for (const timer of state.debounceTimers.values()) clearTimeout(timer);
		state.debounceTimers.clear();
		if (ctx.hasUI) ctx.ui.notify("Stopped watching all paths", "info");
		return;
	}

	const absPath = path.resolve(rawPath);
	const watcher = state.watchedPaths.get(absPath);
	if (!watcher) {
		if (ctx.hasUI) ctx.ui.notify(`Not currently watching ${absPath}`, "warning");
		return;
	}

	try { watcher.close(); } catch { /* ignore */ }
	state.watchedPaths.delete(absPath);
	// Clear debounce timers for files under this path
	for (const [filePath, timer] of state.debounceTimers) {
		if (filePath.startsWith(absPath)) {
			clearTimeout(timer);
			state.debounceTimers.delete(filePath);
		}
	}
	if (ctx.hasUI) ctx.ui.notify(`Stopped watching ${absPath}`, "info");
}

// ---------------------------------------------------------------------------
// Smoke assertions (run once at load, logged to console)
// ---------------------------------------------------------------------------

function runSmokeTests(): void {
	const assert = (desc: string, actual: unknown, expected: unknown) => {
		const pass = JSON.stringify(actual) === JSON.stringify(expected);
		if (!pass) {
			console.error(`[file-watcher] FAIL: ${desc}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
		}
	};

	// JS comment
	assert("JS //", parsePrompts("// refactor to async #pi!", "#pi!"), ["refactor to async"]);
	// Python comment
	assert("Python #", parsePrompts("# rename variable #pi!", "#pi!"), ["rename variable"]);
	// SQL comment
	assert("SQL --", parsePrompts("-- optimise query #pi!", "#pi!"), ["optimise query"]);
	// No match
	assert("no match", parsePrompts("just a normal line", "#pi!"), []);
	// Multi-line batch
	assert("multi", parsePrompts("// fix this #pi!\n// also that #pi!", "#pi!"), ["fix this", "also that"]);
	// Case-insensitive marker
	assert("case-insensitive", parsePrompts("// do something #PI!", "#pi!"), ["do something"]);
	// JSDoc continuation lines must NOT trigger
	assert("jsdoc skip *", parsePrompts(" *   // refactor this #pi!", "#pi!"), []);
	assert("jsdoc skip * 2", parsePrompts(" * fix something #pi!", "#pi!"), []);
	// isBinary
	const binBuf = Buffer.from([72, 101, 108, 0, 111]); // 'Hel\0o'
	assert("isBinary true", isBinary(binBuf), true);
	const textBuf = Buffer.from("hello world");
	assert("isBinary false", isBinary(textBuf), false);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const state: WatcherState = {
		watchedPaths: new Map(),
		pendingRestart: new Set(),
		activeMarker: "#pi!",
		debounceTimers: new Map(),
	};

	// Run smoke tests on load
	runSmokeTests();

	// Reopen watchers after every LLM turn — covers both normal turns and followUps
	pi.on("agent_end", async (_event, ctx) => {
		if (state.pendingRestart.size > 0) {
			reopenAllWatchers(state, ctx, pi);
		}
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		for (const watcher of state.watchedPaths.values()) {
			try { watcher.close(); } catch { /* ignore */ }
		}
		for (const timer of state.debounceTimers.values()) clearTimeout(timer);
		state.watchedPaths.clear();
		state.debounceTimers.clear();
		state.pendingRestart.clear();
	});

	// /watch command
	pi.registerCommand("watch", {
		description: "Control file watching. Usage: /watch start <path> | stop [path] | status | marker <marker>",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0];

			switch (subcommand) {
				case "start": {
					const watchPath = parts[1];
					if (!watchPath) {
						ctx.ui.notify("Usage: /watch start <path>", "warning");
						return;
					}
					startWatching(watchPath, state, ctx, pi);
					break;
				}

				case "stop": {
					const stopPath = parts[1]; // optional
					stopWatching(stopPath, state, ctx);
					break;
				}

				case "status": {
					if (state.watchedPaths.size === 0) {
						ctx.ui.notify(
							"Not watching any paths. Use /watch start <path> to begin.",
							"info",
						);
					} else {
						const pathList = [...state.watchedPaths.keys()].join("\n  ");
						ctx.ui.notify(
							`Watching ${state.watchedPaths.size} path(s) (marker: ${state.activeMarker}):\n  ${pathList}`,
							"info",
						);
					}
					break;
				}

				case "marker": {
					const newMarker = parts[1];
					if (!newMarker) {
						ctx.ui.notify("Usage: /watch marker <marker>", "warning");
						return;
					}
					state.activeMarker = newMarker;
					ctx.ui.notify(`Trigger marker set to: ${newMarker}`, "info");
					break;
				}

				default: {
					ctx.ui.notify(
						"Usage: /watch start <path> | stop [path] | status | marker <marker>",
						"info",
					);
					break;
				}
			}
		},
	});
}
