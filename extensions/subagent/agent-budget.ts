import * as crypto from "node:crypto";
import * as net from "node:net";

export type ChildSlotLease =
	| { granted: true; release: () => void }
	| { granted: false; reason: string };

export function acquireChildSlot(
	socketPath: string,
	agent: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ChildSlotLease> {
	return new Promise((resolve) => {
		const id = crypto.randomUUID();
		const socket = net.connect(socketPath);
		let buffer = "";
		let settled = false;
		let abortListener: (() => void) | undefined;
		let timeout: NodeJS.Timeout;

		const cleanup = () => {
			clearTimeout(timeout);
			if (abortListener && signal) signal.removeEventListener("abort", abortListener);
			abortListener = undefined;
		};

		const deny = (reason: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			resolve({ granted: false, reason });
		};

		timeout = setTimeout(() => {
			deny("budget exhausted");
		}, Math.max(1, timeoutMs));

		socket.on("connect", () => {
			try {
				socket.write(`${JSON.stringify({ type: "acquire", id, agent })}\n`);
			} catch {
				deny("coordinator unavailable");
			}
		});

		socket.on("data", (data) => {
			buffer += data.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			let reply: { id?: string; granted?: boolean; reason?: string };
			try {
				reply = JSON.parse(buffer.slice(0, newline)) as { id?: string; granted?: boolean; reason?: string };
			} catch {
				deny("invalid coordinator response");
				return;
			}
			if (reply.id !== id) {
				deny("invalid coordinator response");
				return;
			}
			if (reply.granted === true) {
				if (settled) return;
				settled = true;
				cleanup();
				let released = false;
				resolve({
					granted: true,
					release: () => {
						if (released) return;
						released = true;
						socket.end();
					},
				});
				return;
			}
			deny(reply.reason || "budget exhausted");
		});

		socket.on("error", () => {
			deny("coordinator unavailable");
		});
		socket.on("close", () => {
			if (!settled) deny("coordinator unavailable");
		});

		if (signal) {
			abortListener = () => deny("aborted");
			if (signal.aborted) abortListener();
			else signal.addEventListener("abort", abortListener, { once: true });
		}
	});
}

export function sendStatusCount(socketPath: string, sessionId: string, nestedCount: number): void {
	const socket = net.connect(socketPath);
	socket.on("connect", () => {
		try {
			socket.end(`${JSON.stringify({ type: "status_count", sessionId, nestedCount })}\n`);
		} catch {
			/* ignore fire-and-forget failures */
		}
	});
	socket.on("error", () => {
		/* ignore fire-and-forget failures */
	});
}
