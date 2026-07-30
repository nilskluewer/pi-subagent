/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Adapted from the official pi subagent example. Spawns a separate `pi`
 * process for each subagent invocation, giving it an isolated context window.
 *
 * Modes:
 *   - Single: { agent | systemPrompt | resume, task: "..." }
 *   - Parallel: { tasks: [{ agent | systemPrompt | resume, task }, ...] }
 *   - Chain: { chain: [{ ..., task: "... {previous} ..." }, ...] }
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
	CONFIG_DIR_NAME,
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
import { DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS, DEFAULT_MAX_DEPTH, DEFAULT_MAX_LIVE_CHILDREN, OPERATIONAL_GUIDELINES, TREE_POLICY_ENV, buildDelegationPolicyLine, loadSubagentConfig, treePolicyFromEnv } from "./config.ts";
import { inheritedToolsEnv } from "./inherited-tools.ts";
import { capText, formatEnvelope, resolveResultCap } from "./result-cap.ts";
import { type ApprovalServer, startApprovalServer } from "./approval-server.ts";
import { displayModel, modelTag } from "./terminal-display.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
// Use one widget id per tool call so concurrent execute() calls cannot clear each other's rows.
const WIDGET_ID_PREFIX = "subagent";

function getSessionsDir(): string {
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
			const mode = Array.isArray(args.tasks) ? `parallel (${args.tasks.length})` : Array.isArray(args.chain) ? `chain (${args.chain.length})` : "single";
			const label = (args.agent || args.name || (args.resume ? `resume:${String(args.resume).slice(0, 8)}` : mode)) as string;
			return themeFg("muted", "subagent ") + themeFg("accent", label) + themeFg("dim", ` ${mode}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

const plainFg = (_color: any, text: string) => text;

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
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	forkWarning?: string;
	forkedFrom?: string;
	parent?: string;
	rootId?: string;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
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

interface TaskItemInput {
	agent?: string;
	systemPrompt?: string;
	name?: string;
	model?: string;
	tools?: string;
	thinking?: string;
	resume?: string;
	forkContext?: string;
	resultCapTokens?: number;
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

export function resolveSpec(
	item: TaskItemInput,
	agents: AgentConfig[],
	index: number,
): { spec: AgentSpec } | { error: string } {
	const forkContext = parseForkContext(item.forkContext);
	if ("error" in forkContext) return { error: forkContext.error };
	const provided = [item.agent, item.systemPrompt, item.resume].filter((v) => v?.trim()).length;
	if (provided !== 1) {
		return { error: 'Provide exactly one of "agent" (named), "systemPrompt" (inline), or "resume" (session id).' };
	}
	if (item.resume?.trim() && forkContext.mode !== "none") {
		return { error: '"resume" and forkContext other than "none" are mutually exclusive.' };
	}

	const sessionsDir = getSessionsDir();

	if (item.resume?.trim()) {
		const sessionId = item.resume.trim();
		const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
		const metaFile = path.join(sessionsDir, `${sessionId}.meta.json`);
		let meta: SessionMeta;
		try {
			meta = JSON.parse(fs.readFileSync(metaFile, "utf-8")) as SessionMeta;
		} catch {
			return { error: `Unknown subagent session "${sessionId}" (no metadata at ${metaFile}).` };
		}
		if (!fs.existsSync(sessionFile)) {
			return { error: `Subagent session file missing for "${sessionId}" (${sessionFile}).` };
		}
		return {
			spec: {
				name: meta.name,
				systemPrompt: meta.systemPrompt ?? "",
				model: item.model ?? meta.model,
				tools: parseToolsList(item.tools) ?? meta.tools,
				thinking: item.thinking ?? meta.thinking,
				source: "resume",
				sessionId,
				sessionFile,
				isResume: true,
				forkContext,
				parent: meta.parent,
				rootId: meta.rootId,
			},
		};
	}

	const sessionId = crypto.randomUUID();
	const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

	if (item.agent?.trim()) {
		const agent = agents.find((a) => a.name === item.agent);
		if (!agent) {
			const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
			return { error: `Unknown agent: "${item.agent}". Available agents: ${available}.` };
		}
		return {
			spec: {
				name: agent.name,
				systemPrompt: agent.systemPrompt,
				model: item.model ?? agent.model,
				tools: parseToolsList(item.tools) ?? agent.tools,
				thinking: item.thinking ?? agent.thinking,
				source: agent.source,
				sessionId,
				sessionFile,
				isResume: false,
				forkContext,
			},
		};
	}

	return {
		spec: {
			name: item.name?.trim() || `agent-${index + 1}`,
			systemPrompt: item.systemPrompt ?? "",
			model: item.model,
			tools: parseToolsList(item.tools),
			thinking: item.thinking,
			source: "inline",
			sessionId,
			sessionFile,
			isResume: false,
			forkContext,
		},
	};
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
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
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

function formatCappedResult(result: SingleResult, output: string, cap: number): string {
	const payload = prependForkWarning(result, output);
	return formatEnvelope(result, capText(payload, cap), { maxTokens: cap });
}

export function assembleSingleResultText(result: SingleResult, cap: number): string {
	const output = getResultOutput(result);
	if (result.stopReason === "aborted") return prependForkWarning(result, output);
	if (isFailedResult(result)) return formatCappedResult(result, `Agent ${result.stopReason || "failed"}: ${output}`, cap);
	return formatCappedResult(result, getFinalOutput(result.messages) || "(no output)", cap);
}

export function assembleParallelResultText(results: SingleResult[], caps: number[]): string {
	const successCount = results.filter((result) => !isFailedResult(result)).length;
	const summaries = results.map((result, index) => {
		if (result.stopReason === "aborted") return prependForkWarning(result, getResultOutput(result));
		return formatCappedResult(result, getResultOutput(result), caps[index] ?? caps[caps.length - 1] ?? 0);
	});
	return `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
}

export function assembleChainSuccessText(results: SingleResult[], finalCap: number): string {
	const finalResult = results[results.length - 1];
	const priorWarnings = results
		.slice(0, -1)
		.map((result) => (result.forkWarning ? `[warning] ${result.agent}: ${result.forkWarning}` : null))
		.filter(Boolean)
		.join("\n\n");
	const finalOutput = getFinalOutput(finalResult.messages) || "(no output)";
	return formatCappedResult(finalResult, priorWarnings ? `${priorWarnings}\n\n${finalOutput}` : finalOutput, finalCap);
}

export function assembleChainFailureText(result: SingleResult, step: number, cap: number): string {
	if (result.stopReason === "aborted") {
		return `Chain stopped at step ${step} (${result.agent}): ${prependForkWarning(result, getResultOutput(result))}`;
	}
	return `Chain stopped at step ${step} (${result.agent}): ${formatCappedResult(result, getResultOutput(result), cap)}`;
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

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
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

function errorResult(name: string, task: string, message: string, step?: number): SingleResult {
	return {
		agent: name,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		step,
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

export async function runSingleAgent(
	defaultCwd: string,
	spec: AgentSpec,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
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
	const args: string[] = ["--mode", "json", "-p", "--session", spec.sessionFile];
	if (spec.model) args.push("--model", spec.model);
	if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
	if (spec.thinking) args.push("--thinking", spec.thinking);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
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
		step,
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
			const slot = await acquireChildSlot(coordinatorSocketPath, spec.name, budgetAcquireTimeoutMs);
			if (!slot.granted) {
				return errorResult(
					spec.name,
					task,
					`Root agent budget exhausted (max ${maxLiveChildren} live subagents); try again once a sibling finishes, or raise maxLiveChildren in ~/.pi/agent/subagent.json`,
					step,
				);
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
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let abortController: AbortKillController | undefined;

		const exitCode = await new Promise<number>((resolve) => {
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

			proc.on("close", (code) => {
				abortController?.onClose();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				abortController?.onClose();
				resolve(1);
			});

			abortController = createAbortKillController(signal, (signalName) => killChild(proc, signalName, killStrategy));
		});

		currentResult.exitCode = abortController?.wasAborted() ? exitCode || 1 : exitCode;
		if (abortController?.wasAborted()) currentResult.stopReason = "aborted";
		widget.finish(spec.sessionId, !isFailedResult(currentResult));
		return currentResult;
	} catch (error) {
		widget.finish(spec.sessionId, false);
		throw error;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		releaseSlot?.();
	}
}

const agentSelectionFields = {
	agent: Type.Optional(Type.String({ description: "Named agent from the agents directory (exactly one of agent | systemPrompt | resume)" })),
	systemPrompt: Type.Optional(Type.String({ description: "Inline system prompt / persona for an ad-hoc agent" })),
	name: Type.Optional(Type.String({ description: "Display label for inline agents (shown in widget and approval prompts)" })),
	model: Type.Optional(Type.String({ description: "Model override (provider/model-id)" })),
	tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist for the agent (e.g. \"read,grep,find,ls\")" })),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
			description: "Thinking level for the agent. Default: inherits the global default (currently \"medium\").",
		}),
	),
	resume: Type.Optional(Type.String({ description: "Session id of a previous subagent run to continue with full context" })),
	forkContext: Type.Optional(
		Type.String({ description: '"none" (default), "all", or a positive integer as a string, e.g. "5", meaning the last N turns' }),
	),
	resultCapTokens: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"Override the result cap (approx. tokens) for this agent; 0 disables it. Falls back to the call-level value, then the configured default, then 1000.",
		}),
	),
};

const TaskItem = Type.Object({
	...agentSelectionFields,
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	...agentSelectionFields,
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	...agentSelectionFields,
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of tasks for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of tasks for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

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

export function registerSubagentTool(pi: ExtensionAPI) {
	const registrationDepthRaw = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const registrationDepth = Number.isInteger(registrationDepthRaw) && registrationDepthRaw >= 0 ? registrationDepthRaw : 0;
	const defaultTreePolicy = {
		maxDepth: DEFAULT_MAX_DEPTH,
		maxLiveChildren: DEFAULT_MAX_LIVE_CHILDREN,
		budgetAcquireTimeoutMs: DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS,
	};
	const fileConfig = loadSubagentConfig();
	const config = {
		...fileConfig,
		...(registrationDepth > 0 ? treePolicyFromEnv(process.env, defaultTreePolicy) : {}),
	};
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to subagents with isolated context.",
			"Agent persona: named agent (from agents dir), inline via systemPrompt (+ optional name/model/tools), or resume a previous session by id.",
			"Modes: single (task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Each result includes a session id; pass it as `resume` with a follow-up task to continue that agent with full context (e.g. verify an implemented fix).",
			`Named agents live in ${path.join(getAgentDir(), "agents")}; project-local agents in ${CONFIG_DIR_NAME}/agents require agentScope "both" or "project".`,
			"Dangerous bash calls inside subagents surface as approval prompts to the user; write/edit follow the configured tool allowlist.",
		].join(" "),
		promptGuidelines: [...OPERATIONAL_GUIDELINES, buildDelegationPolicyLine(config.delegationPolicy)],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const capFor = (item: { resultCapTokens?: number }) =>
				resolveResultCap(item.resultCapTokens, params.resultCapTokens, config.resultCapTokens);
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task && (params.agent || params.systemPrompt || params.resume));
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode: single (task + one of agent/systemPrompt/resume), parallel (tasks), or chain.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) if (step.agent) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) if (t.agent) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
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

			try {
				if (params.chain && params.chain.length > 0) {
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

						const resolved = resolveSpec(step, agents, i);
						if ("error" in resolved) {
							const result = errorResult(displayName(step), taskWithContext, resolved.error, i + 1);
							results.push(result);
							return {
								content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${resolved.error}` }],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}

						await prepareFork(resolved.spec, step.cwd);

						// Create update callback that includes all previous results
						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									// Combine completed results with current streaming result
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										const allResults = [...results, currentResult];
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")(allResults),
										});
									}
								}
							: undefined;

						const result = await runSingleAgent(
							ctx.cwd,
							resolved.spec,
							taskWithContext,
							step.cwd,
							i + 1,
							signal,
							chainUpdate,
							makeDetails("chain"),
							coordinatorSocketPath,
							config.budgetAcquireTimeoutMs,
							config.maxLiveChildren,
							config.maxDepth,
							currentDepth,
							widget,
						);
						results.push(result);

						const isError = isFailedResult(result);
						if (isError) {
							return {
								content: [{ type: "text", text: assembleChainFailureText(result, i + 1, capFor(step)) }],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						previousOutput = getFinalOutput(result.messages);
					}
					return {
						content: [
							{
								type: "text",
								text: assembleChainSuccessText(results, capFor(params.chain[params.chain.length - 1])),
							},
						],
						details: makeDetails("chain")(results),
					};
				}

				if (params.tasks && params.tasks.length > 0) {
					if (params.tasks.length > MAX_PARALLEL_TASKS)
						return {
							content: [
								{
									type: "text",
									text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
								},
							],
							details: makeDetails("parallel")([]),
						};

					// Resolve all specs up front so schema errors surface before anything spawns
					const resolvedItems = params.tasks.map((t, i) => ({ item: t, resolved: resolveSpec(t, agents, i) }));
					const resolveErrors = resolvedItems
						.map(({ item, resolved }, i) =>
							"error" in resolved ? `Task ${i + 1} (${displayName(item)}): ${resolved.error}` : null,
						)
						.filter(Boolean);
					if (resolveErrors.length > 0) {
						return {
							content: [{ type: "text", text: `Invalid tasks:\n${resolveErrors.join("\n")}` }],
							details: makeDetails("parallel")([]),
							isError: true,
						};
					}

					for (let i = 0; i < resolvedItems.length; i++) {
						const spec = (resolvedItems[i].resolved as { spec: AgentSpec }).spec;
						await prepareFork(spec, params.tasks[i].cwd);
					}

					// Track all results for streaming updates
					const allResults: SingleResult[] = new Array(params.tasks.length);

					// Initialize placeholder results
					for (let i = 0; i < params.tasks.length; i++) {
						const { resolved } = resolvedItems[i];
						const spec = (resolved as { spec: AgentSpec }).spec;
						allResults[i] = {
							agent: spec.name,
							agentSource: spec.source,
							task: params.tasks[i].task,
							sessionId: spec.sessionId,
							sessionFile: spec.sessionFile,
							exitCode: -1, // -1 = still running
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							forkWarning: spec.forkWarning,
							forkedFrom: spec.forkedFrom,
							parent: spec.parent,
							rootId: spec.rootId,
						};
					}

					const emitParallelUpdate = () => {
						if (onUpdate) {
							const running = allResults.filter((r) => r.exitCode === -1).length;
							const done = allResults.filter((r) => r.exitCode !== -1).length;
							onUpdate({
								content: [
									{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
								],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
						const spec = (resolvedItems[index].resolved as { spec: AgentSpec }).spec;
						const result = await runSingleAgent(
							ctx.cwd,
							spec,
							t.task,
							t.cwd,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							coordinatorSocketPath,
							config.budgetAcquireTimeoutMs,
							config.maxLiveChildren,
							config.maxDepth,
							currentDepth,
							widget,
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					});

					return {
						content: [
							{
								type: "text",
								text: assembleParallelResultText(results, params.tasks.map((task) => capFor(task))),
							},
						],
						details: makeDetails("parallel")(results),
					};
				}

				if (hasSingle && params.task) {
					const resolved = resolveSpec(params, agents, 0);
					if ("error" in resolved) {
						return {
							content: [{ type: "text", text: resolved.error }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
					await prepareFork(resolved.spec, params.cwd);
					const result = await runSingleAgent(
						ctx.cwd,
						resolved.spec,
						params.task,
						params.cwd,
						undefined,
						signal,
						onUpdate,
						makeDetails("single"),
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
							content: [
								{
									type: "text",
									text: assembleSingleResultText(result, capFor(params)),
								},
							],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: assembleSingleResultText(result, capFor(params)) }],
						details: makeDetails("single")([result]),
					};
				}

				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
					details: makeDetails("single")([]),
				};
			} finally {
				widget.clear();
				if (ownsCoordinator) approvalServer?.close();
			}
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					const fork = forkTag(step);
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", displayName(step)) +
						(fork ? theme.fg("muted", ` [fork: ${fork}]`) : "") +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					const fork = forkTag(t);
					text += `\n  ${theme.fg("accent", displayName(t))}${fork ? theme.fg("muted", ` [fork: ${fork}]`) : ""}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
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

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}) [${r.model ?? "default"}]`)}`;
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

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}) [${r.model ?? "default"}]`)}`;
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

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${theme.fg("dim", `[${r.model ?? "default"}]`)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
						if (r.forkedFrom) container.addChild(new Text(theme.fg("dim", `forked from: ${r.forkedFrom}`), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${theme.fg("dim", `[${r.model ?? "default"}]`)} ${rIcon}`;
					if (r.forkedFrom) text += `\n${theme.fg("dim", `forked from: ${r.forkedFrom}`)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${theme.fg("dim", `[${r.model ?? "default"}]`)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
						if (r.sessionId) container.addChild(new Text(theme.fg("dim", `session: ${r.sessionId}`), 0, 0));
						if (r.forkedFrom) container.addChild(new Text(theme.fg("dim", `forked from: ${r.forkedFrom}`), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${theme.fg("dim", `[${r.model ?? "default"}]`)} ${rIcon}`;
					if (r.forkedFrom) text += `\n${theme.fg("dim", `forked from: ${r.forkedFrom}`)}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
