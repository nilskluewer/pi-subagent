import type { SingleResult } from "./subagent-tool.ts";

export const DEFAULT_RESULT_CAP_TOKENS = 1000;

export function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function capText(
	text: string,
	maxTokens: number,
): { text: string; truncated: boolean; originalApproxTokens: number } {
	const originalApproxTokens = approxTokens(text);
	if (maxTokens <= 0 || originalApproxTokens <= maxTokens) {
		return { text, truncated: false, originalApproxTokens };
	}

	let capped = Array.from(text).slice(0, Math.max(0, maxTokens * 4)).join("");
	while (approxTokens(capped) > maxTokens && capped.length > 0) {
		capped = Array.from(capped).slice(0, -1).join("");
	}
	return { text: capped, truncated: true, originalApproxTokens };
}

export function resolveResultCap(
	itemLevel: number | undefined,
	callLevel: number | undefined,
	configLevel: number | undefined,
): number {
	return itemLevel ?? callLevel ?? configLevel ?? DEFAULT_RESULT_CAP_TOKENS;
}

function resultStatus(result: SingleResult): "completed" | "failed" | "aborted" {
	if (result.stopReason === "aborted") return "aborted";
	if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
	return "completed";
}

export function formatEnvelope(
	result: SingleResult,
	capped: { text: string; truncated: boolean; originalApproxTokens?: number },
	opts: { maxTokens: number },
): string {
	const model = result.model ?? "default";
	const session = result.sessionId ?? "unavailable";
	const header = `[agent: ${result.agent} | model: ${model} | status: ${resultStatus(result)} | session: ${session}]`;
	const parts = [header, capped.text || "(no output)"];

	if (capped.truncated) {
		const originalApproxTokens = capped.originalApproxTokens ?? approxTokens(capped.text);
		const cappedTokens = opts.maxTokens <= 0 ? originalApproxTokens : Math.min(opts.maxTokens, originalApproxTokens);
		if (result.sessionFile && result.sessionId) {
			parts.push(
				`[truncated: showing ~${cappedTokens} of ~${originalApproxTokens} approx. tokens. Full output: read ${result.sessionFile} directly (the JSONL tail has the rest), or resume session "${result.sessionId}" to continue this agent with full context.]`,
			);
		} else {
			parts.push(
				`[truncated: showing ~${cappedTokens} of ~${originalApproxTokens} approx. tokens. Full output unavailable (cannot resume or re-read: this run has no session file).]`,
			);
		}
	}

	return parts.join("\n\n");
}
