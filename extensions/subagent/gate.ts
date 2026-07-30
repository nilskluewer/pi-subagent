/**
 * Shared permission gate for the main agent and subagents.
 *
 * The same extension loads in the parent TUI and in every spawned subagent
 * process (global extension discovery applies to children too):
 *
 * - Parent TUI: dangerous bash commands prompt via ctx.ui.select (same
 *   behavior as the old standalone permission-gate extension).
 * - Subagent child (PI_SUBAGENT_COORDINATOR_SOCKET set): dangerous bash approval
 *   requests are proxied over a Unix domain socket to the parent, which prompts
 *   the user labeled with the subagent's name. Timeout or socket error blocks
 *   the call (fail closed). Normal write/edit calls follow the tool allowlist.
 * - Headless without a socket: dangerous bash calls are blocked.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type DangerousPattern = {
	name: string;
	pattern: RegExp;
};

const dangerousPatterns: DangerousPattern[] = [
	// File deletion / destructive filesystem traversal
	{ name: "recursive/forced rm", pattern: /\brm\b(?=[^\n;&|]*\s-(?:[^\s;&|]*[rR][^\s;&|]*[fF]?|[^\s;&|]*[fF][^\s;&|]*[rR])\b|[^\n;&|]*\s--recursive\b)/i },
	{ name: "remove Git metadata", pattern: /\brm\b[^\n;&|]*\s(?:\.git|\.git\/|['"]\.git['"])/i },
	{ name: "find delete", pattern: /\bfind\b[^\n;&|]*\s-delete\b/i },
	{ name: "xargs rm", pattern: /\bxargs\b[^\n;&|]*\brm\b/i },

	// Privilege escalation / permission or ownership foot-guns
	{ name: "sudo", pattern: /\bsudo\b/i },
	{ name: "world-writable permissions", pattern: /\bchmod\b[^\n;&|]*\b777\b/i },
	{ name: "recursive chmod/chown", pattern: /\b(?:chmod|chown)\b[^\n;&|]*\s-R\b/i },
	{ name: "recursive chmod/chown", pattern: /\b(?:chmod|chown)\b[^\n;&|]*\s--recursive\b/i },

	// Disk / partition / filesystem destruction
	{ name: "format filesystem", pattern: /\bmkfs(?:\.[a-z0-9_+-]+)?\b/i },
	{ name: "wipe filesystem signatures", pattern: /\bwipefs\b/i },
	{ name: "disk shred/wipe", pattern: /\b(?:shred|srm)\b/i },
	{ name: "partition editor", pattern: /\b(?:fdisk|parted|gparted|sfdisk|cfdisk)\b/i },
	{ name: "macOS disk erase", pattern: /\bdiskutil\b[^\n;&|]*\b(?:erase|partition|apfs\s+delete|apfs\s+erase)\b/i },
	{ name: "dd writes to disk device", pattern: /\bdd\b[^\n;&|]*\bof=\/dev\//i },

	// Git working tree / repo / history destruction
	{ name: "git reset hard", pattern: /\bgit\b[^\n;&|]*\breset\b[^\n;&|]*\s--hard\b/i },
	{ name: "git clean forced", pattern: /\bgit\b[^\n;&|]*\bclean\b(?=[^\n;&|]*\s-[^\s;&|]*f)[^\n;&|]*/i },
	{ name: "git force push", pattern: /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s--(?:force|force-with-lease|mirror)\b/i },
	{ name: "git force push", pattern: /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s-[^\s;&|]*f[^\s;&|]*\b/i },
	{ name: "git branch force-delete", pattern: /\bgit\b[^\n;&|]*\bbranch\b[^\n;&|]*\s-D\b/i },
	{ name: "git tag delete", pattern: /\bgit\b[^\n;&|]*\btag\b[^\n;&|]*\s-d\b/i },
	{ name: "git remove files", pattern: /\bgit\b[^\n;&|]*\brm\b/i },
	{ name: "git checkout all files", pattern: /\bgit\b[^\n;&|]*\bcheckout\b[^\n;&|]*\s--\s+(?:\.|\*)\b/i },
	{ name: "git restore all files", pattern: /\bgit\b[^\n;&|]*\brestore\b[^\n;&|]*(?:\s\.\b|\s:\/\b|\s--source\b)/i },
	{ name: "git reflog expiry", pattern: /\bgit\b[^\n;&|]*\breflog\b[^\n;&|]*\bexpire\b/i },
	{ name: "git aggressive prune/gc", pattern: /\bgit\b[^\n;&|]*\b(?:gc|prune)\b[^\n;&|]*(?:--prune=(?:now|all)|--expire\s+now|--expire=now)/i },

	// Containers / volumes can destroy local databases and development state
	{ name: "docker prune/remove volumes", pattern: /\bdocker\b[^\n;&|]*\b(?:system\s+prune|volume\s+(?:rm|prune)|container\s+prune|image\s+prune)\b/i },
	{ name: "docker compose remove volumes", pattern: /\bdocker\s+compose\b[^\n;&|]*\bdown\b[^\n;&|]*(?:\s-v\b|\s--volumes\b)/i },

	// Running remote scripts can do anything with current user permissions
	{ name: "downloaded script execution", pattern: /\b(?:curl|wget)\b[^\n;&|]*(?:\|\s*(?:sh|bash|zsh)\b|\b(?:sh|bash|zsh)\s*<\s*\()/i },
];

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

function matchedReasons(command: string): string[] {
	return dangerousPatterns.filter(({ pattern }) => pattern.test(command)).map(({ name }) => name);
}

function preview(text: string): string {
	const maxLength = 1200;
	return text.length > maxLength ? `${text.slice(0, 1200)}\n… (truncated)` : text;
}

export function classify(toolName: string, input: Record<string, unknown>): string[] {
	if (READ_ONLY_TOOLS.has(toolName)) return [];
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return [...new Set(matchedReasons(command))];
	}
	return [];
}

export interface ApprovalRequest {
	type: "approval";
	id: string;
	agent: string;
	toolName: string;
	input: Record<string, unknown>;
	reasons: string[];
}

export function summarizeInput(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") return input.command;
	return JSON.stringify(input);
}

function requestApproval(socketPath: string, request: ApprovalRequest): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		let buffer = "";
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("Approval request timed out"));
		}, APPROVAL_TIMEOUT_MS);

		const finish = (fn: () => void) => {
			clearTimeout(timeout);
			socket.destroy();
			fn();
		};

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (data) => {
			buffer += data.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				const reply = JSON.parse(buffer.slice(0, newline)) as { id?: string; allow?: boolean };
				finish(() => resolve(reply.allow === true));
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});
		socket.on("error", (error) => {
			finish(() => reject(error));
		});
	});
}

export function registerGate(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const socketPath = process.env.PI_SUBAGENT_COORDINATOR_SOCKET;
		const isSubagent = Boolean(process.env.PI_SUBAGENT);
		const reasons = classify(event.toolName, event.input as Record<string, unknown>);
		if (reasons.length === 0) return undefined;

		if (isSubagent) {
			if (!socketPath) {
				return { block: true, reason: `Blocked in subagent (${reasons.join(", ")}): no approval channel` };
			}
			const allowed = await requestApproval(socketPath, {
				type: "approval",
				id: crypto.randomUUID(),
				agent: process.env.PI_SUBAGENT_NAME ?? "subagent",
				toolName: event.toolName,
				input: event.input as Record<string, unknown>,
				reasons,
			}).catch(() => false);
			return allowed ? undefined : { block: true, reason: "Blocked by user via parent permission gate" };
		}

		const reason = `Potentially dangerous command blocked/needs confirmation: ${reasons.join(", ")}`;
		if (!ctx.hasUI) {
			return { block: true, reason: `${reason} (no UI for confirmation)` };
		}

		const choice = await ctx.ui.select(
			`⚠️ Dangerous command detected\n\nReasons: ${reasons.join(", ")}\n\n${preview(summarizeInput(event.toolName, event.input as Record<string, unknown>))}\n\nAllow this command to run?`,
			["No", "Yes"],
		);
		if (choice !== "Yes") {
			return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
