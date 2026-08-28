import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	abortBackgroundRun,
	getBackgroundRun,
	listBackgroundRuns,
} from "./background-runs.ts";

type CompletionItem = { value: string; label: string };

function runningRuns() {
	return listBackgroundRuns().filter((run) => run.status === "running");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else if (ctx.mode === "print") process.stdout.write(`${message}\n`);
}

export function getSubagentStopArgumentCompletions(prefix: string): CompletionItem[] | null {
	const fragment = prefix.trim().toLowerCase();
	const matches = runningRuns()
		.filter((run) => run.sessionId.toLowerCase().startsWith(fragment))
		.map((run) => ({ value: run.sessionId, label: `${run.sessionId} (${run.agent})` }));
	return matches.length > 0 ? matches : null;
}

export async function handleSubagentStopCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length > 1) {
		notify(ctx, "Usage: /subagent-stop <session-id>", "error");
		return;
	}
	const sessionId = words[0] ?? "";
	if (!sessionId) {
		const runs = runningRuns();
		notify(
			ctx,
			runs.length > 0
				? `Usage: /subagent-stop <session-id>. Running: ${runs.map((run) => `${run.agent} (${run.sessionId})`).join(", ")}`
				: "No running background subagents.",
			runs.length > 0 ? "warning" : "info",
		);
		return;
	}

	const run = getBackgroundRun(sessionId);
	if (!run) {
		notify(ctx, `Unknown background subagent session "${sessionId}".`, "error");
		return;
	}
	if (run.status !== "running") {
		notify(ctx, `Background subagent "${run.agent}" is already ${run.status}.`, "warning");
		return;
	}
	if (run.stopRequested) {
		notify(ctx, `Stop already requested for background subagent "${run.agent}" (session: ${sessionId}).`, "warning");
		return;
	}
	if (!abortBackgroundRun(sessionId)) {
		notify(ctx, `Could not stop background subagent "${run.agent}" (${sessionId}).`, "error");
		return;
	}
	notify(ctx, `Stop requested for background subagent "${run.agent}" (session: ${sessionId}).`, "info");
}

export function registerSubagentStopCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagent-stop", {
		description: "Stop a running background subagent by session id",
		getArgumentCompletions: getSubagentStopArgumentCompletions,
		handler: handleSubagentStopCommand,
	});
}
