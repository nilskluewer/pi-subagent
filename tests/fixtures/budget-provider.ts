/** Offline model: each response costs $3 and requests one read tool call. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("budget-fixture", {
		apiKey: "offline", api: "budget-fixture-api", baseUrl: "http://offline.invalid",
		models: [{ id: "loop", name: "loop", api: "budget-fixture-api", reasoning: false, input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const count = context.messages.filter((message) => message.role === "assistant").length;
			const zeroCost = JSON.stringify(context.messages).includes("zero-cost");
			const finish = count >= 105 || JSON.stringify(context.messages).includes("finish-now");
			const retry = JSON.stringify(context.messages).includes("retry-loop");
			const toolCall = { type: "toolCall" as const, id: `read-${count}`, name: "read", arguments: { path: "package.json" } };
			const message: any = {
				role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
				content: [{ type: "text", text: `Answer ${count + 1}` }, ...(finish || retry ? [] : [toolCall])],
				stopReason: retry ? "error" : finish ? "stop" : "toolUse",
				...(retry ? { errorMessage: "429 rate limit exceeded" } : {}),
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
					cost: { input: zeroCost ? 0 : 1, output: zeroCost ? 0 : 2, cacheRead: 0, cacheWrite: 0, total: zeroCost ? 0 : 3 } },
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
			if (!finish && !retry) stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: message });
			if (retry) stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: message.stopReason, message });
			stream.end();
			return stream;
		},
	});
}
