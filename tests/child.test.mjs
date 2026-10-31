import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { buildArgs, createAccumulator, runChild } from "../extensions/subagent/child.ts";
import { buildContent, describeUsage } from "../extensions/subagent/index.ts";

const usage = (total, input = 10, output = 5) => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
});
const assistant = (text, extra = {}) =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text }], usage: usage(0.01), stopReason: "stop", ...extra } });

test("accumulator sums usage across assistant messages and keeps the last text", () => {
  const acc = createAccumulator();
  acc.push(assistant("first"));
  acc.push(JSON.stringify({ type: "message_end", message: { role: "toolResult", usage: usage(9) } }));
  acc.push(assistant("second"));
  acc.push("not json");
  assert.equal(acc.result.turns, 2);
  assert.equal(acc.result.text, "second");
  assert.equal(acc.result.model, "p/m");
  assert.equal(acc.result.usage.cost.total.toFixed(4), "0.0200");
  assert.equal(acc.result.usage.input, 20);
  assert.equal(acc.result.usage.totalTokens, 30);
});

test("accumulator: a later successful message clears an earlier error", () => {
  const acc = createAccumulator();
  acc.push(assistant("", { stopReason: "error", errorMessage: "overloaded" }));
  assert.deepEqual([acc.result.status, acc.result.errorMessage], ["error", "overloaded"]);
  acc.push(assistant("ok"));
  assert.deepEqual([acc.result.status, acc.result.errorMessage], ["completed", undefined]);
});

test("accumulator tracks the current tool for progress", () => {
  const acc = createAccumulator();
  assert.equal(acc.push(JSON.stringify({ type: "tool_execution_start", toolName: "bash" })), true);
  assert.equal(acc.progress().tool, "bash");
  acc.push(JSON.stringify({ type: "tool_execution_end" }));
  assert.equal(acc.progress().tool, undefined);
});

test("stream snapshots replace pending usage and message_end commits it only once", () => {
  const acc = createAccumulator();
  const emit = (event) => acc.push(JSON.stringify(event));
  emit({ type: "message_start", message: { role: "assistant", provider: "live", model: "worker" } });
  assert.equal(acc.progress().model, "live/worker");
  emit({ type: "thinking_level_changed", level: "high" });
  assert.equal(acc.progress().thinking, "high");
  emit({ type: "message_update", usage: usage(0.02, 20, 2), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " } });
  emit({ type: "message_update", usage: usage(0.03, 20, 3), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" } });
  assert.equal(acc.progress().usage.cost.total, 0.03);
  assert.equal(acc.progress().preview, "Hello world");
  emit({ type: "message_update", usage: usage(0.03), assistantMessageEvent: { type: "thinking_delta", delta: "not normal text" } });
  assert.equal(acc.progress().preview, "Hello world");
  acc.push(assistant("Hello world", { usage: usage(0.04) }));
  assert.equal(acc.progress().usage.cost.total, 0.04);
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", usage: usage(0.01), assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Second" } });
  assert.equal(acc.progress().usage.cost.total, 0.05);
  assert.equal(acc.progress().preview, "Second");
  acc.push(assistant("Second", { usage: usage(0.02) }));
  assert.equal(acc.result.usage.cost.total, 0.06);
});

test("reported thinking replaces configured assumptions and empty aborted text preserves the last answer", () => {
  const acc = createAccumulator();
  acc.push(assistant("Previous answer", { thinkingLevel: "low" }));
  assert.equal(acc.progress().thinking, "low");
  acc.push(JSON.stringify({ type: "message_start", message: { role: "assistant", thinkingLevel: "off" } }));
  assert.equal(acc.progress().thinking, "off");
  acc.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "" } }));
  acc.finish();
  assert.equal(acc.result.text, "Previous answer");
});

test("parallel tool progress survives another tool ending", () => {
  const acc = createAccumulator();
  const emit = (event) => acc.push(JSON.stringify(event));
  emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts" } });
  emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "npm test" } });
  emit({ type: "tool_execution_end", toolCallId: "b" });
  assert.match(acc.progress().tool, /read.*a.ts/);
});

test("buildArgs keeps the task out of argv and omits unset options", () => {
  assert.deepEqual(buildArgs({ sessionFile: "/s.jsonl" }, "/t.md"), ["--mode", "json", "-p", "--session", "/s.jsonl", "@/t.md"]);
  assert.deepEqual(
    buildArgs({ sessionFile: "/s.jsonl", model: "a/b", thinking: "high", tools: ["read", "grep"] }, "/t.md", "/p.md"),
    ["--mode", "json", "-p", "--session", "/s.jsonl", "--model", "a/b", "--thinking", "high", "--tools", "read,grep", "--append-system-prompt", "/p.md", "@/t.md"],
  );
});

// A fake `pi`: node script whose behavior is chosen by the first line of the task file.
const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-")), "fake.mjs");
fs.writeFileSync(fake, `
import * as fs from "node:fs";
const task = fs.readFileSync(process.argv.at(-1).slice(1), "utf8");
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
const emit = (event) => console.log(JSON.stringify(event));
if (task.includes("hang")) { emit({ type: "tool_execution_start", toolName: "bash" }); setInterval(() => {}, 1000); }
else if (task.includes("crash")) { console.error("boom"); process.exit(3); }
else if (task.includes("stream")) {
  emit({ type: "message_start", message: { role: "assistant", provider: "p", model: "m" } });
  const bytes = Buffer.from(JSON.stringify({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Grüße 世界" } }) + "\\n");
  const index = bytes.indexOf(Buffer.from("ü")) + 1;
  process.stdout.write(bytes.subarray(0, index));
  setTimeout(() => { process.stdout.write(bytes.subarray(index)); setInterval(() => {}, 1000); }, 5);
}
else {
  emit({ type: "message_end", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "answer: " + task }], usage, stopReason: "stop" } });
}
`);
const spec = { name: "t", systemPrompt: "persona", sessionId: "id", sessionFile: "/tmp/x.jsonl" };
const invocation = (args) => ({ command: process.execPath, args: [fake, ...args] });

test("runChild returns text and exact usage from a child", async () => {
  const seen = [];
  const result = await runChild({ spec, task: "hello", cwd: process.cwd(), invocation, onProgress: (p) => seen.push(p.turns) });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "answer: Task: hello");
  assert.equal(result.usage.cost.total, 0.003);
  assert.deepEqual(seen, [1]);
});

test("dispatch is reported only after spawn, with UTF-8 streaming progress preserved on abort", async () => {
  const controller = new AbortController();
  let started = false;
  const result = await runChild({
    spec, task: "stream", cwd: process.cwd(), invocation, signal: controller.signal,
    onStarted: () => { started = true; },
    onProgress: (p) => { assert.equal(started, true); if (p.preview) controller.abort(); },
  });
  assert.equal(started, true);
  assert.equal(result.text, "Grüße 世界");
  assert.equal(result.status, "aborted");
  assert.equal(result.usage.cost.total, .003);
});

test("failed spawn does not report a successfully dispatched worker", async () => {
  let started = false;
  const result = await runChild({ spec, task: "t", cwd: process.cwd(), invocation: () => ({ command: "/no-such-pi-binary", args: [] }), onStarted: () => { started = true; } });
  assert.equal(started, false);
  assert.equal(result.status, "error");
});

test("runChild reports a non-zero exit as error with stderr", async () => {
  const result = await runChild({ spec, task: "crash", cwd: process.cwd(), invocation });
  assert.equal(result.status, "error");
  assert.match(result.errorMessage, /boom/);
});

test("abort kills the child and reports status aborted", async () => {
  const controller = new AbortController();
  const promise = runChild({ spec, task: "hang", cwd: process.cwd(), invocation, signal: controller.signal, onProgress: (p) => p.tool && controller.abort() });
  const result = await promise;
  assert.equal(result.status, "aborted");
  assert.match(result.errorMessage, /aborted/);
});

test("buildContent: header carries cost, failures carry the resume hint, long text is truncated", () => {
  const run = { status: "completed", text: "hi", usage: usage(0.0042), turns: 3, model: "p/m", stderr: "" };
  const ok = buildContent({ agent: "rev", sessionId: "abc", run });
  assert.match(ok.header, /agent: rev \| model: p\/m \| status: completed \| cost: \$0\.0042 \| turns: 3 \| session: abc/);
  assert.equal(ok.body, "hi");

  const aborted = buildContent({ agent: "rev", sessionId: "abc", run: { ...run, status: "aborted", errorMessage: "stopped" } });
  assert.match(aborted.body, /"resume":"abc"/);
  assert.match(aborted.body, /Partial output:\nhi/);

  const long = buildContent({ agent: "rev", sessionId: "abc", run: { ...run, text: "x".repeat(40_000) } }, "/o.md");
  assert.equal(long.truncated, true);
  assert.match(long.body, /read \/o\.md/);
});

test("describeUsage", () => {
  assert.equal(describeUsage(usage(0.5, 1500, 20), 1), "$0.5000 · 1 turn · ↑1.5k ↓20");
});
