/**
 * Subagent extension entry point.
 *
 * Loads in the parent TUI and in every spawned subagent process (global
 * extension discovery applies to children too):
 * - Dangerous-command policy is owned by the permission gate extension
 *   (`@nilskluewer/pi-auto-permission-gate`), which also loads in children.
 *   This extension only provides the parent-side approval coordinator that the
 *   gate talks to over `PI_SUBAGENT_COORDINATOR_SOCKET` (see
 *   `approval-server.ts` and `approval-protocol.ts`).
 * - The subagent tool is registered when the current depth is below the
 *   configured maxDepth. The root reads tree policy from config; children use
 *   inherited PI_SUBAGENT_* policy env values so the tree is fixed by the root.
 * - Children inherit the parent's tool set by default (see
 *   inherited-tools.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentDefaultsCommand } from "./defaults-command.ts";
import { registerSubagentStopCommand } from "./stop-command.ts";
import { setActiveToolsProvider } from "./inherited-tools.ts";
import { DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS, DEFAULT_MAX_DEPTH, DEFAULT_MAX_LIVE_CHILDREN, loadSubagentConfig, shouldRegisterSubagentTools, treePolicyFromEnv } from "./config.ts";
import { registerSubagentTool } from "./subagent-tool.ts";
import { clearBackgroundRuns, disposeBackgroundRuns } from "./background-runs.ts";
import {
	disposeSubagentPanel,
	getSubagentPanel,
	initializeSubagentPanel,
} from "./subagent-panel.ts";

function currentDepth(): number {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	return Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

function startParentDeathWatchdog(): void {
	if (!process.env.PI_SUBAGENT) return;
	const initialParentPid = process.ppid;
	const interval = setInterval(() => {
		if (process.ppid !== initialParentPid) process.exit(0);
	}, 5000);
	interval.unref?.();
}

export default function (pi: ExtensionAPI) {
	startParentDeathWatchdog();
	const focusSubagentPanel = (ctx: any) => {
		const panel = getSubagentPanel();
		if (!panel) {
			ctx.ui.notify("The subagent panel is available only in the interactive TUI.", "warning");
			return;
		}
		panel.togglePanelMode();
	};
	// F8 uses a standard function-key sequence that survives legacy terminal
	// mode, including a WezTerm plus tmux setup. Use Fn+F8 on MacBooks when
	// the function row is configured for media controls.
	pi.registerShortcut("f8", {
		description: "Focus the subagent panel",
		handler: focusSubagentPanel,
	});
	pi.registerCommand("subagent-panel", {
		description: "Focus the subagent panel",
		handler: async (_args, ctx) => focusSubagentPanel(ctx),
	});
	// Register this independently of depth so the command is available in the
	// root, child, UI, and headless extension runtimes alike.
	registerSubagentDefaultsCommand(pi);
	registerSubagentStopCommand(pi);
	setActiveToolsProvider(() => pi.getActiveTools());
	pi.on("session_shutdown", () => {
		disposeSubagentPanel();
		disposeBackgroundRuns();
		clearBackgroundRuns();
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui" && ctx.hasUI) initializeSubagentPanel(ctx);
		const depth = currentDepth();
		const treePolicy = depth > 0
			? treePolicyFromEnv(process.env, {
					maxDepth: DEFAULT_MAX_DEPTH,
					maxLiveChildren: DEFAULT_MAX_LIVE_CHILDREN,
					budgetAcquireTimeoutMs: DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS,
				})
			: loadSubagentConfig();
		if (shouldRegisterSubagentTools(depth, treePolicy.maxDepth)) {
			registerSubagentTool(pi);
		}
	});
}
