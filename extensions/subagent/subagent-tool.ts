/**
 * Subagent Tool - Delegate work to specialized agents
 *
 * Adapted from the official pi subagent example. Spawns a separate `pi`
 * process for each subagent invocation, giving it an isolated context window.
 *
 * Each invocation delegates one task. Emit several subagent calls in the same
 * assistant turn for independent parallel work, or call again with the previous
 * result when work depends on an earlier task.
 *
 * Agent personas come from named definitions (~/.pi/agent/agents/*.md,
 * .pi/agents/*.md) or inline via systemPrompt/model/tools in the tool call.
 *
 * Every run is a persistent pi session under ~/.pi/agent/subagent-sessions/;
 * the returned session id can be passed as `resume` to continue that agent
 * with its full context (e.g. "here is the implemented fix - verify it").
 *
 * Subagents run with PI_SUBAGENT_COORDINATOR_SOCKET set so dangerous tool calls
 * are proxied to the parent TUI for approval and child processes share a
 * root-scoped live-child budget. A live widget shows direct per-agent status,
 * current tool, token usage, and a compact nested-count fallback.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Message, StringEnum, Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { acquireChildSlot, sendStatusCount } from "./agent-budget.ts";
import { type AbortActivityItem, formatAbortedRecovery } from "./abort-output.ts";
import {
	applyForkContext,
	buildForkSourceMessages,
	forkContextMeta,
	parseForkContext,
} from "./context-fork.ts";
import type { ForkContext } from "./context-fork.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	canonicalModelReference,
	canonicalModelSelection,
	formatModelSelection,
	DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS,
	DEFAULT_MAX_DEPTH,
	DEFAULT_MAX_LIVE_CHILDREN,
	OPERATIONAL_GUIDELINES,
	TREE_POLICY_ENV,
	buildDelegationPolicyLine,
	isSubagentThinkingLevel,
	loadSubagentConfig,
	type ModelReferenceRegistry,
	type SubagentConfig,
	type SubagentModelAllowlistEntry,
	treePolicyFromEnv,
} from "./config.ts";
import { inheritedToolsEnv } from "./inherited-tools.ts";
import { capText, formatEnvelope, resolveResultCap } from "./result-cap.ts";
import {
	DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS,
	getBackgroundRun,
	listBackgroundRuns,
	markBackgroundRunCollected,
	registerBackgroundRun,
	waitForAllBackgroundRuns,
	waitForBackgroundRun,
	waitForFirstBackgroundRun,
} from "./background-runs.ts";
import { type ApprovalServer, startApprovalServer } from "./approval-server.ts";
import { displayModel, modelTag } from "./terminal-display.ts";
import { writeOutputArtifact } from "./output-artifact.ts";

const COLLAPSED_ITEM_COUNT = 10;
// Use one widget id per tool call so concurrent execute() calls cannot clear each other's rows.
const WIDGET_ID_PREFIX = "subagent";

export function getSessionsDir(): string {
	return path.join(getAgentDir(), "subagent-sessions");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "subagent": {
			const label = (args.agent || args.name || (args.resume ? `resume:${String(args.resume).slice(0, 8)}` : "inline")) as string;
			return themeFg("muted", "subagent ") + themeFg("accent", label);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

const plainFg = (_color: any, text: string) => text;

function resultSettingsTag(result: Pick<SingleResult, "model" | "thinking">): string {
	if (!result.model) return "default";
	if (result.thinking && !result.model.endsWith(`:${result.thinking}`)) return `${result.model}:${result.thinking}`;
	return result.model;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type AgentSource = "user" | "project" | "inline" | "resume" | "unknown";

export interface SingleResult {
	agent: string;
	agentSource: AgentSource;
	task: string;
	sessionId?: string;
	sessionFile?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	outputFile?: string;
	terminationSignal?: NodeJS.Signals;
	forkWarning?: string;
	forkedFrom?: string;
	parent?: string;
	rootId?: string;
}

export interface SubagentDetails {
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** A fully resolved agent to spawn: from a named definition, inline params, or a resumed session. */
export interface AgentSpec {
	name: string;
	systemPrompt: string;
	model?: string;
	tools?: string[];
	thinking?: string;
	source: AgentSource;
	sessionId: string;
	sessionFile: string;
	isResume: boolean;
	forkContext: ForkContext;
	forkWarning?: string;
	forkedFrom?: string;
	parent?: string;
	rootId?: string;
	cwd?: string;
}

interface SessionMeta {
	name: string;
	systemPrompt: string;
	model?: string;
	tools?: string[];
	thinking?: string;
	cwd?: string;
	createdAt: string;
	forkedFrom?: string;
	forkContext?: "none" | "all" | number;
	parent?: string;
	rootId?: string;
}

export interface SubagentResolutionDefaults {
	defaultModel?: string;
	allowedModels?: SubagentModelAllowlistEntry[];
	allowedModelsError?: string;
	defaultModelError?: string;
}

export function resolveSubagentDefaults(
	config: Pick<SubagentConfig, "defaultModel" | "allowedModels">,
	registry: ModelReferenceRegistry,
): SubagentResolutionDefaults {
	const resolved: SubagentResolutionDefaults = {};
	if (config.allowedModels !== undefined) {
		if (config.allowedModels.length === 0) {
			resolved.allowedModelsError =
				"Invalid subagent model allowlist: allowedModels must contain at least one valid provider/model-id:thinking entry. Allowed models: none.";
		} else {
			const entries: SubagentModelAllowlistEntry[] = [];
			for (const entry of config.allowedModels) {
				const model = canonicalModelReference(entry.model, registry);
				if (!model) {
					resolved.allowedModelsError = `Unknown model in subagent allowlist: "${entry.model}". Allowed models: ${formatAllowedModelPairs(config.allowedModels)}.`;
					break;
				}
				if (!entries.some((existing) => existing.model === model && existing.thinking === entry.thinking)) {
					entries.push({ model, thinking: entry.thinking });
				}
			}
			if (!resolved.allowedModelsError) resolved.allowedModels = entries;
		}
	}

	if (config.allowedModels === undefined && config.defaultModel) {
		const selection = canonicalModelSelection(config.defaultModel, registry);
		if (selection) resolved.defaultModel = formatModelSelection(selection);
		else resolved.defaultModelError = `Unknown subagent default model "${config.defaultModel}".`;
	}

	return resolved;
}

interface SubagentInput {
	agent?: string;
	systemPrompt?: string;
	name?: string;
	model?: string;
	tools?: string;
	resume?: string;
	forkContext?: string;
	resultCapTokens?: number;
	async?: boolean;
	task: string;
	cwd?: string;
}

function parseToolsList(tools: string | undefined): string[] | undefined {
	const parsed = tools
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return parsed && parsed.length > 0 ? parsed : undefined;
}

function formatAllowedModelPairs(allowedModels: readonly SubagentModelAllowlistEntry[]): string {
	return allowedModels.map((entry) => `${entry.model}:${entry.thinking}`).join(", ");
}

function modelField(allowedModels: readonly SubagentModelAllowlistEntry[] | undefined) {
	const values = allowedModels
		? [...new Set(allowedModels.map((entry) => `${entry.model}:${entry.thinking}`))]
		: [];
	const description = values.length > 0
		? `Exact provider/model-id:thinking-level. It must be one of: ${values.join(", ")}. Omit to inherit the configured or child-process default.`
		: "Exact provider/model-id[:thinking-level]. Omit to inherit the configured or child-process default.";
	if (values.length === 0) return Type.Optional(Type.String({ description }));
	return Type.Optional(StringEnum(values as [string, ...string[]], { description }));
}

export function enforceModelAllowlist(
	spec: AgentSpec,
	allowedModels: readonly SubagentModelAllowlistEntry[] | undefined,
	registry?: ModelReferenceRegistry,
): { spec: AgentSpec } | { error: string } {
	let selection = spec.model && registry ? canonicalModelSelection(spec.model, registry) : undefined;
	if (spec.model && !selection) {
		const allowed = allowedModels && allowedModels.length > 0
			? ` Allowed models: ${formatAllowedModelPairs(allowedModels)}.`
			: "";
		return { error: `Unknown subagent model "${spec.model}". Use an exact provider/model-id[:thinking].${allowed}` };
	}
	if (selection && !selection.thinking && isSubagentThinkingLevel(spec.thinking)) {
		selection = { ...selection, thinking: spec.thinking };
	}

	if (allowedModels === undefined) {
		return {
			spec: {
				...spec,
				model: selection ? formatModelSelection(selection) : spec.model,
				thinking: selection?.thinking,
			},
		};
	}
	if (allowedModels.length === 0) {
		return { error: "Subagent model allowlist is configured but contains no valid entries." };
	}

	let selected: SubagentModelAllowlistEntry | undefined;
	if (selection) {
		selected = allowedModels.find(
			(entry) => entry.model === selection?.model && (!selection.thinking || entry.thinking === selection.thinking),
		);
	} else if (isSubagentThinkingLevel(spec.thinking)) {
		selected = allowedModels.find((entry) => entry.thinking === spec.thinking);
	} else {
		selected = allowedModels[0];
	}

	if (!selected) {
		const requested = spec.model ?? "(default model)";
		return {
			error: `Subagent "${spec.name}" requested disallowed model ${requested}. Allowed models: ${formatAllowedModelPairs(allowedModels)}.`,
		};
	}
	if (selection && selection.thinking && selected.thinking !== selection.thinking) {
		return {
			error: `Subagent "${spec.name}" requested disallowed model ${formatModelSelection(selection)}. Allowed models: ${formatAllowedModelPairs(allowedModels)}.`,
		};
	}

	return {
		spec: {
			...spec,
			model: formatModelSelection({ model: selected.model, thinking: selected.thinking }),
			thinking: selected.thinking,
		},
	};
}

const SESSION_ID_PATTERN = /^[\w.-]+$/;

type ResolvedAgentSource =
	| { kind: "resume"; sessionId: string; sessionFile: string }
	| { kind: "agent"; agent: AgentConfig }
	| { kind: "inline" };

/**
 * Choose the one agent source of a call that may also carry placeholder values.
 * Precedence is resume > named agent > inline, and a field only counts when it
 * can actually resolve: a session must exist on disk and an agent name must be
 * known. Everything else falls through to the next source, so a model that fills
 * every schema property still gets the run it asked for.
 */
export function selectAgentSource(
	item: Pick<SubagentInput, "agent" | "systemPrompt" | "resume">,
	agents: AgentConfig[],
	sessionsDir: string,
): { source: ResolvedAgentSource } | { error: string } {
	const resume = item.resume?.trim();
	const sessionFile = resume && SESSION_ID_PATTERN.test(resume) ? path.join(sessionsDir, `${resume}.jsonl`) : undefined;
	if (resume && sessionFile && fs.existsSync(sessionFile)) {
		return { source: { kind: "resume", sessionId: resume, sessionFile } };
	}

	const agentName = item.agent?.trim();
	const agent = agentName ? agents.find((a) => a.name === agentName) : undefined;
	if (agent) return { source: { kind: "agent", agent } };

	if (item.systemPrompt?.trim()) return { source: { kind: "inline" } };
	if (resume) return { error: `Unknown subagent session "${resume}" (no transcript in ${sessionsDir}).` };
	if (agentName) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return { error: `Unknown agent: "${agentName}". Available agents: ${available}.` };
	}
	return { error: 'Provide one of "agent" (named), "systemPrompt" (inline), or "resume" (session id).' };
}

export function resolveSpec(
	item: SubagentInput,
	agents: AgentConfig[],
	index: number,
	defaults: SubagentResolutionDefaults = {},
	registry?: ModelReferenceRegistry,
): { spec: AgentSpec } | { error: string } {
	const forkContext = parseForkContext(item.forkContext);
	if ("error" in forkContext) return { error: forkContext.error };
	const sessionsDir = getSessionsDir();
	const selected = selectAgentSource(item, agents, sessionsDir);
	if ("error" in selected) return { error: selected.error };
	if (defaults.defaultModelError) return { error: defaults.defaultModelError };
	if (defaults.allowedModelsError) return { error: defaults.allowedModelsError };

	const finalize = (spec: AgentSpec): { spec: AgentSpec } | { error: string } =>
		enforceModelAllowlist(spec, defaults.allowedModels, registry);
	const defaultsAreOverridden = defaults.allowedModels !== undefined;
	const defaultModel = defaultsAreOverridden ? undefined : defaults.defaultModel;

	if (selected.source.kind === "resume") {
		const { sessionId, sessionFile } = selected.source;
		const metaFile = path.join(sessionsDir, `${sessionId}.meta.json`);
		let meta: SessionMeta;
		try {
			meta = JSON.parse(fs.readFileSync(metaFile, "utf-8")) as SessionMeta;
		} catch {
			return { error: `Unknown subagent session "${sessionId}" (no metadata at ${metaFile}).` };
		}
		return finalize({
			name: meta.name,
			systemPrompt: meta.systemPrompt ?? "",
			// A resumed Pi session restores its effective model and thinking level
			// from the child JSONL. Do not inject current subagent defaults when
			// older metadata omits either field, because --model/--thinking would
			// override Pi's session restoration. Explicit resume-call overrides and
			// recorded metadata remain authoritative. An active model allowlist is
			// applied afterward and supplies its first matching fallback if metadata
			// is incomplete.
			model: item.model ?? meta.model,
			tools: parseToolsList(item.tools) ?? meta.tools,
			thinking: meta.thinking,
			source: "resume",
			sessionId,
			sessionFile,
			isResume: true,
			// A resumed session restores its own history, so a fork request cannot
			// apply and is ignored rather than rejected.
			forkContext: { mode: "none" },
			parent: meta.parent,
			rootId: meta.rootId,
		});
	}

	const sessionId = crypto.randomUUID();
	const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

	if (selected.source.kind === "agent") {
		const agent = selected.source.agent;
		return finalize({
			name: agent.name,
			systemPrompt: agent.systemPrompt,
			model: item.model ?? agent.model ?? defaultModel,
			tools: parseToolsList(item.tools) ?? agent.tools,
			source: agent.source,
			sessionId,
			sessionFile,
			isResume: false,
			forkContext,
		});
	}

	return finalize({
		name: item.name?.trim() || `agent-${index + 1}`,
		systemPrompt: item.systemPrompt ?? "",
		model: item.model ?? defaultModel,
		tools: parseToolsList(item.tools),
		source: "inline",
		sessionId,
		sessionFile,
		isResume: false,
		forkContext,
	});
}

export function writeSessionMeta(spec: AgentSpec, cwd: string): void {
	const sessionsDir = getSessionsDir();
	fs.mkdirSync(sessionsDir, { recursive: true });
	const parent = process.env.PI_SUBAGENT_SESSION_ID;
	const rootId = process.env.PI_SUBAGENT_ROOT_ID ?? spec.sessionId;
	spec.parent = parent;
	spec.rootId = rootId;
	const meta: SessionMeta = {
		name: spec.name,
		systemPrompt: spec.systemPrompt,
		model: spec.model,
		tools: spec.tools,
		thinking: spec.thinking,
		cwd,
		createdAt: new Date().toISOString(),
		forkedFrom: spec.forkedFrom,
		forkContext: spec.forkContext.mode === "none" ? undefined : forkContextMeta(spec.forkContext),
		parent,
		rootId,
	};
	fs.writeFileSync(path.join(sessionsDir, `${spec.sessionId}.meta.json`), JSON.stringify(meta, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = msg.content.reduce(
			(output, part) => part.type === "text" ? output + part.text : output,
			"",
		);
		if (text) return text;
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	if (result.stopReason === "aborted") return formatAbortedResult(result);
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function prependForkWarning(result: SingleResult, output: string): string {
	return result.forkWarning ? `[warning] ${result.forkWarning}\n\n${output}` : output;
}

export function buildResultPayload(result: SingleResult): string {
	if (result.stopReason === "aborted") return prependForkWarning(result, formatAbortedResult(result));
	if (isFailedResult(result)) {
		return prependForkWarning(result, `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`);
	}
	return prependForkWarning(result, getFinalOutput(result.messages) || "(no output)");
}

export function assembleSingleResultText(result: SingleResult, cap: number): string {
	const payload = buildResultPayload(result);
	if (result.stopReason === "aborted") return payload;
	return formatEnvelope(result, capText(payload, cap), { maxTokens: cap });
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

export function formatAbortedResult(result: SingleResult): string {
	const activity: AbortActivityItem[] = getDisplayItems(result.messages).map((item) => ({
		kind: item.type === "text" ? "Message" : "Tool call",
		content: item.type === "text" ? item.text : formatToolCall(item.name, item.args, plainFg),
	}));
	return formatAbortedRecovery(result.agent, result.sessionId, activity, { parent: result.parent });
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function cleanupTempPrompt(filePath: string | null, dir: string | null): void {
	if (filePath)
		try {
			fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	if (dir)
		try {
			fs.rmdirSync(dir);
		} catch {
			/* ignore */
		}
}

export function buildPiArguments(
	spec: Pick<AgentSpec, "sessionFile" | "model" | "tools" | "thinking">,
	taskPromptPath: string,
	systemPromptPath?: string,
): string[] {
	const args: string[] = ["--mode", "json", "-p", "--session", spec.sessionFile];
	const model = spec.model && spec.thinking && spec.model.endsWith(`:${spec.thinking}`)
		? spec.model.slice(0, -(spec.thinking.length + 1))
		: spec.model;
	if (model) args.push("--model", model);
	if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
	if (spec.thinking) args.push("--thinking", spec.thinking);
	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);

	// Keep arbitrary task text out of argv. Endpoint security tooling on macOS scans
	// command-line arguments as paths and can terminate the child when the task is
	// long enough to look like an invalid filename. Pi expands @file arguments into
	// the initial user message.
	args.push(`@${taskPromptPath}`);
	return args;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export interface WidgetTracker {
	add(key: string, name: string, model?: string): void;
	setModel(key: string, model: string): void;
	setTool(key: string, tool: string | undefined): void;
	setUsage(key: string, usage: UsageStats): void;
	setNestedCount(key: string, nestedCount: number): void;
	finish(key: string, ok: boolean): void;
	clear(): void;
}

export function createWidgetTracker(
	ctx: { hasUI: boolean; ui: { setWidget(id: string, lines?: string[]): void } },
	widgetId = WIDGET_ID_PREFIX,
	nestedReporter?: (nestedCount: number) => void,
): WidgetTracker {
	interface Row {
		name: string;
		model: string;
		status: "running" | "done" | "failed";
		currentTool?: string;
		usage: UsageStats;
		nestedCount: number;
	}
	const rows = new Map<string, Row>();

	const render = () => {
		if (!ctx.hasUI) return;
		const lines = [...rows.values()].map((row) => {
			const icon = row.status === "running" ? "⏳" : row.status === "done" ? "✓" : "✗";
			const tool = row.currentTool ? ` · ${row.currentTool}` : "";
			const usage = ` · ↑${formatTokens(row.usage.input)} ↓${formatTokens(row.usage.output)} · ${row.usage.turns}t`;
			const nested = row.nestedCount > 0 ? ` · +${row.nestedCount} nested` : "";
			return ` ${icon} ${row.name} ${modelTag(row.model)}${tool}${usage}${nested}`;
		});
		ctx.ui.setWidget(widgetId, lines.length > 0 ? ["Subagents", ...lines] : undefined);
	};

	const emptyUsage = (): UsageStats => ({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	});

	return {
		add(key, name, model) {
			rows.set(key, { name, model: displayModel(model), status: "running", usage: emptyUsage(), nestedCount: 0 });
			nestedReporter?.([...rows.values()].filter((row) => row.status === "running").length);
			render();
		},
		setModel(key, model) {
			const row = rows.get(key);
			if (!row) return;
			row.model = model;
			render();
		},
		setTool(key, tool) {
			const row = rows.get(key);
			if (!row) return;
			row.currentTool = tool;
			render();
		},
		setUsage(key, usage) {
			const row = rows.get(key);
			if (!row) return;
			row.usage = usage;
			render();
		},
		setNestedCount(key, nestedCount) {
			const row = rows.get(key);
			if (!row) return;
			row.nestedCount = Math.max(0, nestedCount);
			render();
		},
		finish(key, ok) {
			const row = rows.get(key);
			if (!row) return;
			row.status = ok ? "done" : "failed";
			row.currentTool = undefined;
			nestedReporter?.([...rows.values()].filter((item) => item.status === "running").length);
			render();
		},
		clear() {
			rows.clear();
			nestedReporter?.(0);
			if (ctx.hasUI) ctx.ui.setWidget(widgetId, undefined);
		},
	};
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function errorResult(
	name: string,
	task: string,
	message: string,
	metadata: Pick<SingleResult, "sessionId" | "sessionFile" | "model" | "thinking"> = {},
): SingleResult {
	return {
		agent: name,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		stopReason: "error",
		errorMessage: message,
		...metadata,
	};
}

export type KillStrategy = "process-group" | "direct" | "windows-taskkill";

export function shouldDetachChild(platform: NodeJS.Platform, currentDepth: number): boolean {
	return platform !== "win32" && currentDepth === 0;
}

export function selectKillStrategy(platform: NodeJS.Platform, detached: boolean): KillStrategy {
	if (platform === "win32") return "windows-taskkill";
	return detached ? "process-group" : "direct";
}

function isEsrch(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ESRCH";
}

function killChild(proc: ChildProcess, signalName: NodeJS.Signals, strategy: KillStrategy): void {
	if (!proc.pid) return;
	if (strategy === "windows-taskkill") {
		try {
			spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" });
		} catch (error) {
			if (isEsrch(error)) return;
			try {
				proc.kill(signalName);
			} catch {
				/* ignore best-effort fallback failure */
			}
		}
		return;
	}
	try {
		if (strategy === "process-group") process.kill(-proc.pid, signalName);
		else proc.kill(signalName);
	} catch (error) {
		if (isEsrch(error)) return;
		if (strategy === "process-group") {
			try {
				proc.kill(signalName);
			} catch {
				/* ignore best-effort fallback failure */
			}
		}
	}
}

export interface AbortKillController {
	abort(): void;
	onClose(): void;
	wasAborted(): boolean;
}

export function createAbortKillController(
	signal: AbortSignal | undefined,
	kill: (signalName: NodeJS.Signals) => void,
	setTimer: (callback: () => void, ms: number) => NodeJS.Timeout = setTimeout,
	clearTimer: (timer: NodeJS.Timeout) => void = clearTimeout,
): AbortKillController {
	let exited = false;
	let aborted = false;
	let escalationTimer: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;

	const abort = () => {
		if (exited) return;
		aborted = true;
		kill("SIGTERM");
		if (escalationTimer) clearTimer(escalationTimer);
		escalationTimer = setTimer(() => {
			if (!exited) kill("SIGKILL");
		}, 5000);
	};

	if (signal) {
		if (signal.aborted) abort();
		else {
			abortListener = abort;
			signal.addEventListener("abort", abortListener, { once: true });
		}
	}

	return {
		abort,
		onClose() {
			exited = true;
			if (abortListener && signal) signal.removeEventListener("abort", abortListener);
			if (escalationTimer) {
				clearTimer(escalationTimer);
				escalationTimer = undefined;
			}
		},
		wasAborted() {
			return aborted;
		},
	};
}

export interface ChildTermination {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export interface ChildTerminationOutcome {
	exitCode: number;
	stopReason?: "error" | "aborted";
	errorMessage?: string;
	terminationSignal?: NodeJS.Signals;
}

export function classifyChildTermination(
	termination: ChildTermination,
	wasAborted: boolean,
): ChildTerminationOutcome {
	if (wasAborted) {
		return { exitCode: termination.code || 1, stopReason: "aborted" };
	}
	if (termination.signal) {
		return {
			exitCode: termination.code ?? 1,
			stopReason: "error",
			errorMessage: `Child process terminated by signal ${termination.signal}.`,
			terminationSignal: termination.signal,
		};
	}
	if (termination.code === null) {
		return {
			exitCode: 1,
			stopReason: "error",
			errorMessage: "Child process ended without an exit code or signal.",
		};
	}
	return { exitCode: termination.code };
}

export interface SlotDenialOutcome {
	stopReason: "error" | "aborted";
	message: string;
}

export function classifySlotDenial(reason: string, maxLiveChildren: number): SlotDenialOutcome {
	if (reason === "aborted") {
		return {
			stopReason: "aborted",
			message: "Subagent aborted before a child slot was acquired.",
		};
	}
	if (reason === "budget exhausted") {
		return {
			stopReason: "error",
			message: `Root agent budget exhausted (max ${maxLiveChildren} live subagents); try again once a sibling finishes, or raise maxLiveChildren in ~/.pi/agent/subagent.json`,
		};
	}
	return {
		stopReason: "error",
		message: `Could not acquire a subagent slot: ${reason}.`,
	};
}

export async function runSingleAgent(
	defaultCwd: string,
	spec: AgentSpec,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	coordinatorSocketPath: string | undefined,
	budgetAcquireTimeoutMs: number,
	maxLiveChildren: number,
	maxDepth: number,
	currentDepth: number,
	widget: WidgetTracker,
): Promise<SingleResult> {
	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let taskPromptDir: string | null = null;
	let taskPromptPath: string | null = null;
	let releaseSlot: (() => void) | undefined;

	const currentResult: SingleResult = {
		agent: spec.name,
		agentSource: spec.source,
		task,
		sessionId: spec.sessionId,
		sessionFile: spec.sessionFile,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: spec.model,
		thinking: spec.thinking,
		forkWarning: spec.forkWarning,
		forkedFrom: spec.forkedFrom,
		parent: spec.parent,
		rootId: spec.rootId,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (coordinatorSocketPath) {
			const slot = await acquireChildSlot(coordinatorSocketPath, spec.name, budgetAcquireTimeoutMs, signal);
			if (!slot.granted) {
				const denial = classifySlotDenial(slot.reason, maxLiveChildren);
				currentResult.exitCode = 1;
				currentResult.stopReason = denial.stopReason;
				currentResult.errorMessage = denial.message;
				currentResult.stderr = denial.message;
				return currentResult;
			}
			releaseSlot = slot.release;
		}

		widget.add(spec.sessionId, spec.name, spec.model);

		if (!spec.isResume) {
			writeSessionMeta(spec, cwd ?? defaultCwd);
			currentResult.parent = spec.parent;
			currentResult.rootId = spec.rootId;
		}
		if (spec.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(spec.name, spec.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}
		const taskPrompt = await writePromptToTempFile(spec.name, `Task: ${task}`);
		taskPromptDir = taskPrompt.dir;
		taskPromptPath = taskPrompt.filePath;
		const args = buildPiArguments(spec, taskPrompt.filePath, tmpPromptPath ?? undefined);
		let abortController: AbortKillController | undefined;

		const termination = await new Promise<ChildTermination>((resolve) => {
			const invocation = getPiInvocation(args);
			const detached = shouldDetachChild(process.platform, currentDepth);
			const killStrategy = selectKillStrategy(process.platform, detached);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SUBAGENT: "1",
					PI_SUBAGENT_NAME: spec.name,
					PI_SUBAGENT_DEPTH: String(currentDepth + 1),
					PI_SUBAGENT_SESSION_ID: spec.sessionId,
					PI_SUBAGENT_ROOT_ID: process.env.PI_SUBAGENT_ROOT_ID ?? spec.sessionId,
					[TREE_POLICY_ENV.maxDepth]: String(maxDepth),
					[TREE_POLICY_ENV.maxLiveChildren]: String(maxLiveChildren),
					[TREE_POLICY_ENV.budgetAcquireTimeoutMs]: String(budgetAcquireTimeoutMs),
					...inheritedToolsEnv(spec.tools),
					...(coordinatorSocketPath ? { PI_SUBAGENT_COORDINATOR_SOCKET: coordinatorSocketPath } : {}),
				},
				detached,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "tool_execution_start") {
					widget.setTool(
						spec.sessionId,
						formatToolCall(event.toolName ?? "tool", event.args ?? {}, plainFg),
					);
				}
				if (event.type === "tool_execution_end") {
					widget.setTool(spec.sessionId, undefined);
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (currentResult.model) widget.setModel(spec.sessionId, currentResult.model);
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						widget.setUsage(spec.sessionId, currentResult.usage);
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code, signal) => {
				abortController?.onClose();
				if (buffer.trim()) processLine(buffer);
				resolve({ code, signal });
			});

			proc.on("error", (error) => {
				abortController?.onClose();
				currentResult.stderr += `Child process error: ${error.message}\n`;
				resolve({ code: 1, signal: null });
			});

			abortController = createAbortKillController(signal, (signalName) => killChild(proc, signalName, killStrategy));
		});

		const outcome = classifyChildTermination(termination, abortController?.wasAborted() ?? false);
		currentResult.exitCode = outcome.exitCode;
		if (outcome.stopReason) currentResult.stopReason = outcome.stopReason;
		if (outcome.errorMessage) currentResult.errorMessage = outcome.errorMessage;
		if (outcome.terminationSignal) currentResult.terminationSignal = outcome.terminationSignal;
		widget.finish(spec.sessionId, !isFailedResult(currentResult));
		return currentResult;
	} catch (error) {
		widget.finish(spec.sessionId, false);
		throw error;
	} finally {
		try {
			if (currentResult.sessionId) {
				const outputFile = await writeOutputArtifact(
					getSessionsDir(),
					currentResult.sessionId,
					buildResultPayload(currentResult),
				);
				if (outputFile) currentResult.outputFile = outputFile;
			}
		} catch {
			/* Artifact persistence is best effort and must never change the run outcome. */
		}
		cleanupTempPrompt(taskPromptPath, taskPromptDir);
		cleanupTempPrompt(tmpPromptPath, tmpPromptDir);
		releaseSlot?.();
	}
}

// Never constrain these optional fields with minLength/minItems. Models that
// fill every schema property emit "" or [] for unused fields, which the runtime
// drops as absent; a minimum constraint makes them invent non-empty junk such as
// resume: " ", which then collides with the intended agent source.
const agentSelectionFields = {
	agent: Type.Optional(Type.String({ description: "Named user or project agent (exactly one of agent | systemPrompt | resume)." })),
	systemPrompt: Type.Optional(Type.String({ description: "Inline persona for an ad-hoc agent (exactly one of agent | systemPrompt | resume)." })),
	name: Type.Optional(Type.String({ description: "Optional display label for a new inline agent." })),
	model: Type.Optional(Type.String({ description: "Exact provider/model-id[:thinking-level]. Omit to inherit the configured or child-process default." })),
	tools: Type.Optional(Type.String({ description: "Comma-separated tools the child may use. Omit to inherit the caller's active tools." })),
	resume: Type.Optional(Type.String({ description: "Existing subagent session ID to continue with its history (exactly one of agent | systemPrompt | resume)." })),
	forkContext: Type.Optional(
		Type.String({ description: 'Context to copy into a new agent: "none", "all", or a positive number of recent turns. Cannot be combined with resume.' }),
	),
	resultCapTokens: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Approximate token limit for the result returned to the caller. Use 0 for the full result.",
		}),
	),
};

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to search: "user" (default), "project", or "both".',
	default: "user",
});

function buildSubagentParams(allowedModels: readonly SubagentModelAllowlistEntry[] | undefined) {
	return Type.Object({
		...agentSelectionFields,
		model: modelField(allowedModels),
		async: Type.Optional(
			Type.Boolean({
				description: "Start the subagent in the background and collect its result later with subagent_wait.",
			}),
		),
		task: Type.String({ description: "Instruction for the selected agent." }),
		agentScope: Type.Optional(AgentScopeSchema),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process." })),
	});
}

/**
 * Drop placeholder values before resolving the task. Models that fill every schema
 * property emit "", " ", or [] for fields they do not intend to use, and a
 * literal empty value must never register as an agent source.
 */
export function sanitizeToolParams<T>(params: T): T {
	if (Array.isArray(params)) {
		return params.filter((item) => item !== null && item !== undefined).map((item) => sanitizeToolParams(item)) as T;
	}
	if (typeof params !== "object" || params === null) return params;
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
		if (value === null || value === undefined) continue;
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed) clean[key] = trimmed;
			continue;
		}
		if (Array.isArray(value)) {
			const items = sanitizeToolParams(value) as unknown[];
			if (items.length > 0) clean[key] = items;
			continue;
		}
		clean[key] = typeof value === "object" ? sanitizeToolParams(value) : value;
	}
	return clean as T;
}

function displayName(item: { agent?: string; name?: string; resume?: string }): string {
	if (item.agent) return item.agent;
	if (item.name) return item.name;
	if (item.resume) return `resume:${item.resume.slice(0, 8)}`;
	return "inline";
}

function forkTag(item: { forkContext?: string } | undefined): string | undefined {
	const parsed = parseForkContext(item?.forkContext);
	if ("error" in parsed || parsed.mode === "none") return undefined;
	return parsed.mode === "turns" ? String(parsed.n) : parsed.mode;
}

function formatBackgroundRuns(runs: ReturnType<typeof listBackgroundRuns>): string {
	if (runs.length === 0) return "none";
	return runs
		.map((run) => `${run.agent} (${run.sessionId}): ${run.status}`)
		.join(", ");
}

function backgroundDetails(results: SingleResult[]): SubagentDetails {
	return { agentScope: "user", projectAgentsDir: null, results };
}

export function waitResultText(
	wait: Awaited<ReturnType<typeof waitForFirstBackgroundRun>>,
	fallbackCap: number,
	timeoutMs: number,
): string {
	const envelopes = wait.settled
		.map((run) => (run.result ? assembleSingleResultText(run.result, run.resultCapTokens ?? fallbackCap) : ""))
		.filter(Boolean);
	const running = wait.running.length > 0
		? formatBackgroundRuns(wait.running)
		: "none";
	if (wait.aborted) {
		const abortNotice = `[aborted: wait cancelled. Still running: ${running}]`;
		return envelopes.length > 0 ? `${envelopes.join("\n\n---\n\n")}\n\n${abortNotice}` : abortNotice;
	}
	if (!wait.timedOut) return envelopes.join("\n\n---\n\n");

	const timeoutNotice = `[timeout: waited ${timeoutMs}ms. Still running: ${running}]`;
	return envelopes.length > 0 ? `${envelopes.join("\n\n---\n\n")}\n\n${timeoutNotice}` : timeoutNotice;
}

export function registerSubagentTool(pi: ExtensionAPI) {
	const registrationDepthRaw = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const registrationDepth = Number.isInteger(registrationDepthRaw) && registrationDepthRaw >= 0 ? registrationDepthRaw : 0;
	const defaultTreePolicy = {
		maxDepth: DEFAULT_MAX_DEPTH,
		maxLiveChildren: DEFAULT_MAX_LIVE_CHILDREN,
		budgetAcquireTimeoutMs: DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS,
	};
	const fileConfig = loadSubagentConfig();
	// Keep session-scoped policy here, but deliberately do not capture defaultModel.
	// It is command-controlled and is loaded inside execute() for every future call.
	const config = {
		delegationPolicy: fileConfig.delegationPolicy,
		resultCapTokens: fileConfig.resultCapTokens,
		maxDepth: fileConfig.maxDepth,
		maxLiveChildren: fileConfig.maxLiveChildren,
		budgetAcquireTimeoutMs: fileConfig.budgetAcquireTimeoutMs,
		...(registrationDepth > 0 ? treePolicyFromEnv(process.env, defaultTreePolicy) : {}),
	};

	// Register the collector first so simple registration stubs that retain only
	// the last definition still observe the primary subagent tool.
	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for Subagents",
		promptSnippet: "Collect results from subagent calls made with async: true.",
		description: [
			"Collect results from `subagent` calls made with `async: true`.",
			"Pass `id` to wait for one session, omit it to wait for the first run to finish, or set `all: true` to wait for every tracked run.",
			"A timeout reports still-running sessions without cancelling them.",
		].join(" "),
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Background subagent session id to collect." })),
			all: Type.Optional(Type.Boolean({ description: "Wait for every tracked background subagent run." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Maximum wait time in milliseconds. Defaults to 10 minutes." })),
		}),

		async execute(_toolCallId, rawParams, signal) {
			const params = sanitizeToolParams(rawParams ?? {});
			const timeoutMs = params.timeoutMs === undefined
				? DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS
				: Math.max(0, Number.isFinite(params.timeoutMs) ? Math.floor(params.timeoutMs) : DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS);
			let wait: Awaited<ReturnType<typeof waitForFirstBackgroundRun>>;
			if (params.id) wait = await waitForBackgroundRun(params.id, timeoutMs, signal);
			else if (params.all) wait = await waitForAllBackgroundRuns(timeoutMs, signal);
			else wait = await waitForFirstBackgroundRun(timeoutMs, signal);

			if (wait.unknown.length > 0) {
				return {
					content: [{ type: "text", text: `Unknown background subagent session "${wait.unknown[0]}". Known runs: ${formatBackgroundRuns(listBackgroundRuns())}.` }],
					details: backgroundDetails([]),
					isError: true,
				};
			}

			if (wait.selected.length === 0) {
				return {
					content: [{ type: "text", text: `No background subagent runs are available to wait for. Known runs: ${formatBackgroundRuns(listBackgroundRuns())}.` }],
					details: backgroundDetails([]),
				};
			}

			const resultCap = resolveResultCap(undefined, config.resultCapTokens);
			const results = wait.settled.flatMap((run) => (run.result ? [run.result] : []));
			// Only a handed-over result counts as collected, so a timeout or abort keeps
			// the run eligible for the next unnamed wait.
			if (!wait.aborted) {
				for (const run of wait.settled) markBackgroundRunCollected(run.sessionId);
			}
			return {
				content: [{ type: "text", text: waitResultText(wait, resultCap, timeoutMs) }],
				details: backgroundDetails(results),
				isError: results.some((result) => isFailedResult(result)),
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		promptSnippet: "Delegate a self-contained task to a separate Pi agent.",
		description: [
			"Delegate one task to a separate Pi subagent per call.",
			"Emit several `subagent` calls in the same assistant turn to run independent work concurrently.",
			"For dependent work, call again with the previous result.",
			"Each agent needs exactly one source: `agent`, `systemPrompt`, or `resume`.",
		].join(" "),
		promptGuidelines: [buildDelegationPolicyLine(config.delegationPolicy), ...OPERATIONAL_GUIDELINES],
		parameters: buildSubagentParams(fileConfig.allowedModels),

		async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = sanitizeToolParams(rawParams);
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			if (!params.task) {
				return {
					content: [{ type: "text", text: "A non-empty task is required." }],
					details: makeDetails([]),
					isError: true,
				};
			}

			// Read command-controlled model policy values for every tool call. This keeps
			// /subagent-defaults and hand-edited allowlists effective immediately without
			// freezing them at session_start, while the registry lookup prevents unknown
			// configured models from reaching a child process.
			const liveConfig = loadSubagentConfig();
			const resolutionDefaults = resolveSubagentDefaults(liveConfig, ctx.modelRegistry);
			const resolve = (item: SubagentInput, index: number) =>
				resolveSpec(item, agents, index, resolutionDefaults, ctx.modelRegistry);
			const resultCap = resolveResultCap(params.resultCapTokens, config.resultCapTokens);

			if (agentScope === "project" || agentScope === "both") {
				const projectAgent = params.agent
					? agents.find((agent) => agent.name === params.agent && agent.source === "project")
					: undefined;

				if (projectAgent) {
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: "Project-local agents require interactive approval and cannot run in headless mode." }],
							details: makeDetails([]),
							isError: true,
						};
					}
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgent.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails([]),
						};
				}
			}

			const currentDepthRaw = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
			const currentDepth = Number.isInteger(currentDepthRaw) && currentDepthRaw >= 0 ? currentDepthRaw : 0;
			const inheritedCoordinatorSocket = process.env.PI_SUBAGENT_COORDINATOR_SOCKET;
			let approvalServer: ApprovalServer | null = null;
			let ownsCoordinator = false;
			let coordinatorSocketPath: string | undefined = inheritedCoordinatorSocket;
			const widget = createWidgetTracker(ctx, `${WIDGET_ID_PREFIX}:${toolCallId}`, (nestedCount) => {
				const selfSessionId = process.env.PI_SUBAGENT_SESSION_ID;
				if (!ownsCoordinator && coordinatorSocketPath && selfSessionId) {
					sendStatusCount(coordinatorSocketPath, selfSessionId, nestedCount);
				}
			});
			if (!inheritedCoordinatorSocket && currentDepth === 0 && (ctx.hasUI || config.maxDepth > 1)) {
				approvalServer = startApprovalServer(
					{ select: ctx.hasUI ? (title, options) => ctx.ui.select(title, options) : undefined },
					{
						maxLiveChildren: config.maxLiveChildren,
						acquireTimeoutMs: config.budgetAcquireTimeoutMs,
						onStatusCount: (agentSessionId, nestedCount) => widget.setNestedCount(agentSessionId, nestedCount),
					},
				);
				coordinatorSocketPath = approvalServer.socketPath;
				ownsCoordinator = true;
			}
			let forkSourceMessages: ReturnType<typeof buildForkSourceMessages> | undefined;
			const prepareFork = async (spec: AgentSpec, cwd: string | undefined) => {
				spec.cwd = cwd ?? ctx.cwd;
				if (spec.forkContext.mode === "none") return;
				forkSourceMessages ??= buildForkSourceMessages(ctx.sessionManager);
				const forkResult = await applyForkContext(spec, spec.forkContext, ctx.sessionManager, forkSourceMessages);
				if (forkResult.warning) spec.forkWarning = forkResult.warning;
				if (forkResult.forkedFrom) spec.forkedFrom = forkResult.forkedFrom;
			};

			let backgroundStarted = false;
			try {
				const resolved = resolve(params, 0);
				if ("error" in resolved) {
					return {
						content: [{ type: "text", text: resolved.error }],
						details: makeDetails([]),
						isError: true,
					};
				}
				const existing = getBackgroundRun(resolved.spec.sessionId);
				if (existing?.status === "running") {
					return {
						content: [{
							type: "text",
							text: `Background subagent "${existing.agent}" is still running in session "${existing.sessionId}". Collect it with subagent_wait first before starting another run on that session.`,
						}],
						details: makeDetails([]),
						isError: true,
					};
				}
				await prepareFork(resolved.spec, params.cwd);

				if (params.async) {
					backgroundStarted = true;
					const controller = new AbortController();
					const backgroundPromise = runSingleAgent(
						ctx.cwd,
						resolved.spec,
						params.task,
						params.cwd,
						controller.signal,
						undefined,
						makeDetails,
						coordinatorSocketPath,
						config.budgetAcquireTimeoutMs,
						config.maxLiveChildren,
						config.maxDepth,
						currentDepth,
						widget,
					)
						.catch(async (error) => {
							const result = errorResult(
								resolved.spec.name,
								params.task,
								error instanceof Error ? error.message : String(error),
								resolved.spec,
							);
							if (result.sessionId) {
								const outputFile = await writeOutputArtifact(
									getSessionsDir(),
									result.sessionId,
									buildResultPayload(result),
								);
								if (outputFile) result.outputFile = outputFile;
							}
							return result;
						})
						.finally(() => {
							widget.clear();
							if (ownsCoordinator) approvalServer?.close();
						});
					registerBackgroundRun({
						sessionId: resolved.spec.sessionId,
						agent: resolved.spec.name,
						task: params.task,
						promise: backgroundPromise,
						resultCapTokens: resultCap,
						abort: () => controller.abort(),
					});
					return {
						content: [{
							type: "text",
							text: `Started background subagent "${resolved.spec.name}" (session: ${resolved.spec.sessionId}). Use subagent_wait with id "${resolved.spec.sessionId}" to collect the result.`,
						}],
						details: makeDetails([]),
					};
				}

				const result = await runSingleAgent(
					ctx.cwd,
					resolved.spec,
					params.task,
					params.cwd,
					signal,
					onUpdate,
					makeDetails,
					coordinatorSocketPath,
					config.budgetAcquireTimeoutMs,
					config.maxLiveChildren,
					config.maxDepth,
					currentDepth,
					widget,
				);
				const isError = isFailedResult(result);
				if (isError) {
					return {
						content: [{ type: "text", text: assembleSingleResultText(result, resultCap) }],
						details: makeDetails([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: assembleSingleResultText(result, resultCap) }],
					details: makeDetails([result]),
				};
			} finally {
				if (!backgroundStarted) {
					widget.clear();
					if (ownsCoordinator) approvalServer?.close();
				}
			}
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const agentName = displayName(args);
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const fork = forkTag(args);
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				(fork ? theme.fg("muted", ` [fork: ${fork}]`) : "");
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}) [${resultSettingsTag(r)}]`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					if (r.sessionId) container.addChild(new Text(theme.fg("dim", `session: ${r.sessionId}`), 0, 0));
					if (r.forkedFrom) container.addChild(new Text(theme.fg("dim", `forked from: ${r.forkedFrom}`), 0, 0));
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}) [${resultSettingsTag(r)}]`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				if (r.forkedFrom) text += `\n${theme.fg("dim", `forked from: ${r.forkedFrom}`)}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
