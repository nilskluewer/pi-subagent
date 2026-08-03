import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

export interface SubagentConfig {
	delegationPolicy?: string;
	resultCapTokens?: number;
	defaultModel?: string;
	defaultThinkingLevel?: SubagentThinkingLevel;
	maxDepth: number;
	maxLiveChildren: number;
	budgetAcquireTimeoutMs: number;
}

export interface SubagentDefaultsPatch {
	defaultModel?: string | null;
	defaultThinkingLevel?: SubagentThinkingLevel | null;
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
	"Give `subagent` tasks that are concrete, self-contained, and answerable without further back-and-forth; vague tasks produce vague results you cannot use.",
	"Do not delegate to `subagent` when your very next step depends on the result and nothing else can proceed in the meantime; call it only when you can either wait productively or the result is not immediately blocking.",
	"Do not use `subagent` to redo work you can already see the result of in your own context; avoid handing an agent a task whose output you will just re-derive yourself.",
	"When delegating file-editing work to more than one `subagent` task in parallel, give each task a disjoint set of files or directories to write; two parallel agents editing the same file will race and silently lose changes.",
];

const CONFIG_FILE_NAME = "subagent.json";
const DEFAULT_DELEGATION_POLICY = "explicit-request-only";

export function getSubagentConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILE_NAME);
}

export function isSubagentThinkingLevel(value: unknown): value is SubagentThinkingLevel {
	return typeof value === "string" && (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse a strict provider/model-id reference and resolve it through Pi's registry.
 * The registry lookup deliberately uses find() rather than fuzzy matching so a
 * value written to subagent.json always names one exact current model.
 */
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

export function treePolicyFromEnv(env: NodeJS.ProcessEnv, fallback: SubagentConfig): Pick<SubagentConfig, "maxDepth" | "maxLiveChildren" | "budgetAcquireTimeoutMs"> {
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
		if (isSubagentThinkingLevel(config.defaultThinkingLevel)) parsed.defaultThinkingLevel = config.defaultThinkingLevel;
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

/**
 * Update only the command-controlled defaults while preserving every other JSON
 * key. Invalid existing JSON is never replaced.
 */
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
			// Prepare the complete restricted file before rename. Rename is the
			// commit point, so no fallible destination operation follows it.
			await fs.promises.chmod(tempPath, 0o600);
			await fs.promises.rename(tempPath, configPath);
			return { ok: true, config: next };
		} catch {
			return { ok: false, error: `Could not safely write ${configPath}; no changes were made.` };
		} finally {
			// Cleanup is best effort. In particular, a cleanup failure after rename
			// must not turn a committed update into a reported write failure.
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
	if (policy === undefined || policy === DEFAULT_DELEGATION_POLICY) {
		return "Only use `subagent` when the user (or an active skill) explicitly asks for delegation, a parallel review/council, or a named agent by name. Requests for depth, thoroughness, more research, or a more detailed analysis do not, by themselves, count as permission to spawn a subagent; do the work yourself unless delegation is explicitly requested.";
	}
	if (policy === "proactive") {
		return "You may delegate proactively when a subtask is self-contained, well-specified, and can run without your involvement (for example: an isolated code review, a parallel search across independent areas, or a long-running chore); do not delegate when the result blocks your very next step.";
	}
	return policy;
}
