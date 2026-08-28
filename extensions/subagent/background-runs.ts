import type { SingleResult } from "./subagent-tool.ts";

export type BackgroundRunStatus = "running" | "done" | "failed";

export type BackgroundRunEvent =
	| { type: "registered"; run: BackgroundRun }
	| { type: "stopRequested"; run: BackgroundRun }
	| { type: "settled"; run: BackgroundRun };

export interface BackgroundRun {
	sessionId: string;
	agent: string;
	task: string;
	startedAt: number;
	status: BackgroundRunStatus;
	result?: SingleResult;
	resultCapTokens?: number;
	promise: Promise<SingleResult>;
	stopRequested: boolean;
	abort?: () => void;
	/** Set once a wait call has handed this result to the caller. */
	collectedAt?: number;
}

export interface BackgroundWaitResult {
	selected: BackgroundRun[];
	settled: BackgroundRun[];
	running: BackgroundRun[];
	unknown: string[];
	timedOut: boolean;
	aborted: boolean;
}

export interface RegisterBackgroundRunOptions {
	sessionId: string;
	agent: string;
	task: string;
	promise: Promise<SingleResult>;
	resultCapTokens?: number;
	startedAt?: number;
	/** Replace a terminal record when resuming the same session. Running records are never replaced. */
	replaceSettled?: boolean;
	abort?: () => void;
	failureResult?: (error: unknown) => SingleResult;
}

export const DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

const runs = new Map<string, BackgroundRun>();
const listeners = new Set<(event: BackgroundRunEvent) => void>();
const settlementTimes = new WeakMap<BackgroundRun, number>();
const completionResolvers = new WeakMap<BackgroundRun, (result: SingleResult) => void>();

export function subscribeBackgroundRuns(listener: (event: BackgroundRunEvent) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function emit(event: BackgroundRunEvent): void {
	for (const listener of listeners) {
		try {
			listener(event);
		} catch {
			// Observers must never change background-run lifecycle behaviour.
		}
	}
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fallbackFailureResult(run: Pick<BackgroundRun, "sessionId" | "agent" | "task">, error: unknown): SingleResult {
	const message = describeError(error);
	return {
		agent: run.agent,
		agentSource: "unknown",
		task: run.task,
		sessionId: run.sessionId,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		stopReason: "error",
		errorMessage: message,
	};
}

function settle(
	record: BackgroundRun,
	status: Exclude<BackgroundRunStatus, "running">,
	result: SingleResult,
): BackgroundRun {
	if (record.status !== "running") return record;
	record.status = status;
	record.result = result;
	settlementTimes.set(record, Date.now());
	const resolveCompletion = completionResolvers.get(record);
	completionResolvers.delete(record);
	emit({ type: "settled", run: record });
	resolveCompletion?.(result);
	return record;
}

export function registerBackgroundRun(options: RegisterBackgroundRunOptions): BackgroundRun {
	const existing = runs.get(options.sessionId);
	if (existing && (existing.status === "running" || !options.replaceSettled)) return existing;
	if (existing) runs.delete(options.sessionId);

	let resolveCompletion!: (result: SingleResult) => void;
	const completion = new Promise<SingleResult>((resolve) => {
		resolveCompletion = resolve;
	});
	const record: BackgroundRun = {
		sessionId: options.sessionId,
		agent: options.agent,
		task: options.task,
		startedAt: options.startedAt ?? Date.now(),
		status: "running",
		resultCapTokens: options.resultCapTokens,
		promise: completion,
		stopRequested: false,
		abort: options.abort,
	};
	completionResolvers.set(record, resolveCompletion);

	void options.promise.then(
		(result) => {
			settle(record, isFailedResult(result) ? "failed" : "done", result);
		},
		(error) => {
			let result: SingleResult;
			try {
				result = options.failureResult?.(error) ?? fallbackFailureResult(record, error);
			} catch (failureError) {
				result = fallbackFailureResult(record, failureError);
			}
			settle(record, "failed", result);
		},
	);
	runs.set(record.sessionId, record);
	emit({ type: "registered", run: record });
	return record;
}

export function getBackgroundRun(sessionId: string): BackgroundRun | undefined {
	return runs.get(sessionId);
}

/** Remove a terminal record before a synchronous resume starts a new run. */
export function discardBackgroundRun(sessionId: string): boolean {
	const record = runs.get(sessionId);
	if (!record || record.status === "running") return false;
	runs.delete(sessionId);
	return true;
}

export function listBackgroundRuns(): BackgroundRun[] {
	return [...runs.values()];
}

/**
 * Mark a run as handed to the caller. Waits that do not name an id skip
 * collected runs, so a fleet loop of wait, replace, wait keeps advancing
 * instead of returning the first finished run forever.
 */
export function markBackgroundRunCollected(sessionId: string): void {
	const record = runs.get(sessionId);
	if (record && record.collectedAt === undefined) record.collectedAt = Date.now();
}

function pendingRuns(): BackgroundRun[] {
	return listBackgroundRuns().filter((run) => run.status === "running" || run.collectedAt === undefined);
}

export function clearBackgroundRuns(): void {
	runs.clear();
}

function normalizeTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS;
	return Math.max(0, Math.floor(timeoutMs));
}

function snapshotWaitResult(
	selected: BackgroundRun[],
	unknown: string[],
	timedOut: boolean,
	aborted: boolean,
): BackgroundWaitResult {
	return {
		selected,
		settled: selected.filter((run) => run.status !== "running" && run.result),
		running: selected.filter((run) => run.status === "running"),
		unknown,
		timedOut,
		aborted,
	};
}

interface WaitCompletionOutcome {
	timedOut: boolean;
	aborted: boolean;
}

async function waitForCompletion(
	completion: Promise<unknown>,
	timeoutMs: number | undefined,
	signal?: AbortSignal,
): Promise<WaitCompletionOutcome> {
	if (signal?.aborted) return { timedOut: false, aborted: true };

	const timeout = normalizeTimeout(timeoutMs);
	let timer: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	try {
		return await new Promise<WaitCompletionOutcome>((resolve) => {
			let settled = false;
			const finish = (outcome: WaitCompletionOutcome) => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};

			timer = setTimeout(() => finish({ timedOut: true, aborted: false }), timeout);
			timer.unref?.();

			if (signal) {
				abortListener = () => finish({ timedOut: false, aborted: true });
				signal.addEventListener("abort", abortListener, { once: true });
				if (signal.aborted) abortListener();
			}

			completion.then(
				() => finish({ timedOut: false, aborted: false }),
				() => finish({ timedOut: false, aborted: false }),
			);
		});
	} finally {
		if (timer) clearTimeout(timer);
		if (abortListener && signal) signal.removeEventListener("abort", abortListener);
	}
}

function firstSettledRun(selected: BackgroundRun[]): BackgroundRun | undefined {
	let winner: BackgroundRun | undefined;
	for (const run of selected) {
		if (run.status === "running") continue;
		if (!winner || (settlementTimes.get(run) ?? Number.POSITIVE_INFINITY) < (settlementTimes.get(winner) ?? Number.POSITIVE_INFINITY)) {
			winner = run;
		}
	}
	return winner;
}

async function waitForSelected(
	selected: BackgroundRun[],
	unknown: string[],
	mode: "any" | "all",
	timeoutMs: number | undefined,
	signal?: AbortSignal,
): Promise<BackgroundWaitResult> {
	if (selected.length === 0) return snapshotWaitResult(selected, unknown, false, false);

	const pending = selected.filter((run) => run.status === "running");
	if (mode === "any") {
		const alreadySettled = firstSettledRun(selected);
		if (alreadySettled) return snapshotWaitResult([alreadySettled], unknown, false, false);
	}
	if (pending.length === 0) return snapshotWaitResult(selected, unknown, false, false);

	if (mode === "any") {
		let winner: BackgroundRun | undefined;
		const completion = Promise.race(selected.map((run) => run.promise.then(() => run))).then((run) => {
			winner = run;
		});
		const outcome = await waitForCompletion(completion, timeoutMs, signal);
		return snapshotWaitResult(winner ? [winner] : selected, unknown, outcome.timedOut, outcome.aborted);
	}

	const completion = Promise.all(selected.map((run) => run.promise));
	const outcome = await waitForCompletion(completion, timeoutMs, signal);
	return snapshotWaitResult(selected, unknown, outcome.timedOut, outcome.aborted);
}

export function waitForBackgroundRun(
	sessionId: string,
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<BackgroundWaitResult> {
	return waitForSelected(
		[listBackgroundRuns().find((run) => run.sessionId === sessionId)].filter(Boolean) as BackgroundRun[],
		getBackgroundRun(sessionId) ? [] : [sessionId],
		"all",
		timeoutMs,
		signal,
	);
}

export function waitForFirstBackgroundRun(timeoutMs?: number, signal?: AbortSignal): Promise<BackgroundWaitResult> {
	return waitForSelected(pendingRuns(), [], "any", timeoutMs, signal);
}

export function waitForAllBackgroundRuns(timeoutMs?: number, signal?: AbortSignal): Promise<BackgroundWaitResult> {
	return waitForSelected(pendingRuns(), [], "all", timeoutMs, signal);
}

export function abortBackgroundRun(sessionId: string): boolean {
	const record = runs.get(sessionId);
	if (!record || record.status !== "running" || !record.abort) return false;
	if (record.stopRequested) return true;
	try {
		record.stopRequested = true;
		record.abort();
		emit({ type: "stopRequested", run: record });
		return true;
	} catch {
		record.stopRequested = false;
		return false;
	}
}

export function disposeBackgroundRuns(): void {
	for (const record of runs.values()) {
		if (record.status !== "running" || !record.abort) continue;
		try {
			record.abort();
		} catch {
			/* Best-effort cleanup during session shutdown. */
		}
	}
}
