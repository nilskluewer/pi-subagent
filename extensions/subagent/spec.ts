/**
 * Turn tool-call parameters into a launch spec: persona, model, tools, and
 * the session to run in. Sources of a persona (exactly one):
 *   - `resume`:       continue an earlier run; persona comes from its meta file
 *   - `agent`:        markdown file in ~/.pi/agent/agents/<name>.md
 *   - `systemPrompt`: inline persona (default: empty)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface SubagentParams {
	task: string;
	agent?: string;
	systemPrompt?: string;
	name?: string;
	model?: string;
	tools?: string;
	resume?: string;
	cwd?: string;
}

export interface Spec {
	name: string;
	systemPrompt: string;
	/** `provider/model-id` without the thinking suffix. */
	model?: string;
	thinking?: string;
	tools?: string[];
	sessionId: string;
	sessionFile: string;
	isResume: boolean;
}

interface Meta {
	name: string;
	systemPrompt: string;
	model?: string;
	tools?: string[];
	thinking?: string;
}

export const sessionsDir = (): string => path.join(getAgentDir(), "subagent-sessions");

/** Models fill unused optional fields with "" or [] — treat those as absent. */
const clean = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

const parseList = (value: string | undefined): string[] | undefined => {
	const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
	return items && items.length > 0 ? items : undefined;
};

/** Split `provider/model[:thinking]`. Only a known thinking level counts as suffix. */
export function splitModel(spec: string | undefined): { model?: string; thinking?: string } {
	if (!spec) return {};
	const index = spec.lastIndexOf(":");
	const suffix = index >= 0 ? spec.slice(index + 1) : "";
	if ((THINKING_LEVELS as readonly string[]).includes(suffix)) return { model: spec.slice(0, index), thinking: suffix };
	return { model: spec };
}

/** Optional `~/.pi/agent/subagent.json`: `{ defaultModel?, allowedModels? }`, read on every call. */
export function readConfig(file = path.join(getAgentDir(), "subagent.json")): {
	defaultModel?: string;
	allowedModels?: string[];
} {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		const allowed = Array.isArray(raw.allowedModels)
			? raw.allowedModels.filter((m: unknown): m is string => typeof m === "string" && m.trim() !== "")
			: undefined;
		// An empty or malformed allowlist fails closed: nothing is allowed.
		const allowedModels = "allowedModels" in raw ? (allowed ?? []) : undefined;
		return { defaultModel: clean(raw.defaultModel), allowedModels };
	} catch {
		return {};
	}
}

/** Pick the model and enforce the optional allowlist (exact `provider/model[:thinking]` match). */
export function selectModel(
	requested: string | undefined,
	config: { defaultModel?: string; allowedModels?: string[] },
): string | undefined {
	const { allowedModels } = config;
	if (!allowedModels) return requested ?? config.defaultModel;
	const chosen = requested ?? allowedModels[0];
	if (!chosen || !allowedModels.includes(chosen)) {
		const list = allowedModels.length > 0 ? allowedModels.join(", ") : "(none configured)";
		throw new Error(`Model "${chosen ?? ""}" is not allowed by subagent.json. Allowed: ${list}`);
	}
	return chosen;
}

function loadAgent(name: string, dir = path.join(getAgentDir(), "agents")): Omit<Meta, "name"> & { name: string } {
	const file = path.join(dir, `${name}.md`);
	if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file)) {
		const available = fs.existsSync(dir)
			? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).join(", ")
			: "";
		throw new Error(`Unknown agent "${name}". Available: ${available || "none"}`);
	}
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(fs.readFileSync(file, "utf-8"));
	return {
		name: frontmatter.name || name,
		systemPrompt: body.trim(),
		model: clean(frontmatter.model),
		tools: parseList(frontmatter.tools),
	};
}

export function resolveSpec(params: SubagentParams, dir = sessionsDir(), config = readConfig()): Spec {
	const agent = clean(params.agent);
	const systemPrompt = clean(params.systemPrompt);
	const resume = clean(params.resume);
	if ([agent, systemPrompt, resume].filter(Boolean).length > 1) {
		throw new Error("Pass at most one of: agent, systemPrompt, resume.");
	}

	let base: Meta;
	let sessionId: string;
	if (resume) {
		if (!/^[\w-]+$/.test(resume)) throw new Error(`Invalid session id "${resume}".`);
		sessionId = resume;
		try {
			base = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.meta.json`), "utf-8"));
		} catch {
			throw new Error(`Cannot resume "${resume}": no metadata found in ${dir}.`);
		}
		if (!fs.existsSync(path.join(dir, `${sessionId}.jsonl`))) throw new Error(`Cannot resume "${resume}": session file is missing.`);
	} else {
		sessionId = crypto.randomUUID();
		base = agent ? loadAgent(agent) : { name: clean(params.name) ?? "subagent", systemPrompt: systemPrompt ?? "" };
	}

	// Call > persona (agent file or resumed meta) > subagent.json default.
	const personaModel =
		base.model && base.thinking && !base.model.endsWith(`:${base.thinking}`) ? `${base.model}:${base.thinking}` : base.model;
	const requested = clean(params.model) ?? personaModel;
	const { model, thinking } = splitModel(selectModel(requested, config));
	const tools = parseList(params.tools) ?? base.tools;

	return {
		name: clean(params.name) ?? base.name,
		systemPrompt: base.systemPrompt,
		model,
		thinking,
		tools,
		sessionId,
		sessionFile: path.join(dir, `${sessionId}.jsonl`),
		isResume: Boolean(resume),
	};
}

/** Persist the persona so `resume` can re-apply it (--append-system-prompt is not stored in the session). */
export function writeMeta(spec: Spec, dir = sessionsDir()): void {
	fs.mkdirSync(dir, { recursive: true });
	const meta: Meta = {
		name: spec.name,
		systemPrompt: spec.systemPrompt,
		model: spec.model,
		thinking: spec.thinking,
		tools: spec.tools,
	};
	fs.writeFileSync(path.join(dir, `${spec.sessionId}.meta.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
}
