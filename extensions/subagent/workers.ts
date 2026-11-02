/** Session-scoped live display. It does not depend on codemode forwarding onUpdate. */
import { readFileSync } from "node:fs";
import { parseSessionEntries, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage, type ChildResult, type Progress, type Status } from "./child.ts";
import type { Spec } from "./spec.ts";

const KEY = "subagent-workers";
export const WORKER_ENTRY = "subagent-worker";
const VISIBILITY_ENTRY = "subagent-worker-visibility";

export interface Worker {
	id: string;
	sessionId: string;
	sessionFile?: string;
	cwd?: string;
	name: string;
	requestedModel?: string;
	requestedThinking?: string;
	model?: string;
	thinking?: string;
	/** Reported assistant costs already in the child session before dispatch. */
	priorCost: number;
	startedAt: number;
	endedAt?: number;
	status: "running" | Status;
	progress: Progress;
}

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
const money = (value: number) => `$${value.toFixed(4)}`;
const tokens = (value: number) => value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;
const elapsed = (ms: number) => {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Match runChild's assistant-usage accounting, including runs from other main sessions. */
export function readSessionCost(file: string): number {
	let cost = 0;
	for (const entry of parseSessionEntries(readFileSync(file, "utf8"))) {
		if (entry.type === "message" && entry.message?.role === "assistant") cost += entry.message.usage?.cost?.total ?? 0;
	}
	return cost;
}

export function sessionCost(workers: Worker[], sessionId: string): number {
	const latest = workers.filter((worker) => worker.sessionId === sessionId).at(-1);
	return latest ? (latest.priorCost ?? 0) + latest.progress.usage.cost.total : 0;
}

export function renderWorkers(workers: Worker[], now: number, width: number): string[] {
	if (!workers.length || width < 1) return [];
	const active = workers.filter((worker) => worker.status === "running");
	const latest = new Map(workers.map((worker) => [worker.sessionId, worker]));
	const done = [...latest.values()].filter((worker) => worker.status !== "running");
	const activeSessions = new Set(active.map((worker) => worker.sessionId));
	const activeCost = [...activeSessions].reduce((sum, id) => sum + sessionCost(workers, id), 0);
	const lines = [`Subagents · ${active.length} active · running Σ ${money(activeCost)} reported · F8 open subagent`];
	const shown = [...active, ...done.slice(-3)];
	shown.forEach((worker, index) => {
		const branch = index === shown.length - 1 ? "└─" : "├─";
		const indent = index === shown.length - 1 ? "   " : "│  ";
		const running = worker.status === "running";
		const icon = running ? ["◐", "◓", "◑", "◒"][Math.floor(now / 250) % 4] : worker.status === "completed" ? "✓" : worker.status === "aborted" ? "■" : "✖";
		const model = clean(worker.model ?? worker.requestedModel ?? "awaiting model");
		const modelSource = !worker.model && worker.requestedModel ? " (requested)" : "";
		const thinking = worker.thinking ?? worker.requestedThinking;
		const level = thinking ? `think ${clean(thinking)}${worker.thinking ? "" : " (set)"}` : "think default";
		const cost = money(sessionCost(workers, worker.sessionId));
		const duration = elapsed((worker.endedAt ?? now) - worker.startedAt);
		const identity = `${branch} ${icon} ${clean(worker.name)}  ${model}${modelSource} · ${level}`;
		const completion = `${worker.status} · ${duration} · ${cost}`;
		if (!running && visibleWidth(`${identity} · ${completion}`) > width) {
			lines.push(identity, `${indent} ${completion}`);
		} else {
			lines.push(`${identity}${running ? "" : ` · ${completion}`}`);
		}
		if (running) {
			const usage = worker.progress.usage;
			lines.push(`${indent} ${duration} · ↑${tokens(usage.input)} ↓${tokens(usage.output)} tokens · ${cost} reported`);
			// Keep every model visible, but avoid three lines per worker in a large fan-out.
			if (active.length <= 3) lines.push(`${indent} ${clean(worker.progress.tool ?? worker.progress.preview ?? "Waiting for response…") || "Waiting for response…"}`);
		}
	});
	if (done.length > 3) lines.push(`   + ${done.length - 3} earlier sessions`);
	return lines.map((line) => stripTerminalSequences(truncateToWidth(line, width)));
}

/** One monitor per extension runtime; keyed by call id, never by display name. */
export function createWorkerMonitor(pi: ExtensionAPI) {
	let workers = new Map<string, Worker>();
	let context: ExtensionContext | undefined;
	let parentSession: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let redraw: (() => void) | undefined;
	let mounted = false;
	let generation = 0;
	let idleUserMessages = 0;
	const hasActiveWorkers = () => [...workers.values()].some((worker) => worker.status === "running");
	const unmount = () => {
		context?.ui.setWidget(KEY, undefined);
		mounted = false;
		redraw = undefined;
	};

	const stopTimer = () => { clearInterval(timer); timer = undefined; };
	const mount = () => {
		if (!context || context.mode !== "tui" || mounted || !workers.size || idleUserMessages >= 2) return;
		mounted = true;
		context.ui.setWidget(KEY, (tui, theme) => {
			redraw = () => tui.requestRender();
			return {
				render: (width) => renderWorkers([...workers.values()], Date.now(), width).map((line, index) => theme.fg(index === 0 ? "accent" : line.includes("✖") ? "error" : line.includes("✓") ? "success" : "muted", line)),
				invalidate() {},
			};
		}, { placement: "aboveEditor" });
	};
	const refresh = () => { mount(); redraw?.(); };
	const reset = (ctx: ExtensionContext) => {
		generation++;
		stopTimer();
		unmount();
		context = ctx;
		parentSession = ctx.sessionManager.getSessionId();
		workers = new Map();
		idleUserMessages = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === WORKER_ENTRY) {
				const worker = entry.data as Worker;
				if (worker?.id && worker.status !== "running" && worker.progress?.usage?.cost) {
					workers.set(worker.id, worker);
					idleUserMessages = 0;
				}
			} else if (entry.customType === VISIBILITY_ENTRY) {
				const count = (entry.data as { userMessages?: number })?.userMessages;
				if (typeof count === "number" && Number.isFinite(count)) idleUserMessages = Math.max(0, Math.min(2, Math.floor(count)));
			}
		}
		refresh();
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));
	pi.on("input", (event) => {
		if (event.source === "extension" || (!event.text.trim() && !event.images?.length)) return;
		if (!workers.size || hasActiveWorkers() || idleUserMessages >= 2) return;
		idleUserMessages++;
		pi.appendEntry(VISIBILITY_ENTRY, { userMessages: idleUserMessages });
		if (idleUserMessages >= 2) unmount();
	});
	pi.on("session_shutdown", () => {
		generation++;
		stopTimer();
		unmount();
		workers.clear();
		idleUserMessages = 0;
		context = undefined;
		parentSession = undefined;
		mounted = false;
		redraw = undefined;
	});

	return {
		list: () => [...workers.values()],
		/** Prepare before spawn, then mount only when spawn succeeds in the same session generation. */
		dispatch(ctx: ExtensionContext, id: string, spec: Spec, cwd = ctx.cwd) {
			if (parentSession === undefined) reset(ctx);
			const expectedGeneration = generation;
			const expectedSession = ctx.sessionManager.getSessionId();
			const priorCost = spec.isResume ? readSessionCost(spec.sessionFile) : 0;
			return () => {
				if (expectedGeneration !== generation || expectedSession !== parentSession) return;
				idleUserMessages = 0;
				workers.set(id, {
					id, sessionId: spec.sessionId, sessionFile: spec.sessionFile, cwd, name: spec.name, requestedModel: spec.model, requestedThinking: spec.thinking,
					priorCost, startedAt: Date.now(), status: "running", progress: { usage: emptyUsage(), turns: 0 },
				});
				refresh();
				if (ctx.mode === "tui" && !timer) {
					timer = setInterval(() => redraw?.(), 250);
					timer.unref();
				}
			};
		},
		update(id: string, progress: Progress) {
			const worker = workers.get(id);
			if (!worker) return;
			worker.progress = progress;
			worker.model = progress.model ?? worker.model;
			worker.thinking = progress.thinking ?? worker.thinking;
		},
		finish(id: string, run: Pick<ChildResult, "status" | "model" | "thinking" | "usage" | "turns">) {
			const worker = workers.get(id);
			if (!worker) return;
			worker.status = run.status;
			worker.model = run.model ?? worker.model;
			worker.thinking = run.thinking ?? worker.thinking;
			worker.endedAt = Date.now();
			worker.progress = { usage: run.usage, turns: run.turns };
			idleUserMessages = 0;
			pi.appendEntry(WORKER_ENTRY, structuredClone(worker));
			if (!hasActiveWorkers()) stopTimer();
			refresh();
		},
		fail(id: string) {
			const worker = workers.get(id);
			if (worker) this.finish(id, { status: "error", model: worker.model, thinking: worker.thinking, usage: worker.progress.usage, turns: worker.progress.turns });
		},
	};
}
