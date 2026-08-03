/**
 * Wire format of the parent-side approval channel.
 *
 * This extension no longer classifies dangerous tool calls itself. Policy lives
 * in the permission gate extension (`@nilskluewer/pi-auto-permission-gate`),
 * which loads in the parent TUI and in every subagent child process. When a
 * child needs a manual confirmation, the gate sends one JSON line of this shape
 * to `PI_SUBAGENT_COORDINATOR_SOCKET`, and the coordinator in the parent replies
 * with one JSON line `{ id, allow }` after prompting the user.
 *
 * Keep this type and the client in the permission gate extension in sync.
 */

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
