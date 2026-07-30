import assert from "node:assert/strict";
import test from "node:test";

import { approxTokens, capText, formatEnvelope, resolveResultCap } from "../extensions/subagent/result-cap.ts";
import {
  assembleChainFailureText,
  assembleChainSuccessText,
  assembleParallelResultText,
  assembleSingleResultText,
  getFinalOutput,
} from "../extensions/subagent/subagent-tool.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function baseResult(overrides = {}) {
  return {
    agent: "worker",
    agentSource: "inline",
    task: "task",
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    ...overrides,
  };
}

function assistantText(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("approxTokens rounds up length divided by four", () => {
  assert.equal(approxTokens(""), 0);
  assert.equal(approxTokens("abcd"), 1);
  assert.equal(approxTokens("abcde"), 2);
});

test("capText leaves short text unchanged", () => {
  assert.deepEqual(capText("short", 10), { text: "short", truncated: false, originalApproxTokens: 2 });
});

test("capText truncates long text", () => {
  const result = capText("x".repeat(100), 10);

  assert.equal(result.truncated, true);
  assert.equal(result.originalApproxTokens, 25);
  assert.ok(approxTokens(result.text) <= 10);
});

test("capText treats zero as disabled", () => {
  const text = "x".repeat(100);

  assert.deepEqual(capText(text, 0), { text, truncated: false, originalApproxTokens: 25 });
});

test("capText does not split multi-byte emoji surrogate pairs", () => {
  const result = capText("😀".repeat(20), 3);

  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.text, /\uD800|\uDFFF/);
  assert.ok(result.text.endsWith("😀"));
});

test("resolveResultCap uses item, call, config, built-in precedence and preserves zero", () => {
  assert.equal(resolveResultCap(5, 10, 15), 5);
  assert.equal(resolveResultCap(0, 10, 15), 0);
  assert.equal(resolveResultCap(undefined, 10, 15), 10);
  assert.equal(resolveResultCap(undefined, 0, 15), 0);
  assert.equal(resolveResultCap(undefined, undefined, 15), 15);
  assert.equal(resolveResultCap(undefined, undefined, 0), 0);
  assert.equal(resolveResultCap(undefined, undefined, undefined), 1000);
});

test("formatEnvelope includes header fields", () => {
  const output = formatEnvelope(
    { agent: "reviewer", agentSource: "inline", task: "review", sessionId: "s1", sessionFile: "/tmp/s1.jsonl", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, model: "m1" },
    { text: "payload", truncated: false, originalApproxTokens: 2 },
    { maxTokens: 10 },
  );

  assert.match(output, /\[agent: reviewer \| model: m1 \| status: completed \| session: s1\]/);
  assert.match(output, /payload/);
});

test("formatEnvelope truncation notice points to file path first and resume second", () => {
  const output = formatEnvelope(
    { agent: "reviewer", agentSource: "inline", task: "review", sessionId: "s1", sessionFile: "/tmp/s1.jsonl", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } },
    { text: "payload", truncated: true, originalApproxTokens: 50 },
    { maxTokens: 10 },
  );

  assert.match(output, /Full output: read \/tmp\/s1\.jsonl directly/);
  assert.match(output, /resume session "s1"/);
});

test("formatEnvelope explains no-session truncation recovery", () => {
  const output = formatEnvelope(
    { agent: "reviewer", agentSource: "inline", task: "review", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } },
    { text: "payload", truncated: true, originalApproxTokens: 50 },
    { maxTokens: 10 },
  );

  assert.match(output, /cannot resume or re-read/);
});

test("chain non-aborted failure is capped and enveloped", () => {
  const output = assembleChainFailureText(
    baseResult({ agent: "failing", exitCode: 1, stderr: "failure-" + "x".repeat(200), model: "m1" }),
    2,
    10,
  );

  assert.match(output, /Chain stopped at step 2 \(failing\): \[agent: failing \| model: m1 \| status: failed \| session: s1\]/);
  assert.match(output, /\[truncated:/);
  assert.doesNotMatch(output, /x{100}/);
});

test("aborted chain failure keeps recovery format uncapped", () => {
  const output = assembleChainFailureText(
    baseResult({ agent: "aborted", exitCode: 1, stopReason: "aborted", messages: [assistantText("aborted activity " + "x".repeat(200))] }),
    3,
    1,
  );

  assert.match(output, /Chain stopped at step 3 \(aborted\): Subagent aborted before completion/);
  assert.doesNotMatch(output, /\[agent:/);
  assert.doesNotMatch(output, /\[truncated:/);
  assert.match(output, /aborted activity/);
});

test("parallel output honors per-item caps over call-level caps", () => {
  const callLevelCap = 5;
  const itemCaps = [resolveResultCap(undefined, callLevelCap, undefined), resolveResultCap(0, callLevelCap, undefined)];
  const output = assembleParallelResultText(
    [
      baseResult({ agent: "small", sessionId: "s1", sessionFile: "/tmp/s1.jsonl", messages: [assistantText("small-" + "x".repeat(100))] }),
      baseResult({ agent: "uncapped", sessionId: "s2", sessionFile: "/tmp/s2.jsonl", messages: [assistantText("uncapped-" + "y".repeat(100))] }),
    ],
    itemCaps,
  );

  assert.match(output, /Parallel: 2\/2 succeeded/);
  assert.match(output, /\[agent: small/);
  assert.match(output, /\[truncated:/);
  assert.match(output, /\[agent: uncapped/);
  assert.match(output, /uncapped-yyyyyyyyyyyyyyyyyyyy/);
});

test("chain previous handoff stays raw while final output is capped", () => {
  const previous = "previous-" + "p".repeat(200);
  const final = "final-" + "f".repeat(200);
  const previousResult = baseResult({ agent: "step-one", messages: [assistantText(previous)] });
  const finalResult = baseResult({ agent: "step-two", messages: [assistantText(final)] });

  assert.equal(getFinalOutput(previousResult.messages), previous);
  const output = assembleChainSuccessText([previousResult, finalResult], 10);

  assert.match(output, /\[agent: step-two/);
  assert.match(output, /\[truncated:/);
  assert.doesNotMatch(output, new RegExp(previous));
});

test("abort output is uncapped in single, parallel, and chain assemblies", () => {
  const aborted = baseResult({ agent: "aborted", exitCode: 1, stopReason: "aborted", messages: [assistantText("abort details")] });
  const single = assembleSingleResultText(aborted, 1);
  const parallel = assembleParallelResultText([aborted], [1]);
  const chain = assembleChainFailureText(aborted, 1, 1);

  for (const output of [single, parallel, chain]) {
    assert.match(output, /Subagent aborted before completion/);
    assert.doesNotMatch(output, /\[agent:/);
    assert.doesNotMatch(output, /\[truncated:/);
  }
});

test("fork warning appears in model-visible output text", () => {
  const output = assembleSingleResultText(
    baseResult({ forkWarning: "forkContext warning", messages: [assistantText("payload")] }),
    100,
  );

  assert.match(output, /\[warning\] forkContext warning/);
  assert.match(output, /payload/);
});
