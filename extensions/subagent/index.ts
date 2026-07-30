/**
 * Subagent extension entry point.
 *
 * Loads in the parent TUI and in every spawned subagent process (global
 * extension discovery applies to children too):
 * - The permission gate is registered everywhere (see gate.ts).
 * - The subagent tool is registered when the current depth is below the
 *   configured maxDepth. The root reads tree policy from config; children use
 *   inherited PI_SUBAGENT_* policy env values so the tree is fixed by the root.
 * - Children inherit the parent's tool set by default (see
 *   inherited-tools.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate.ts";
import { setActiveToolsProvider } from "./inherited-tools.ts";
import { DEFAULT_BUDGET_ACQUIRE_TIMEOUT_MS, DEFAULT_MAX_DEPTH, DEFAULT_MAX_LIVE_CHILDREN, loadSubagentConfig, shouldRegisterSubagentTools, treePolicyFromEnv } from "./config.ts";
import { registerSubagentTool } from "./subagent-tool.ts";

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
	registerGate(pi);
	setActiveToolsProvider(() => pi.getActiveTools());
	pi.on("session_start", () => {
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
