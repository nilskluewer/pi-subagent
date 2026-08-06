import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

export interface ParsedModelSelection {
	model: string;
	thinking?: SubagentThinkingLevel;
}

/** Normalized representation used by runtime model-policy checks. */
export interface SubagentModelAllowlistEntry {
	model: string;
	thinking: SubagentThinkingLevel;
}

export interface SubagentConfig {
	delegationPolicy?: string;
	resultCapTokens?: number;
	/** Exact provider/model-id, optionally suffixed with :thinking-level. */
	defaultModel?: string;
	/** Ordered exact provider/model-id:thinking-level specifications. */
	allowedModels?: SubagentModelAllowlistEntry[];
	maxDepth: number;
	maxLiveChildren: number;
	budgetAcquireTimeoutMs: number;
}

export interface SubagentDefaultsPatch {
	defaultModel?: string | null;
}

export interface ModelReferenceRegistry {
	find(provider: string, modelId: string): { provider: string; id: string } | undefined;
}

export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_MAX_LIVE_CHILDREN = 4;
export const DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS = 120000;

export const TREE_POLICY_ENV = {
	maxDepth: "PI_SUBAGENT_MAX_DEPTH",
	maxLiveChildren: "PI_SUBAGENT_MAX_LIVE_CHILDREN",
	budgetAcquireTimeoutMs: "PI_SUBAGENT_BUDGET_TIMEOUT_MS",
} as const;

export const OPERATIONAL_GUIDELINES = [
	"Give each subagent a concrete, self-contained task with relevant paths, constraints, and expected output.",
	"Use parallel tasks only when their work is independent and write scopes do not overlap; use sequential or chain execution when tasks depend on one another.",
	"Avoid duplicating work unless an independent second opinion is useful.",
];

const CONFIG_FILE_NAME = "subagent.json";
const DEFAULT_DELEGATION_POLICY = "proactive";

export function getSubagentConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILE_NAME);
}

export function isSubagentThinkingLevel(value: unknown): value is SubagentThinkingLevel {
	return typeof value === "string" && (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse provider/model-id[:thinking-level] without consulting the model registry.
 * The thinking suffix is optional for defaults and required for allowlist entries.
 */
export function parseModelSelection(reference: string): ParsedModelSelection | undefined {
	const trimmed = reference.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;

	let modelReference = trimmed;
	let thinking: SubagentThinkingLevel | undefined;
	const suffixSeparator = trimmed.lastIndexOf(":");
	if (suffixSeparator > separator) {
		const candidateThinking = trimmed.slice(suffixSeparator + 1);
		if (isSubagentThinkingLevel(candidateThinking)) {
			modelReference = trimmed.slice(0, suffixSeparator);
			thinking = candidateThinking;
		}
	}

	const modelSeparator = modelReference.indexOf("/");
	const provider = modelReference.slice(0, modelSeparator).trim();
	const modelId = modelReference.slice(modelSeparator + 1).trim();
	if (!provider || !modelId) return undefined;
	return { model: `${provider}/${modelId}`, thinking };
}

export function formatModelSelection(selection: ParsedModelSelection): string {
	return selection.thinking ? `${selection.model}:${selection.thinking}` : selection.model;
}

/**
 * Parse and resolve one exact provider/model-id[:thinking-level] reference.
 * An exact registry match is attempted before interpreting a trailing thinking
 * suffix, so custom model IDs containing colons remain usable.
 */
export function canonicalModelSelection(
	reference: string,
	registry: ModelReferenceRegistry,
): ParsedModelSelection | undefined {
	const trimmed = reference.trim();
	const exact = canonicalModelReference(trimmed, registry);
	if (exact) return { model: exact };

	const parsed = parseModelSelection(trimmed);
	if (!parsed) return undefined;
	const canonical = canonicalModelReference(parsed.model, registry);
	return canonical ? { model: canonical, thinking: parsed.thinking } : undefined;
}

/**
 * Parse an exact provider/model-id:thinking-level allowlist.
 * Invalid or empty values become an empty list so the runtime fails closed.
 */
function parseModelAllowlist(value: unknown): SubagentModelAllowlistEntry[] {
	if (!Array.isArray(value) || value.length === 0) return [];
	const entries: SubagentModelAllowlistEntry[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return [];
		const parsed = parseModelSelection(entry);
		if (!parsed?.thinking) return [];
		entries.push({ model: parsed.model, thinking: parsed.thinking });
	}
	return entries;
}

/** Parse a strict provider/model-id reference through Pi's exact registry. */
export function canonicalModelReference(reference: string, registry: ModelReferenceRegistry): string | undefined {
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) return undefined;
	const provider = reference.slice(0, separator).trim();
	const modelId = reference.slice(separator + 1).trim();
	if (!provider || !modelId) return undefined;
	const model = registry.find(provider, modelId);
	return model ? `${model.provider}/${model.id}` : undefined;
}

function defaults(): SubagentConfig {
	return {
		maxDepth: DEFAULT_MAX_DEPTH,
		maxLiveChildren: DEFAULT_MAX_LIVE_CHILDREN,
		budgetAcquireTimeoutMs: DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS,
	};
}

export function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function positiveIntegerString(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function treePolicyFromEnv(
	env: NodeJS.ProcessEnv,
	fallback: SubagentConfig,
): Pick<SubagentConfig, "maxDepth" | "maxLiveChildren" | "budgetAcquireTimeoutMs"> {
	return {
		maxDepth: positiveIntegerString(env[TREE_POLICY_ENV.maxDepth], fallback.maxDepth),
		maxLiveChildren: positiveIntegerString(env[TREE_POLICY_ENV.maxLiveChildren], fallback.maxLiveChildren),
		budgetAcquireTimeoutMs: positiveIntegerString(env[TREE_POLICY_ENV.budgetAcquireTimeoutMs], fallback.budgetAcquireTimeoutMs),
	};
}

export function loadSubagentConfig(): SubagentConfig {
	const parsed = defaults();
	try {
		const raw = JSON.parse(fs.readFileSync(getSubagentConfigPath(), "utf-8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return parsed;
		const config = raw as Record<string, unknown>;
		if (typeof config.delegationPolicy === "string") parsed.delegationPolicy = config.delegationPolicy;
		if (typeof config.resultCapTokens === "number" && Number.isFinite(config.resultCapTokens) && config.resultCapTokens >= 0) {
			parsed.resultCapTokens = config.resultCapTokens;
		}
		if (typeof config.defaultModel === "string" && config.defaultModel.trim()) parsed.defaultModel = config.defaultModel.trim();
		if (Object.prototype.hasOwnProperty.call(config, "allowedModels")) {
			parsed.allowedModels = parseModelAllowlist(config.allowedModels);
		}
		parsed.maxDepth = positiveInteger(config.maxDepth, DEFAULT_MAX_DEPTH);
		parsed.maxLiveChildren = positiveInteger(config.maxLiveChildren, DEFAULT_MAX_LIVE_CHILDREN);
		parsed.budgetAcquireTimeoutMs = positiveInteger(config.budgetAcquireTimeoutMs, DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS);
		return parsed;
	} catch {
		return parsed;
	}
}

export type UpdateSubagentConfigResult =
	| { ok: true; config: Record<string, unknown> }
	| { ok: false; error: string };

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

/** Update the command-controlled model default while preserving other JSON keys. */
export async function updateSubagentDefaults(patch: SubagentDefaultsPatch): Promise<UpdateSubagentConfigResult> {
	const configPath = getSubagentConfigPath();
	return withFileMutationQueue(configPath, async () => {
		let current: Record<string, unknown> = {};
		try {
			const raw = JSON.parse(await fs.promises.readFile(configPath, "utf-8")) as unknown;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				return { ok: false, error: `${configPath} must contain a JSON object; no changes were made.` };
			}
			current = raw as Record<string, unknown>;
		} catch (error) {
			if (!isMissingFile(error)) {
				return { ok: false, error: `Could not read ${configPath}; no changes were made.` };
			}
		}

		const next = { ...current };
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete next[key];
			else next[key] = value;
		}

		const agentDir = path.dirname(configPath);
		let tempDir: string | undefined;
		try {
			await fs.promises.mkdir(agentDir, { recursive: true, mode: 0o700 });
			tempDir = await fs.promises.mkdtemp(path.join(agentDir, ".subagent-config-"));
			const tempPath = path.join(tempDir, CONFIG_FILE_NAME);
			await fs.promises.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
			await fs.promises.chmod(tempPath, 0o600);
			await fs.promises.rename(tempPath, configPath);
			return { ok: true, config: next };
		} catch {
			return { ok: false, error: `Could not safely write ${configPath}; no changes were made.` };
		} finally {
			if (tempDir) {
				try {
					await fs.promises.rm(tempDir, { recursive: true, force: true });
				} catch {
					/* ignore cleanup failures after the atomic commit */
				}
			}
		}
	});
}

export function shouldRegisterSubagentTools(depth: number, maxDepth: number): boolean {
	return Number.isInteger(depth) && depth >= 0 && Number.isInteger(maxDepth) && maxDepth > 0 && depth < maxDepth;
}

export function buildDelegationPolicyLine(policy: string | undefined): string {
	if (policy === undefined || policy === DEFAULT_DELEGATION_POLICY || policy === "proactive") {
		return "Use subagents proactively when they can make useful independent progress; do not wait for an explicit delegation request.";
	}
	if (policy === "explicit-request-only") {
		return "Use subagents only when the user or an active skill explicitly requests delegation.";
	}
	return policy;
}
