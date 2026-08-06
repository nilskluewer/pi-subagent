import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	canonicalModelSelection,
	formatModelSelection,
	getSubagentConfigPath,
	loadSubagentConfig,
	type SubagentConfig,
	updateSubagentDefaults,
} from "./config.ts";

export type SubagentDefaultsCommandAction =
	| { kind: "show" }
	| { kind: "set-model"; value: string }
	| { kind: "clear"; field?: "model" }
	| { kind: "interactive" }
	| { kind: "invalid"; message: string };

const TOP_LEVEL_COMMANDS = ["show", "status", "list", "model", "clear", "reset"] as const;
const CLEAR_FIELDS = ["model"] as const;
const NO_MODELS_WARNING = "No available models are configured for this Pi session.";

type ModelLike = {
	model: { provider: string; id: string };
	thinkingLevel?: string;
};

type CompletionItem = { value: string; label: string };

export function modelReferences(models: readonly ModelLike[]): string[] {
	return [...new Set(
		models.map(({ model, thinkingLevel }) => `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`),
	)].sort();
}

export function scopedModelReferences(scopedModels: readonly ModelLike[]): string[] {
	return modelReferences(scopedModels);
}

function currentModelReferences(ctx: ExtensionCommandContext): string[] {
	if (ctx.scopedModels.length > 0) return scopedModelReferences(ctx.scopedModels);
	return modelReferences(ctx.modelRegistry.getAvailable().map((model) => ({ model })));
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
	if (command === "clear") {
		if (hasTrailingWhitespace && words.length > 1) return null;
		return completionItems(CLEAR_FIELDS, argument, (value) => ({ value: `clear ${value}`, label: value }));
	}
	if (command === "model") {
		if (hasTrailingWhitespace && words.length > 1) return null;
		const options = [...new Set([...modelReferences, "clear"])].sort((left, right) => left.localeCompare(right));
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
		if (words.length === 2 && words[1] === "model") return { kind: "clear", field: "model" };
		return { kind: "invalid", message: "Use clear or clear model." };
	}
	if (command === "model") {
		if (words.length !== 2) return { kind: "invalid", message: "Usage: /subagent-defaults model <provider/model-id[:thinking]> (or model clear)." };
		return words[1].toLowerCase() === "clear" ? { kind: "clear", field: "model" } : { kind: "set-model", value: words[1] };
	}
	return {
		kind: "invalid",
		message: "Usage: /subagent-defaults [show|model <provider/model-id[:thinking]>|clear [model]|reset].",
	};
}

export function formatSubagentDefaults(config: Pick<SubagentConfig, "defaultModel" | "allowedModels">): string {
	const allowlist = config.allowedModels === undefined
		? "(not configured)"
		: config.allowedModels.length > 0
			? config.allowedModels.map((entry) => formatModelSelection(entry)).join(", ")
			: "(invalid or empty - resolution is blocked)";
	return [
		`Subagent default model: ${config.defaultModel ?? "(Pi child-process default)"}`,
		`Subagent model allowlist: ${allowlist}`,
		`Config: ${getSubagentConfigPath()}`,
	].join("\n");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else if (ctx.mode === "print") process.stdout.write(`${message}\n`);
}

async function setModel(ctx: ExtensionCommandContext, reference: string): Promise<void> {
	if (loadSubagentConfig().allowedModels !== undefined) {
		notify(ctx, "Subagent model allowlist is active; edit allowedModels instead of defaultModel.", "warning");
		return;
	}
	const canonical = canonicalModelSelection(reference, ctx.modelRegistry);
	if (!canonical) {
		notify(ctx, `Unknown model "${reference}". Use an exact provider/model-id[:thinking] from Pi's current model registry.`, "error");
		return;
	}
	const canonicalReference = formatModelSelection(canonical);
	const result = await updateSubagentDefaults({ defaultModel: canonicalReference });
	if (!result.ok) {
		notify(ctx, result.error, "error");
		return;
	}
	notify(ctx, `Subagent default model set to ${canonicalReference}. The main agent model was not changed.`, "info");
}

async function clearDefaults(ctx: ExtensionCommandContext): Promise<void> {
	const result = await updateSubagentDefaults({ defaultModel: null });
	if (!result.ok) {
		notify(ctx, result.error, "error");
		return;
	}
	notify(ctx, "Subagent default model cleared.", "info");
}

async function interactive(ctx: ExtensionCommandContext): Promise<void> {
	const choice = await ctx.ui.select("Subagent defaults", [
		"Show current values",
		"Set default model",
		"Clear default model",
		"Reset default model",
	]);
	if (!choice) return;
	if (choice === "Show current values") {
		notify(ctx, formatSubagentDefaults(loadSubagentConfig()));
		return;
	}
	if (choice === "Clear default model" || choice === "Reset default model") {
		await clearDefaults(ctx);
		return;
	}

	const models = currentModelReferences(ctx);
	if (models.length === 0) {
		notify(ctx, NO_MODELS_WARNING, "warning");
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
	if (action.kind === "clear") {
		await clearDefaults(ctx);
		return;
	}
	notify(ctx, action.message, "error");
}

export function registerSubagentDefaultsCommand(pi: ExtensionAPI): void {
	let modelSnapshot: string[] = [];
	pi.on("session_start", (_event, ctx) => {
		modelSnapshot = currentModelReferences(ctx);
	});
	pi.registerCommand("subagent-defaults", {
		description: "Show or configure the subagent model default",
		getArgumentCompletions: (prefix) => getSubagentDefaultsArgumentCompletions(prefix, modelSnapshot),
		handler: handleSubagentDefaultsCommand,
	});
}
