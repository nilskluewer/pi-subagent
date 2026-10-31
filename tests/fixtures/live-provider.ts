/** Deterministic, offline provider for the real Pi TUI/codemode acceptance test. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("worker-fixture", {
		apiKey: "offline-test",
		api: "worker-fixture-api",
		baseUrl: "http://offline.invalid",
		models: ["main", "worker-a", "worker-b"].map((id) => ({
			id, name: id, api: "worker-fixture-api", reasoning: true, input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096,
		})),
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const message: any = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], stopReason: "pending", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const partial = () => structuredClone(message);
			void (async () => {
				stream.push({ type: "start", partial: partial() });
				const last = context.messages.filter((m) => m.role !== "system").at(-1);
				if (model.id === "main" && last?.role === "user" && !JSON.stringify(last.content).includes("Plain follow-up")) {
					const resume = JSON.stringify(last.content).includes("Resume offline fixture");
					const code = resume
						? `const runs = await Promise.all(load("fixture-workers").map(id => tools.subagent({resume: id, task: "Resume offline worker"}))); return runs.map(r => r.text);`
						: `const runs = await Promise.all(["a", "b"].map(id => tools.subagent({name: "worker-" + id, model: "worker-fixture/worker-" + id + ":medium", task: "Offline worker " + id, tools: "read"}))); store("fixture-workers", runs.map(r => r.sessionId)); return runs.map(r => r.text);`;
					const call = { type: "toolCall", id: "fixture-dispatch", name: "codemode", arguments: { code } };
					message.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: partial() });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call as any, partial: partial() });
					message.stopReason = "toolUse";
				} else {
					message.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: 0, partial: partial() });
					const chunks = model.id === "main" ? ["Fixture complete."] : ["Checking files. ", "Reading project settings. ", "Checking errors. ", "Worker complete."];
					for (const delta of chunks) {
						if (model.id !== "main") await new Promise((resolve) => setTimeout(resolve, Number(process.env.WORKER_FIXTURE_DELAY ?? 2000)));
						if (options?.signal?.aborted) { message.stopReason = "aborted"; message.errorMessage = "Aborted"; break; }
						message.content[0].text += delta;
						message.usage.input = 1000;
						message.usage.output += 100;
						message.usage.totalTokens = message.usage.input + message.usage.output;
						message.usage.cost.input = 0.001;
						message.usage.cost.output = message.usage.output / 1000000;
						message.usage.cost.total = message.usage.cost.input + message.usage.cost.output;
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial: partial() });
					}
					stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: partial() });
					if (message.stopReason === "pending") message.stopReason = "stop";
				}
				if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: partial() });
				else stream.push({ type: "done", reason: message.stopReason, message: partial() });
				stream.end();
			})().catch((error) => { message.stopReason = "error"; message.errorMessage = String(error); stream.push({ type: "error", reason: "error", error: partial() }); stream.end(); });
			return stream;
		},
	});
}
