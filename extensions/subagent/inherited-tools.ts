/**
 * Tool inheritance from the parent agent into a spawned subagent.
 *
 * Extension tools that are only *registered* after an explicit in-session
 * activation (MCP bridges, for example) are invisible to a freshly spawned
 * child, even though the same extension is loaded there. Publishing the
 * parent's tool set lets those extensions re-activate the same selection
 * non-interactively, so a subagent starts with the tools the main agent has.
 *
 * Contract: `PI_SUBAGENT_INHERITED_TOOLS` holds a comma-separated list of tool
 * names. When the caller pinned an explicit allowlist for the subagent, that
 * allowlist is published instead of the parent's full set, so narrowing tools
 * also narrows what gets activated.
 */

export const INHERITED_TOOLS_ENV = "PI_SUBAGENT_INHERITED_TOOLS";

/**
 * Set once at extension load; lets the spawn path read the parent's live tool
 * set without threading the extension API through every call site.
 */
let activeToolsProvider: (() => string[]) | undefined;

export function setActiveToolsProvider(provider: () => string[]): void {
	activeToolsProvider = provider;
}

/** Env fragment for a child process, empty when there is nothing to inherit. */
export function inheritedToolsEnv(explicitTools?: string[]): Record<string, string> {
	const names = explicitTools && explicitTools.length > 0 ? explicitTools : (activeToolsProvider?.() ?? []);
	const unique = [...new Set(names.filter(Boolean))];
	return unique.length > 0 ? { [INHERITED_TOOLS_ENV]: unique.join(",") } : {};
}
