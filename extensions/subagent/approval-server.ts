/**
 * Parent-side subagent coordinator.
 *
 * Listens on a Unix domain socket for permission approval requests, tree-wide
 * child-budget leases, and lightweight nested-count status updates.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type ApprovalRequest, summarizeInput } from "./gate.ts";

interface ApprovalUi {
	select?: (title: string, options: string[]) => Promise<string | undefined>;
}

export interface CoordinatorOptions {
	maxLiveChildren: number;
	acquireTimeoutMs: number;
	onStatusCount?: (agentSessionId: string, nestedCount: number) => void;
}

export interface ApprovalServer {
	socketPath: string;
	close(): void;
}

type AcquireMessage = { type: "acquire"; id: string; agent: string };
type StatusCountMessage = { type: "status_count"; sessionId: string; nestedCount: number };
type CoordinatorMessage = ApprovalRequest | AcquireMessage | StatusCountMessage;

type PendingAcquire = {
	id: string;
	connection: net.Socket;
	timer: NodeJS.Timeout;
	settled: boolean;
};

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}\n… (truncated)` : text;
}

function safeWrite(connection: net.Socket, payload: unknown): void {
	try {
		connection.write(`${JSON.stringify(payload)}\n`);
	} catch {
		/* child may have died while waiting */
	}
}

export function startApprovalServer(
	ui: ApprovalUi,
	options: CoordinatorOptions = { maxLiveChildren: 4, acquireTimeoutMs: 120000 },
): ApprovalServer {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-coordinator-"));
	const socketPath = path.join(dir, "coordinator.sock");
	let promptQueue: Promise<unknown> = Promise.resolve();
	let liveCount = 0;
	const pendingAcquires: PendingAcquire[] = [];
	const maxLiveChildren = Math.max(1, Math.floor(options.maxLiveChildren));
	const acquireTimeoutMs = Math.max(1, Math.floor(options.acquireTimeoutMs));

	const grant = (pending: PendingAcquire) => {
		if (pending.settled || pending.connection.destroyed) return;
		pending.settled = true;
		clearTimeout(pending.timer);
		(pending.connection as net.Socket & { __subagentLeaseGranted?: boolean; __subagentPendingAcquire?: PendingAcquire }).__subagentLeaseGranted = true;
		(pending.connection as net.Socket & { __subagentPendingAcquire?: PendingAcquire }).__subagentPendingAcquire = undefined;
		liveCount++;
		safeWrite(pending.connection, { id: pending.id, granted: true });
	};

	const grantNext = () => {
		while (liveCount < maxLiveChildren && pendingAcquires.length > 0) {
			const next = pendingAcquires.shift();
			if (!next) return;
			if (next.settled || next.connection.destroyed) continue;
			grant(next);
		}
	};

	const removePending = (pending: PendingAcquire) => {
		const index = pendingAcquires.indexOf(pending);
		if (index !== -1) pendingAcquires.splice(index, 1);
		clearTimeout(pending.timer);
	};

	const handleAcquire = (connection: net.Socket, message: AcquireMessage) => {
		const pending: PendingAcquire = {
			id: message.id,
			connection,
			settled: false,
			timer: setTimeout(() => {
				if (pending.settled) return;
				pending.settled = true;
				removePending(pending);
				safeWrite(connection, { id: message.id, granted: false, reason: "budget exhausted" });
				connection.end();
			}, acquireTimeoutMs),
		};

		if (liveCount < maxLiveChildren) {
			grant(pending);
			return;
		}
		(connection as net.Socket & { __subagentPendingAcquire?: PendingAcquire }).__subagentPendingAcquire = pending;
		pendingAcquires.push(pending);
	};

	const server = net.createServer((connection) => {
		let buffer = "";
		let handledFirstMessage = false;

		connection.on("data", (data) => {
			buffer += data.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1 || handledFirstMessage) return;
			handledFirstMessage = true;
			let message: CoordinatorMessage;
			try {
				message = JSON.parse(buffer.slice(0, newline)) as CoordinatorMessage;
			} catch {
				connection.end();
				return;
			}

			if (message.type === "acquire") {
				handleAcquire(connection, message);
				return;
			}

			if (message.type === "status_count") {
				options.onStatusCount?.(message.sessionId, message.nestedCount);
				connection.end();
				return;
			}

			if (message.type !== "approval") {
				connection.end();
				return;
			}

			const request = message;
			promptQueue = promptQueue.then(async () => {
				let allow = false;
				try {
					const choice = ui.select
						? await ui.select(
								`⚠️ Subagent "${request.agent}" wants: ${request.toolName}\n\nReasons: ${request.reasons.join(", ")}\n\n${truncate(summarizeInput(request.toolName, request.input), 1200)}\n\nAllow?`,
								["Deny", "Allow"],
							)
						: undefined;
					allow = choice === "Allow";
				} catch {
					allow = false;
				}
				safeWrite(connection, { id: request.id, allow });
				connection.end();
			});
		});
		connection.on("close", () => {
			const leaseConnection = connection as net.Socket & { __subagentLeaseGranted?: boolean; __subagentPendingAcquire?: PendingAcquire };
			if (leaseConnection.__subagentPendingAcquire && !leaseConnection.__subagentPendingAcquire.settled) {
				leaseConnection.__subagentPendingAcquire.settled = true;
				removePending(leaseConnection.__subagentPendingAcquire);
				leaseConnection.__subagentPendingAcquire = undefined;
				grantNext();
			}
			if (leaseConnection.__subagentLeaseGranted) {
				leaseConnection.__subagentLeaseGranted = false;
				liveCount = Math.max(0, liveCount - 1);
				grantNext();
			}
		});
		connection.on("error", () => {
			/* ignore - child aborted mid-request */
		});
	});

	server.listen(socketPath);

	return {
		socketPath,
		close() {
			try {
				server.close();
			} catch {
				/* ignore */
			}
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		},
	};
}
