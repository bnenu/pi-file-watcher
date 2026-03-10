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
 *   /watch start [path]      Start watching a directory (defaults to .)
 *   /watch stop [path]       Stop watching one or all directories
 *   /watch status            Show watched paths, marker, and pending deferred jobs
 *   /watch marker <marker>   Change the trigger marker (default: #pi!)
 *   /watch cancel [path]     Cancel pending deferred job(s)
 *
 * Trigger syntax — add the marker at the end of any comment line:
 *   // refactor this to use async/await  #pi!        ← fires immediately on save
 *   // review this whole file            #pi! @5m    ← fires 5 minutes after save
 *   // optimise this query               #pi! @2h    ← fires 2 hours after save
 *   // clean up before standup           #pi! @09:30 ← fires at 09:30 local time
 *
 * Deferred time spec formats (after @):
 *   Relative: 30s, 5m, 2h, 1h30m
 *   Absolute: HH:MM (local time; schedules next-day if already past)
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
// Ignored paths
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
	"node_modules", ".git", "dist", "build", ".next", ".nuxt",
	"coverage", "__pycache__", ".cache", ".turbo", ".svelte-kit",
	"out", ".output", ".vercel", ".netlify",
]);

function isIgnored(filePath: string, ignoredDirs: Set<string>): boolean {
	return filePath.split(path.sep).some((part) => ignoredDirs.has(part));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedPrompt {
	text: string;
	delayMs: number; // 0 = fire immediately
}

interface DeferredJob {
	filePath: string;
	timer: ReturnType<typeof setTimeout>;
	prompts: ParsedPrompt[];
	fireAt: number; // epoch ms, for time-remaining display
}

interface WatcherState {
	watchedPaths: Map<string, fs.FSWatcher>;
	pendingRestart: Set<string>;
	activeMarker: string;
	debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
	ignoredDirs: Set<string>;
	deferredJobs: Map<string, DeferredJob>; // key: filePath, latest-wins
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
	// Group 1: prompt text. Group 2: optional delay spec after @  (e.g. "5m", "2h", "17:00")
	return new RegExp(
		`^\\s*(?:\\/\\/|#|--|;+|\\*|\\/\\*|<!--)?\\s*(.*?)\\s*${escaped}(?:\\s+@([\\w:]+))?\\s*$`,
		"i",
	);
}

/**
 * Parse a delay spec (without leading @) into milliseconds.
 * Supports relative (5m, 2h, 30s, 1h30m) and absolute clock time (17:00).
 * Returns null if the spec is unrecognised (caller falls back to immediate).
 */
function parseDelay(spec: string): number | null {
	// Relative: optional hours, minutes, seconds — at least one must be present
	const rel = spec.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
	if (rel && (rel[1] || rel[2] || rel[3])) {
		const h = parseInt(rel[1] ?? "0");
		const m = parseInt(rel[2] ?? "0");
		const s = parseInt(rel[3] ?? "0");
		return (h * 3600 + m * 60 + s) * 1000;
	}
	// Absolute clock time: HH:MM (local time)
	const abs = spec.match(/^(\d{1,2}):(\d{2})$/);
	if (abs) {
		const hh = parseInt(abs[1]);
		const mm = parseInt(abs[2]);
		if (hh > 23 || mm > 59) return null;
		const target = new Date();
		target.setHours(hh, mm, 0, 0);
		if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
		return target.getTime() - Date.now();
	}
	return null;
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
 * Scan file content for trigger lines. Returns parsed prompts with optional delay.
 * A line ending in `#pi! @5m` schedules the prompt for 5 minutes from now.
 * A line ending in just `#pi!` fires immediately (delayMs: 0).
 */
function parsePrompts(content: string, marker: string): ParsedPrompt[] {
	const regex = buildMarkerRegex(marker);
	const results: ParsedPrompt[] = [];
	for (const line of content.split("\n")) {
		if (isJsDocContinuationLine(line)) continue;
		const match = regex.exec(line.trimEnd());
		if (match) {
			const text = match[1].trim();
			if (text.length === 0) continue;
			const spec = match[2]; // undefined if no @annotation
			const delayMs = spec != null ? (parseDelay(spec) ?? 0) : 0;
			results.push({ text, delayMs });
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

function notify(ctx: ExtensionContext | null, msg: string, level: "info" | "warning" | "error"): void {
	if (ctx?.hasUI) ctx.ui.notify(msg, level);
	else console.log(`[file-watcher] ${level.toUpperCase()}: ${msg}`);
}

function openWatcher(
	absPath: string,
	state: WatcherState,
	ctx: ExtensionContext | null,
	pi: ExtensionAPI,
): void {
	let watcher: fs.FSWatcher;

	const eventHandler = (eventType: string, filename: string | null) => {
		if (!filename) return;
		const filePath = path.join(absPath, filename);

		// Skip ignored directories
		if (isIgnored(filePath, state.ignoredDirs)) return;

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
			notify(ctx, "Recursive watch unavailable on this OS; watching top-level only", "warning");
		} catch (err) {
			notify(ctx, `Failed to watch ${absPath}: ${String(err)}`, "error");
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
	// NOTE: deferredJobs intentionally NOT cleared here — deferred timers must
	// survive watcher close/reopen cycles and fire independently of watch state.
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

function cancelDeferredJob(filePath: string, state: WatcherState): void {
	const job = state.deferredJobs.get(filePath);
	if (!job) return;
	clearTimeout(job.timer);
	state.deferredJobs.delete(filePath);
}

function handleFileChange(
	filePath: string,
	state: WatcherState,
	ctx: ExtensionContext | null,
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
	const parsed = parsePrompts(content, state.activeMarker);

	// Any re-save cancels an existing deferred job for this file (latest-wins)
	cancelDeferredJob(filePath, state);

	if (parsed.length === 0) return;

	const immediate = parsed.filter((p) => p.delayMs === 0).map((p) => p.text);
	const deferred = parsed.filter((p) => p.delayMs > 0);

	if (immediate.length > 0) {
		submitPrompts(immediate, filePath, state, ctx, pi);
	}

	if (deferred.length > 0) {
		// All deferred prompts on this file fire together at the longest delay
		const maxDelayMs = Math.max(...deferred.map((p) => p.delayMs));
		const fireAt = Date.now() + maxDelayMs;

		const timer = setTimeout(() => {
			state.deferredJobs.delete(filePath);
			submitPrompts(deferred.map((p) => p.text), filePath, state, null, pi);
		}, maxDelayMs);

		state.deferredJobs.set(filePath, { filePath, timer, prompts: deferred, fireAt });

		const basename = path.basename(filePath);
		const count = deferred.length;
		const mins = Math.round(maxDelayMs / 60_000);
		const timeStr = maxDelayMs < 60_000
			? `${Math.round(maxDelayMs / 1000)}s`
			: mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ""}`;
		notify(ctx, `${count} prompt(s) in ${basename} scheduled in ${timeStr}`, "info");
	}
}

// ---------------------------------------------------------------------------
// Prompt submission
// ---------------------------------------------------------------------------

function submitPrompts(
	prompts: string[],
	filePath: string,
	state: WatcherState,
	ctx: ExtensionContext | null,
	pi: ExtensionAPI,
): void {
	// Close all watchers immediately — OS drops any saves during the gap
	closeAllWatchers(state);

	const instruction = prompts.join("\n");
	const message = `File: ${filePath}\n\n${instruction}\n\nAfter completing the above, remove the \`${state.activeMarker}\` comment(s) from the file.`;
	const preview = prompts[0].slice(0, 60) + (prompts[0].length > 60 ? "…" : "");
	const basename = path.basename(filePath);

	// When ctx is null (auto-started before any agent turn), assume idle
	if (!ctx || ctx.isIdle()) {
		notify(ctx, `Prompt detected in ${basename}: ${preview}`, "info");
		pi.sendUserMessage(message);
		// Watchers stay closed — agent_end handler will reopen them
	} else {
		notify(ctx, `Prompt queued (agent is busy): ${preview}`, "info");
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
	ctx: ExtensionContext | null,
	pi: ExtensionAPI,
): void {
	const absPath = path.resolve(rawPath);

	if (!fs.existsSync(absPath)) {
		notify(ctx, `Path not found: ${absPath}`, "error");
		return;
	}

	if (state.watchedPaths.has(absPath)) {
		notify(ctx, `Already watching ${absPath}`, "warning");
		return;
	}

	openWatcher(absPath, state, ctx, pi);
	notify(ctx, `Watching ${absPath} (marker: ${state.activeMarker})`, "info");
}

function stopWatching(
	rawPath: string | undefined,
	state: WatcherState,
	ctx: ExtensionContext | null,
): void {
	if (!rawPath) {
		// Stop all
		for (const watcher of state.watchedPaths.values()) {
			try { watcher.close(); } catch { /* ignore */ }
		}
		state.watchedPaths.clear();
		for (const timer of state.debounceTimers.values()) clearTimeout(timer);
		state.debounceTimers.clear();
		for (const job of state.deferredJobs.values()) clearTimeout(job.timer);
		state.deferredJobs.clear();
		notify(ctx, "Stopped watching all paths", "info");
		return;
	}

	const absPath = path.resolve(rawPath);
	const watcher = state.watchedPaths.get(absPath);
	if (!watcher) {
		notify(ctx, `Not currently watching ${absPath}`, "warning");
		return;
	}

	try { watcher.close(); } catch { /* ignore */ }
	state.watchedPaths.delete(absPath);
	// Clear debounce timers and deferred jobs for files under this path
	for (const [filePath, timer] of state.debounceTimers) {
		if (filePath.startsWith(absPath)) {
			clearTimeout(timer);
			state.debounceTimers.delete(filePath);
		}
	}
	for (const [filePath, job] of state.deferredJobs) {
		if (filePath.startsWith(absPath)) {
			clearTimeout(job.timer);
			state.deferredJobs.delete(filePath);
		}
	}
	notify(ctx, `Stopped watching ${absPath}`, "info");
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

	// parsePrompts — immediate (no annotation)
	assert("JS //",    parsePrompts("// refactor to async #pi!", "#pi!"), [{ text: "refactor to async", delayMs: 0 }]);
	assert("Python #", parsePrompts("# rename variable #pi!",   "#pi!"), [{ text: "rename variable",   delayMs: 0 }]);
	assert("SQL --",   parsePrompts("-- optimise query #pi!",   "#pi!"), [{ text: "optimise query",    delayMs: 0 }]);
	assert("no match", parsePrompts("just a normal line",        "#pi!"), []);
	assert("multi",    parsePrompts("// fix this #pi!\n// also that #pi!", "#pi!"),
		[{ text: "fix this", delayMs: 0 }, { text: "also that", delayMs: 0 }]);
	assert("case-insensitive", parsePrompts("// do something #PI!", "#pi!"), [{ text: "do something", delayMs: 0 }]);
	assert("jsdoc skip *",   parsePrompts(" *   // refactor this #pi!", "#pi!"), []);
	assert("jsdoc skip * 2", parsePrompts(" * fix something #pi!",     "#pi!"), []);

	// parsePrompts — deferred annotations
	assert("deferred 5m",    parsePrompts("// refactor #pi! @5m",   "#pi!"), [{ text: "refactor",    delayMs: 5 * 60_000 }]);
	assert("deferred 2h",    parsePrompts("// review #pi! @2h",     "#pi!"), [{ text: "review",      delayMs: 2 * 3_600_000 }]);
	assert("deferred 30s",   parsePrompts("// quick fix #pi! @30s", "#pi!"), [{ text: "quick fix",   delayMs: 30_000 }]);
	assert("deferred 1h30m", parsePrompts("// refactor #pi! @1h30m","#pi!"), [{ text: "refactor",    delayMs: 5_400_000 }]);
	assert("deferred bad spec falls back to immediate",
		parsePrompts("// fix #pi! @badspec", "#pi!"), [{ text: "fix", delayMs: 0 }]);

	// parseDelay
	assert("parseDelay 5m",    parseDelay("5m"),    5 * 60_000);
	assert("parseDelay 2h",    parseDelay("2h"),    2 * 3_600_000);
	assert("parseDelay 30s",   parseDelay("30s"),   30_000);
	assert("parseDelay 1h30m", parseDelay("1h30m"), 5_400_000);
	assert("parseDelay 0m",    parseDelay("0m"),    0);
	assert("parseDelay bad",   parseDelay("badspec"), null);
	assert("parseDelay empty", parseDelay(""),        null);
	assert("parseDelay 25:00", parseDelay("25:00"),   null); // invalid hour
	assert("parseDelay 12:60", parseDelay("12:60"),   null); // invalid minute
	// Absolute clock: value depends on current time, so just range-check
	const absDelay = parseDelay("23:59");
	if (absDelay === null || absDelay <= 0 || absDelay > 24 * 3_600_000) {
		console.error(`[file-watcher] FAIL: parseDelay 23:59 out of range, got: ${absDelay}`);
	}

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
	// Register --marker flag so users can configure it persistently:
	//   pi --marker "#go!"
	// Or in ~/.pi/agent/settings.json / .pi/settings.json:
	//   { "flags": { "--marker": "#go!" } }
	pi.registerFlag("marker", {
		description: 'Trigger marker for file-watcher (default: "#pi!")',
		type: "string",
		default: "#pi!",
	});

	pi.registerFlag("watch", {
		description: "Auto-start watching on launch. Optionally specify a path (pi --watch ./src); omit to watch the current directory (pi --watch)",
		type: "string",
	});

	pi.registerFlag("ignore", {
		description: 'Extra directories to ignore, comma-separated (merged with defaults). E.g. pi --ignore "tmp,fixtures"',
		type: "string",
	});

	const ignoredDirs = new Set(IGNORED_DIRS);
	const extraIgnore = pi.getFlag("--ignore") as string | undefined;
	if (extraIgnore) {
		for (const dir of extraIgnore.split(",").map((s) => s.trim()).filter(Boolean)) {
			ignoredDirs.add(dir);
		}
	}

	const state: WatcherState = {
		watchedPaths: new Map(),
		pendingRestart: new Set(),
		activeMarker: (pi.getFlag("--marker") as string | undefined) ?? "#pi!",
		debounceTimers: new Map(),
		ignoredDirs,
		deferredJobs: new Map(),
	};

	// Run smoke tests on load
	runSmokeTests();

	// Auto-start watching if --watch flag is set.
	// Accepts a path (pi --watch ./src) or no value (pi --watch) to watch cwd.
	// Reads process.argv directly since pi's flag system requires a value for string flags.
	const watchArgIndex = process.argv.indexOf("--watch");
	if (watchArgIndex !== -1) {
		const next = process.argv[watchArgIndex + 1];
		const autoWatchPath = next && !next.startsWith("-") ? next : ".";
		startWatching(autoWatchPath, state, null, pi);
	}

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
		for (const job of state.deferredJobs.values()) clearTimeout(job.timer);
		state.watchedPaths.clear();
		state.debounceTimers.clear();
		state.deferredJobs.clear();
		state.pendingRestart.clear();
	});

	// /watch command
	pi.registerCommand("watch", {
		description: "Control file watching. Usage: /watch start [path] | stop [path] | status | marker <marker> | cancel [path]",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0];

			switch (subcommand) {
				case "start": {
					const watchPath = parts[1] ?? ".";
					startWatching(watchPath, state, ctx, pi);
					break;
				}

				case "stop": {
					const stopPath = parts[1]; // optional
					stopWatching(stopPath, state, ctx);
					break;
				}

				case "status": {
					const lines: string[] = [];
					if (state.watchedPaths.size > 0) {
						const pathList = [...state.watchedPaths.keys()].join("\n  ");
						lines.push(`Watching ${state.watchedPaths.size} path(s) (marker: ${state.activeMarker}):\n  ${pathList}`);
					}
					if (state.deferredJobs.size > 0) {
						const jobLines = [...state.deferredJobs.values()].map((job) => {
							const remSec = Math.max(0, Math.round((job.fireAt - Date.now()) / 1000));
							const h = Math.floor(remSec / 3600);
							const m = Math.floor((remSec % 3600) / 60);
							const s = remSec % 60;
							const t = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
							return `  ${path.basename(job.filePath)} — fires in ${t}`;
						});
						lines.push(`Pending deferred jobs (${state.deferredJobs.size}):\n${jobLines.join("\n")}`);
					}
					if (lines.length === 0) {
						ctx.ui.notify("Not watching any paths. Use /watch start to begin.", "info");
					} else {
						ctx.ui.notify(lines.join("\n\n"), "info");
					}
					break;
				}

				case "cancel": {
					const cancelPath = parts[1];
					if (!cancelPath) {
						if (state.deferredJobs.size === 0) {
							ctx.ui.notify("No pending deferred jobs.", "info");
							return;
						}
						const count = state.deferredJobs.size;
						for (const job of state.deferredJobs.values()) clearTimeout(job.timer);
						state.deferredJobs.clear();
						ctx.ui.notify(`Cancelled ${count} deferred job(s).`, "info");
					} else {
						const absCancel = path.resolve(cancelPath);
						const job = state.deferredJobs.get(absCancel);
						if (!job) {
							ctx.ui.notify(`No pending deferred job for ${absCancel}`, "warning");
							return;
						}
						clearTimeout(job.timer);
						state.deferredJobs.delete(absCancel);
						ctx.ui.notify(`Cancelled deferred job for ${path.basename(absCancel)}`, "info");
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
						"Usage: /watch start [path] | stop [path] | status | marker <marker> | cancel [path]",
						"info",
					);
					break;
				}
			}
		},
	});
}
