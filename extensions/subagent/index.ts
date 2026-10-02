/**
 * Subagent extension: one `subagent` tool that runs a task in an isolated
 * `pi` child process and reports the exact cost of that run.
 *
 * Everything else is left to Pi:
 * - Parallel / chained / aggregated work: the `codemode` tool (`Promise.all`
 *   over `tools.subagent(...)`). The tool declares an `outputSchema`, so
 *   scripts receive `{ text, cost, sessionId, ... }` instead of a string.
 * - Cost: the result carries `usage`, which Pi adds to the session totals
 *   (footer, `/session`). Codemode adds the usage of nested calls as well.
 * - Stopping: Esc aborts the tool call, which kills the child process group.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type Usage, Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { type ChildResult, type Progress, runChild } from "./child.ts";
import { setActiveToolsProvider } from "./inherited-tools.ts";
import { resolveSpec, sessionsDir, writeMeta } from "./spec.ts";

/** Model-facing text per call. The full text stays in structuredContent and on disk. */
const MAX_LINES = 300;
const MAX_BYTES = Math.min(DEFAULT_MAX_BYTES, 16 * 1024);

const Params = Type.Object({
	task: Type.String({ description: "The task for the subagent. It starts with an empty context, so include everything it needs." }),
	// Never add minLength/minItems here: models fill unused fields with "" or [] and then invent junk to satisfy them.
	agent: Type.Optional(Type.String({ description: "Named agent from ~/.pi/agent/agents/<name>.md (at most one of agent | systemPrompt | resume)." })),
	systemPrompt: Type.Optional(Type.String({ description: "Inline persona for an ad-hoc agent." })),
	name: Type.Optional(Type.String({ description: "Display label." })),
	model: Type.Optional(Type.String({ description: "provider/model-id[:thinking-level]. Omit for the configured or child default." })),
	tools: Type.Optional(Type.String({ description: "Comma-separated tools the child may use. Omit to inherit the caller's active tools." })),
	resume: Type.Optional(Type.String({ description: "Session id from an earlier result: continue that agent with its full history." })),
	cwd: Type.Optional(Type.String({ description: "Working directory of the child. Default: the current directory." })),
});

const Output = Type.Object({
	text: Type.String({ description: "Full final answer of the subagent (partial if status is not completed)." }),
	status: Type.String({ description: "completed | error | aborted" }),
	sessionId: Type.String({ description: "Pass as `resume` to continue this agent." }),
	agent: Type.String(),
	model: Type.Optional(Type.String()),
	cost: Type.Number({ description: "USD for this run." }),
	turns: Type.Number(),
	tokens: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() }),
	errorMessage: Type.Optional(Type.String()),
	outputFile: Type.Optional(Type.String({ description: "Full text on disk, when the model-facing text was truncated." })),
});

const money = (usd: number) => `$${usd.toFixed(4)}`;
const kilo = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

export const describeUsage = (usage: Usage, turns: number) =>
	`${money(usage.cost.total)} · ${turns} turn${turns === 1 ? "" : "s"} · ↑${kilo(usage.input)} ↓${kilo(usage.output)}`;

export function buildContent(
	meta: { agent: string; sessionId: string; run: ChildResult },
	outputFile?: string,
): { header: string; body: string; truncated: boolean } {
	const { run } = meta;
	const header = `[agent: ${meta.agent} | model: ${run.model ?? "default"} | status: ${run.status} | cost: ${money(run.usage.cost.total)} | turns: ${run.turns} | session: ${meta.sessionId}]`;
	let body = run.text || "(no output)";
	if (run.status !== "completed") {
		const resume = `Resume with {"resume":"${meta.sessionId}","task":"…"}.`;
		body = `${run.errorMessage ?? run.status}\n${run.status === "aborted" ? resume : ""}\n\nPartial output:\n${body}`.trim();
	}
	const cut = truncateHead(body, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
	if (!cut.truncated) return { header, body, truncated: false };
	return {
		header,
		body: `${cut.content}\n\n[truncated: showing ${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)}. Full text: read ${outputFile} with the read tool.]`,
		truncated: true,
	};
}

export default function (pi: ExtensionAPI) {
	// Children never get the tool: the parent orchestrates (see codemode). This also
	// removes the need for depth limits and a child budget.
	if (process.env.PI_SUBAGENT) {
		pi.on("session_start", () => {
			// Exit when the parent dies, even if its kill never reached this process.
			const parent = process.ppid;
			setInterval(() => process.ppid !== parent && process.exit(0), 5000).unref();
		});
		return;
	}
	setActiveToolsProvider(() => pi.getActiveTools());

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run one task in an isolated child `pi` process and return its final answer plus the exact cost of the run. " +
			"The child starts with an empty context. For independent tasks, call this tool several times in one turn. " +
			`The text shown to you is capped at ${formatSize(MAX_BYTES)}; ask the child for a concise answer.`,
		promptSnippet: "Delegate one self-contained task to an isolated child pi process (returns answer + cost).",
		promptGuidelines: [
			"Use `subagent` when independent work can run in an isolated context. Give each call a disjoint write scope.",
			"For fan-out, chaining, or merging many subagent results, write one `codemode` script: `await Promise.all(items.map(i => tools.subagent({ task: ... })))` and return only the merged summary. Each result has `text`, `cost`, `status`, `sessionId`.",
		],
		parameters: Params,
		outputSchema: Output,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const spec = resolveSpec(params);
			if (!spec.isResume) writeMeta(spec);
			const cwd = params.cwd?.trim() || ctx.cwd;

			const send = (p: Progress) =>
				onUpdate?.({
					content: [{ type: "text", text: `running… ${describeUsage(p.usage, p.turns)}${p.tool ? ` · ${p.tool}` : ""}` }],
					details: { sessionId: spec.sessionId },
				});
			const run = await runChild({ spec, task: params.task, cwd, signal, onProgress: send });

			let outputFile: string | undefined;
			if (Buffer.byteLength(run.text) > MAX_BYTES || run.text.split("\n").length > MAX_LINES) {
				outputFile = path.join(sessionsDir(), `${spec.sessionId}.output.md`);
				fs.writeFileSync(outputFile, run.text, { mode: 0o600 });
			}
			const { header, body } = buildContent({ agent: spec.name, sessionId: spec.sessionId, run }, outputFile);
			const structured = {
				text: run.text,
				status: run.status,
				sessionId: spec.sessionId,
				agent: spec.name,
				model: run.model,
				cost: run.usage.cost.total,
				turns: run.turns,
				tokens: { input: run.usage.input, output: run.usage.output, cacheRead: run.usage.cacheRead, cacheWrite: run.usage.cacheWrite },
				errorMessage: run.errorMessage,
				outputFile,
			};
			return {
				content: [{ type: "text", text: `${header}\n\n${body}` }],
				details: { ...structured, text: undefined },
				structuredContent: JSON.parse(JSON.stringify(structured)),
				// Counted in the session totals even when the run failed or was aborted.
				usage: run.usage,
				isError: run.status !== "completed",
			};
		},
	});
}
