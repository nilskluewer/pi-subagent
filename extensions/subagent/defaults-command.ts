import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	canonicalModelReference,
	getSubagentConfigPath,
	isSubagentThinkingLevel,
	loadSubagentConfig,
	SUBAGENT_THINKING_LEVELS,
	type SubagentConfig,
	updateSubagentDefaults,
} from "./config.ts";

export type SubagentDefaultsCommandAction =
	| { kind: "show" }
	| { kind: "set-model"; value: string }
	| { kind: "set-thinking"; value: string }
	| { kind: "clear"; field?: "model" | "thinking" }
	| { kind: "interactive" }
	| { kind: "invalid"; message: string };

const TOP_LEVEL_COMMANDS = ["show", "status", "list", "model", "thinking", "clear", "reset"] as const;
const CLEAR_FIELDS = ["model", "thinking"] as const;
const NO_SCOPED_MODELS_WARNING =
	"This session has no scoped models. Configure a session model scope with Pi's --models option or the enabledModels setting before using the model picker.";

type CompletionItem = { value: string; label: string };

export function scopedModelReferences(
	scopedModels: readonly { model: { provider: string; id: string } }[],
): string[] {
	return [...new Set(scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`))].sort();
}

function completionItems(
	values: readonly string[],
	fragment: string,
	toItem: (value: string) => CompletionItem = (value) => ({ value, label: value }),
): CompletionItem[] | null {
	const lowerFragment = fragment.toLowerCase();
	const matching = values.filter((value) => value.toLowerCase().startsWith(lowerFragment));
	return matching.length > 0 ? matching.map(toItem) : null;
}

/**
 * Return completions whose values replace the complete argument text.
 * Scoped model references are supplied separately because Pi's completion callback
 * receives only the argument prefix, not an ExtensionCommandContext.
 */
export function getSubagentDefaultsArgumentCompletions(
	prefix: string,
	modelReferences: readonly string[] = [],
): CompletionItem[] | null {
	const text = prefix.trimStart();
	const withoutTrailingWhitespace = text.trimEnd();
	const hasTrailingWhitespace = withoutTrailingWhitespace.length !== text.length;
	if (!withoutTrailingWhitespace) return completionItems(TOP_LEVEL_COMMANDS, "");

	const words = withoutTrailingWhitespace.split(/\s+/);
	if (words.length === 1 && !hasTrailingWhitespace) return completionItems(TOP_LEVEL_COMMANDS, words[0]);

	const command = words[0].toLowerCase();
	const argument = words.length > 1 ? words[1] : "";
	if (command === "thinking") {
		if (hasTrailingWhitespace && words.length > 1) return null;
		const options = [...SUBAGENT_THINKING_LEVELS, "clear"];
		return completionItems(options, argument, (value) => ({ value: `thinking ${value}`, label: value }));
	}
	if (command === "clear") {
		if (hasTrailingWhitespace && words.length > 1) return null;
		return completionItems(CLEAR_FIELDS, argument, (value) => ({ value: `clear ${value}`, label: value }));
	}
	if (command === "model") {
		if (hasTrailingWhitespace && words.length > 1) return null;
		const options = [...new Set([...modelReferences, "clear"])]
			.sort((left, right) => left.localeCompare(right));
		return completionItems(options, argument, (value) => ({ value: `model ${value}`, label: value }));
	}
	return null;
}

export function parseSubagentDefaultsCommand(args: string): SubagentDefaultsCommandAction {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "interactive" };

	const words = trimmed.split(/\s+/);
	const command = words[0].toLowerCase();
	if (command === "show" || command === "status" || command === "list") {
		return words.length === 1
			? { kind: "show" }
			: { kind: "invalid", message: `Unexpected arguments after "${words[0]}".` };
	}
	if (command === "clear" || command === "reset") {
		if (words.length === 1) return { kind: "clear" };
		if (words.length === 2 && (words[1] === "model" || words[1] === "thinking")) {
			return { kind: "clear", field: words[1] };
		}
		return { kind: "invalid", message: "Use clear, clear model, or clear thinking." };
	}
	if (command === "model") {
		if (words.length !== 2) return { kind: "invalid", message: "Usage: /subagent-defaults model <provider/model-id> (or model clear)." };
		return words[1].toLowerCase() === "clear" ? { kind: "clear", field: "model" } : { kind: "set-model", value: words[1] };
	}
	if (command === "thinking") {
		if (words.length !== 2) return { kind: "invalid", message: "Usage: /subagent-defaults thinking <off|minimal|low|medium|high|xhigh|max> (or thinking clear)." };
		return words[1].toLowerCase() === "clear" ? { kind: "clear", field: "thinking" } : { kind: "set-thinking", value: words[1].toLowerCase() };
	}

	return {
		kind: "invalid",
		message:
			"Usage: /subagent-defaults [show|model <provider/model-id>|thinking <level>|clear [model|thinking]|reset].",
	};
}

export function formatSubagentDefaults(config: Pick<SubagentConfig, "defaultModel" | "defaultThinkingLevel">): string {
	return [
		`Subagent default model: ${config.defaultModel ?? "(Pi child-process default)"}`,
		`Subagent default thinking: ${config.defaultThinkingLevel ?? "(Pi child-process default)"}`,
		`Config: ${getSubagentConfigPath()}`,
	].join("\n");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else if (ctx.mode === "print") process.stdout.write(`${message}\n`);
}

async function setModel(ctx: ExtensionCommandContext, reference: string): Promise<void> {
	const canonical = canonicalModelReference(reference, ctx.modelRegistry);
	if (!canonical) {
		notify(ctx, `Unknown model "${reference}". Use an exact provider/model-id from Pi's current model registry.`, "error");
		return;
	}
	const result = await updateSubagentDefaults({ defaultModel: canonical });
	if (!result.ok) {
		notify(ctx, result.error, "error");
		return;
	}
	notify(ctx, `Subagent default model set to ${canonical}. The main agent model was not changed.`, "info");
}

async function setThinking(ctx: ExtensionCommandContext, value: string): Promise<void> {
	if (!isSubagentThinkingLevel(value)) {
		notify(ctx, `Unknown thinking level "${value}". Use ${SUBAGENT_THINKING_LEVELS.join(" | ")}.`, "error");
		return;
	}
	const result = await updateSubagentDefaults({ defaultThinkingLevel: value });
	if (!result.ok) {
		notify(ctx, result.error, "error");
		return;
	}
	notify(ctx, `Subagent default thinking set to ${value}.`, "info");
}

async function clearDefaults(ctx: ExtensionCommandContext, field?: "model" | "thinking"): Promise<void> {
	const patch = field === "model"
		? { defaultModel: null }
		: field === "thinking"
			? { defaultThinkingLevel: null }
			: { defaultModel: null, defaultThinkingLevel: null };
	const result = await updateSubagentDefaults(patch);
	if (!result.ok) {
		notify(ctx, result.error, "error");
		return;
	}
	const target = field ? `Subagent default ${field} cleared.` : "Subagent model and thinking defaults cleared.";
	notify(ctx, target, "info");
}

async function interactive(ctx: ExtensionCommandContext): Promise<void> {
	const choice = await ctx.ui.select("Subagent defaults", [
		"Show current values",
		"Set default model",
		"Set default thinking level",
		"Clear default model",
		"Clear default thinking level",
		"Reset both defaults",
	]);
	if (!choice) return;
	if (choice === "Show current values") {
		notify(ctx, formatSubagentDefaults(loadSubagentConfig()));
		return;
	}
	if (choice === "Clear default model") {
		await clearDefaults(ctx, "model");
		return;
	}
	if (choice === "Clear default thinking level") {
		await clearDefaults(ctx, "thinking");
		return;
	}
	if (choice === "Reset both defaults") {
		await clearDefaults(ctx);
		return;
	}
	if (choice === "Set default thinking level") {
		const level = await ctx.ui.select("Default subagent thinking level", [...SUBAGENT_THINKING_LEVELS]);
		if (level) await setThinking(ctx, level);
		return;
	}

	const models = scopedModelReferences(ctx.scopedModels);
	if (models.length === 0) {
		notify(ctx, NO_SCOPED_MODELS_WARNING, "warning");
		return;
	}
	const model = await ctx.ui.select("Default subagent model", models);
	if (model) await setModel(ctx, model);
}

export async function handleSubagentDefaultsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const action = parseSubagentDefaultsCommand(args);
	if (action.kind === "interactive") {
		if (ctx.hasUI) await interactive(ctx);
		else notify(ctx, formatSubagentDefaults(loadSubagentConfig()));
		return;
	}
	if (action.kind === "show") {
		notify(ctx, formatSubagentDefaults(loadSubagentConfig()));
		return;
	}
	if (action.kind === "set-model") {
		await setModel(ctx, action.value);
		return;
	}
	if (action.kind === "set-thinking") {
		await setThinking(ctx, action.value);
		return;
	}
	if (action.kind === "clear") {
		await clearDefaults(ctx, action.field);
		return;
	}
	notify(ctx, action.message, "error");
}

export function registerSubagentDefaultsCommand(pi: ExtensionAPI): void {
	let scopedModelSnapshot: string[] = [];
	pi.on("session_start", (_event, ctx) => {
		scopedModelSnapshot = scopedModelReferences(ctx.scopedModels);
	});
	pi.registerCommand("subagent-defaults", {
		description: "Show or configure model and thinking defaults for future subagent calls",
		getArgumentCompletions: (prefix) =>
			getSubagentDefaultsArgumentCompletions(prefix, scopedModelSnapshot),
		handler: handleSubagentDefaultsCommand,
	});
}

