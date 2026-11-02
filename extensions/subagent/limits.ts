/** Per-invocation limits. Resumed history does not count against a new call. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Limits {
	maxCost: number;
	maxTurns: number;
}

export function resolveLimits(params: Partial<Limits>): Limits {
	const maxCost = params.maxCost ?? 10;
	const maxTurns = params.maxTurns ?? 100;
	if (typeof maxCost !== "number" || !Number.isFinite(maxCost) || maxCost <= 0) {
		throw new Error("maxCost must be a finite number greater than zero (USD).");
	}
	if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
		throw new Error("maxTurns must be a positive safe integer.");
	}
	return { maxCost, maxTurns };
}

export default function (pi: ExtensionAPI): void {
	if (!process.env.PI_SUBAGENT) return;
	registerChildLimits(pi, resolveLimits({
		maxCost: process.env.PI_SUBAGENT_MAX_COST === undefined ? undefined : Number(process.env.PI_SUBAGENT_MAX_COST),
		maxTurns: process.env.PI_SUBAGENT_MAX_TURNS === undefined ? undefined : Number(process.env.PI_SUBAGENT_MAX_TURNS),
	}));
}

/** Stop inside the child before tool execution or another provider request. */
export function registerChildLimits(pi: ExtensionAPI, limits: Limits): void {
	let turns = 0;
	let cost = 0;
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		turns++;
		cost += event.message.usage?.cost?.total ?? 0;
		const reason = cost >= limits.maxCost
			? `Subagent stopped: maxCost $${limits.maxCost} reached ($${cost.toFixed(4)} reported).`
			: turns >= limits.maxTurns ? `Subagent stopped: maxTurns ${limits.maxTurns} reached.` : undefined;
		if (!reason) return;
		ctx.abort();
		return { message: { ...event.message, stopReason: "aborted", errorMessage: reason } };
	});
}
