/**
 * Run one subagent as a `pi --mode json -p` child process and fold its JSONL
 * event stream into a result with exact usage and cost.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { inheritedToolsEnv } from "./inherited-tools.ts";
import type { Spec } from "./spec.ts";

export type Status = "completed" | "error" | "aborted";

export interface ChildResult {
	status: Status;
	/** Last non-empty assistant text. Also set for failed or aborted runs (partial). */
	text: string;
	errorMessage?: string;
	/** Model the child actually used. */
	model?: string;
	usage: Usage;
	turns: number;
	stderr: string;
}

export interface Progress {
	usage: Usage;
	turns: number;
	tool?: string;
}

export const emptyUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function addUsage(into: Usage, add: Partial<Usage> | undefined): void {
	if (!add) return;
	into.input += add.input || 0;
	into.output += add.output || 0;
	into.cacheRead += add.cacheRead || 0;
	into.cacheWrite += add.cacheWrite || 0;
	into.totalTokens += add.totalTokens || 0;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		into.cost[key] += add.cost?.[key] || 0;
	}
}

/** Fold JSONL events from `pi --mode json` into a result. Pure, so it is testable without a child. */
export function createAccumulator() {
	const result: ChildResult = { status: "completed", text: "", usage: emptyUsage(), turns: 0, stderr: "" };
	let tool: string | undefined;
	return {
		result,
		progress: (): Progress => ({ usage: result.usage, turns: result.turns, tool }),
		/** Returns true when the event changed the progress. */
		push(line: string): boolean {
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return false;
			}
			if (event.type === "tool_execution_start") {
				tool = event.toolName ?? "tool";
				return true;
			}
			if (event.type === "tool_execution_end") {
				tool = undefined;
				return true;
			}
			const message = event.type === "message_end" ? event.message : undefined;
			if (message?.role !== "assistant") return false;
			result.turns++;
			addUsage(result.usage, message.usage);
			if (message.model) result.model = `${message.provider ? `${message.provider}/` : ""}${message.model}`;
			// The last message decides: pi retries a failed request with a new message.
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				result.status = message.stopReason;
				result.errorMessage = message.errorMessage ?? message.stopReason;
			} else {
				result.status = "completed";
				result.errorMessage = undefined;
			}
			const text = (message.content ?? [])
				.filter((part: any) => part.type === "text")
				.map((part: any) => part.text)
				.join("");
			if (text) result.text = text;
			return true;
		},
	};
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	return /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
		? { command: "pi", args }
		: { command: process.execPath, args };
}

export function buildArgs(spec: Pick<Spec, "sessionFile" | "model" | "thinking" | "tools">, taskFile: string, promptFile?: string): string[] {
	const args = ["--mode", "json", "-p", "--session", spec.sessionFile];
	if (spec.model) args.push("--model", spec.model);
	if (spec.thinking) args.push("--thinking", spec.thinking);
	if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
	if (promptFile) args.push("--append-system-prompt", promptFile);
	// The task goes through an @file: endpoint security tools on macOS can kill
	// a process whose argv holds a long string that looks like an invalid path.
	args.push(`@${taskFile}`);
	return args;
}

export interface RunOptions {
	spec: Spec;
	task: string;
	cwd: string;
	signal?: AbortSignal;
	onProgress?: (progress: Progress) => void;
	/** Override the launcher. Tests use this to run a fake child. */
	invocation?: (args: string[]) => { command: string; args: string[] };
}

export async function runChild({ spec, task, cwd, signal, onProgress, invocation = piInvocation }: RunOptions): Promise<ChildResult> {
	const acc = createAccumulator();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	try {
		const taskFile = path.join(tmp, "task.md");
		fs.writeFileSync(taskFile, `Task: ${task}`, { mode: 0o600 });
		let promptFile: string | undefined;
		if (spec.systemPrompt.trim()) {
			promptFile = path.join(tmp, "system.md");
			fs.writeFileSync(promptFile, spec.systemPrompt, { mode: 0o600 });
		}
		const launch = invocation(buildArgs(spec, taskFile, promptFile));

		let aborted = false;
		const { code, signal: exitSignal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			// Own process group on POSIX, so an abort also kills the child's bash tools.
			const detached = process.platform !== "win32";
			const proc = spawn(launch.command, launch.args, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached,
				env: {
					...process.env,
					PI_SUBAGENT: "1",
					PI_SUBAGENT_NAME: spec.name,
					PI_SUBAGENT_SESSION_ID: spec.sessionId,
					...inheritedToolsEnv(spec.tools),
				},
			});
			const kill = (sig: NodeJS.Signals) => {
				try {
					if (detached && proc.pid) process.kill(-proc.pid, sig);
					else proc.kill(sig);
				} catch {
					/* already gone */
				}
			};
			let escalation: NodeJS.Timeout | undefined;
			const onAbort = () => {
				aborted = true;
				kill("SIGTERM");
				escalation = setTimeout(() => kill("SIGKILL"), 5000);
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			let buffer = "";
			const feed = (line: string) => {
				if (line.trim() && acc.push(line)) onProgress?.(acc.progress());
			};
			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				lines.forEach(feed);
			});
			proc.stderr.on("data", (data) => {
				acc.result.stderr += data.toString();
			});
			const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
				clearTimeout(escalation);
				signal?.removeEventListener("abort", onAbort);
				feed(buffer);
				resolve({ code, signal: exitSignal });
			};
			proc.on("close", finish);
			proc.on("error", (error) => {
				acc.result.stderr += `Child process error: ${error.message}\n`;
				finish(1, null);
			});
		});

		const { result } = acc;
		if (aborted) {
			result.status = "aborted";
			result.errorMessage ??= "Subagent aborted before completion.";
		} else if (exitSignal) {
			result.status = "error";
			result.errorMessage ??= `Child process terminated by signal ${exitSignal}.`;
		} else if (code !== 0 && result.status === "completed") {
			result.status = "error";
			result.errorMessage ??= result.stderr.trim() || `Child process exited with code ${code}.`;
		}
		return result;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
