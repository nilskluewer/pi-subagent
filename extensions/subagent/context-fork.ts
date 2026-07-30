import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message } from "@earendil-works/pi-ai";
import { SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { approxTokens } from "./result-cap.ts";

export type ForkContext = { mode: "none" } | { mode: "all" } | { mode: "turns"; n: number };

export interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	buildContextEntries(): unknown[];
}

export function parseForkContext(raw: string | undefined): ForkContext | { error: string } {
	const value = raw?.trim();
	if (!value || value === "none") return { mode: "none" };
	if (value === "all") return { mode: "all" };
	if (/^[1-9]\d*$/.test(value)) {
		const n = Number(value);
		if (Number.isSafeInteger(n)) return { mode: "turns", n };
	}
	return { error: 'forkContext must be "none", "all", or a positive integer string such as "5".' };
}

export function selectLastNTurns(messages: AgentMessage[], n: number): AgentMessage[] {
	const userIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]?.role === "user") userIndices.push(i);
	}
	if (userIndices.length === 0 || userIndices.length <= n) return messages;
	return messages.slice(userIndices[userIndices.length - n]);
}

export function sanitizeForFork(messages: AgentMessage[]): AgentMessage[] {
	const kept: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			kept.push(message);
			continue;
		}
		if (message.role === "assistant") {
			const text = message.content.filter((part) => part.type === "text");
			if (text.length > 0) kept.push({ ...message, content: text });
			continue;
		}
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			kept.push({
				role: "user",
				content: `[Earlier context summary]\n${message.summary}`,
				timestamp: message.timestamp,
			});
		}
	}
	return kept;
}

export function describeForkSize(tokenCount: number): { label: "small" | "medium" | "large"; warning?: string } {
	if (tokenCount < 2000) return { label: "small" };
	if (tokenCount <= 8000) return { label: "medium" };
	return {
		label: "large",
		warning: `forkContext produced a large context (~${tokenCount} approx tokens; for reference: small is under ~2k, large is over ~8k). Consider forkContext:<N> (a specific turn count) instead of "all" to reduce cost.`,
	};
}

export function forkContextMeta(forkContext: ForkContext): "none" | "all" | number {
	if (forkContext.mode === "turns") return forkContext.n;
	return forkContext.mode;
}

export function buildForkSourceMessages(sessionManager: ForkableSessionManager): AgentMessage[] | { warning: string; parentFile?: undefined } {
	const parentFile = sessionManager.getSessionFile();
	if (!parentFile) {
		return {
			warning: "forkContext requested but the calling agent has no session (--no-session); proceeding without inherited context.",
		};
	}
	const entries = sessionManager.buildContextEntries();
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry as never));
}

export async function applyForkContext(
	spec: { sessionFile: string; cwd?: string; forkContext: ForkContext },
	forkContext: ForkContext,
	sessionManager: ForkableSessionManager,
	sourceMessages?: AgentMessage[] | { warning: string },
): Promise<{ warning?: string; forkedFrom?: string }> {
	if (forkContext.mode === "none") return {};
	const parentFile = sessionManager.getSessionFile();
	if (!parentFile) {
		return {
			warning: "forkContext requested but the calling agent has no session (--no-session); proceeding without inherited context.",
		};
	}

	const source = sourceMessages ?? buildForkSourceMessages(sessionManager);
	if (!Array.isArray(source)) return { warning: source.warning };
	let messages = source;
	if (forkContext.mode === "turns") messages = selectLastNTurns(messages, forkContext.n);
	const sanitized = sanitizeForFork(messages);

	if (!sanitized.some((message) => message.role === "assistant")) {
		return {
			warning: "forkContext requested but there is no prior assistant turn to fork yet; proceeding without inherited context.",
		};
	}

	const sizeInfo = describeForkSize(approxTokens(sanitized.map((message) => JSON.stringify(message)).join("")));
	const childSession = SessionManager.open(spec.sessionFile, undefined, spec.cwd);
	for (const message of sanitized) childSession.appendMessage(message as Message);
	return { warning: sizeInfo.warning, forkedFrom: parentFile };
}
