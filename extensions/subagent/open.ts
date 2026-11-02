/** Open a normal Pi session without replacing the parent's extension runtime. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { piInvocation } from "./child.ts";
import { sessionsDir } from "./spec.ts";
import type { Worker } from "./workers.ts";

export interface OpenTarget {
	file: string;
	cwd: string;
	fork: boolean;
}

/** No shell interpolation and no prompt: opening a session does not call a model. */
export async function runInteractiveSession(target: OpenTarget): Promise<void> {
	const launch = piInvocation([target.fork ? "--fork" : "--session", target.file]);
	const env = { ...process.env };
	for (const key of ["PI_SUBAGENT", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION_ID", "PI_SUBAGENT_INHERITED_TOOLS", "PI_SUBAGENT_MAX_COST", "PI_SUBAGENT_MAX_TURNS"]) delete env[key];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(launch.command, launch.args, { cwd: target.cwd, env, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`Pi exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
		});
	});
}

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");

export function createSubagentOpener(getWorkers: () => Worker[], launch = runInteractiveSession) {
	let opening = false;
	return async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Open subagent requires a terminal.", "warning");
			return;
		}
		if (opening) return;
		opening = true;
		try {
			const workers = [...new Map(getWorkers().map((worker) => [worker.sessionId, worker])).values()].reverse();
			if (!workers.length) {
				ctx.ui.notify("No subagent sessions.", "info");
				return;
			}
			const choices = workers.map((worker) => `${clean(worker.name)} · ${worker.status} · ${worker.sessionId}`);
			const selected = await ctx.ui.select("open subagent", choices);
			if (selected === undefined) return;
			const worker = workers[choices.indexOf(selected)];
			if (!worker) return;
			const file = worker.sessionFile ?? join(sessionsDir(), `${worker.sessionId}.jsonl`);
			if (!existsSync(file)) throw new Error("Subagent session file is missing. Try again after its first response.");
			// Check AFTER the picker: the parent can start/resume work while it is open.
			const fork = !ctx.isIdle() || getWorkers().some((worker) => worker.status === "running");
			await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
				tui.stop();
				process.stdout.write("\x1b[2J\x1b[H");
				void Promise.resolve().then(() => launch({ file, cwd: worker.cwd ?? ctx.cwd, fork })).then(
					() => finish(),
					(error) => finish(error),
				);
				function finish(error?: unknown) {
					tui.start();
					tui.requestRender(true);
					done();
					if (error) ctx.ui.notify(`Cannot open subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return { render: () => [], invalidate() {} };
			});
		} catch (error) {
			ctx.ui.notify(`Cannot open subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			opening = false;
		}
	};
}
