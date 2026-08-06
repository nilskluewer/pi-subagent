import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { approxTokens, capText, formatEnvelope, resolveResultCap } from "../extensions/subagent/result-cap.ts";
import { outputArtifactPath, writeOutputArtifact } from "../extensions/subagent/output-artifact.ts";
import { assembleSingleResultText, buildResultPayload, waitResultText } from "../extensions/subagent/subagent-tool.ts";

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

test("resolveResultCap uses call, config, and built-in precedence while preserving zero", () => {
  assert.equal(resolveResultCap(10, 15), 10);
  assert.equal(resolveResultCap(0, 15), 0);
  assert.equal(resolveResultCap(undefined, 15), 15);
  assert.equal(resolveResultCap(undefined, 0), 0);
  assert.equal(resolveResultCap(undefined, undefined), 1000);
});

test("each collected background run is formatted with its own result cap", () => {
  const longText = "x".repeat(100);
  const uncappedRun = {
    agent: "uncapped",
    sessionId: "uncapped-session",
    status: "done",
    resultCapTokens: 0,
    result: baseResult({ agent: "uncapped", sessionId: "uncapped-session", messages: [assistantText(longText)] }),
  };
  const cappedRun = {
    agent: "capped",
    sessionId: "capped-session",
    status: "done",
    resultCapTokens: 5,
    result: baseResult({ agent: "capped", sessionId: "capped-session", messages: [assistantText(longText)] }),
  };

  const output = waitResultText(
    { selected: [uncappedRun, cappedRun], settled: [uncappedRun, cappedRun], running: [], unknown: [], timedOut: false, aborted: false },
    1000,
    1000,
  );

  assert.ok(output.includes(assembleSingleResultText(uncappedRun.result, 0)));
  assert.match(output, /\[agent: capped/);
  assert.match(output, /\[truncated:/);
});

test("formatEnvelope includes header fields", () => {
  const output = formatEnvelope(
    { agent: "reviewer", agentSource: "inline", task: "review", sessionId: "s1", sessionFile: "/tmp/s1.jsonl", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, model: "m1" },
    { text: "payload", truncated: false, originalApproxTokens: 2 },
    { maxTokens: 10 },
  );

  assert.match(output, /\[agent: reviewer \| model: m1 \| status: completed \| turns: 0 \| session: s1\]/);
  assert.doesNotMatch(output, /cost:/);
  assert.match(output, /payload/);
});

test("formatEnvelope includes cost and turns and omits zero cost", () => {
  const output = formatEnvelope(
    {
      ...baseResult(),
      model: "m1",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0042, contextTokens: 0, turns: 3 },
    },
    { text: "payload", truncated: false, originalApproxTokens: 2 },
    { maxTokens: 10 },
  );

  assert.match(output, /status: completed \| cost: \$0\.0042 \| turns: 3 \| session: s1/);
});

test("formatEnvelope truncation notice points to artifact before resume", () => {
  const output = formatEnvelope(
    { agent: "reviewer", agentSource: "inline", task: "review", sessionId: "s1", sessionFile: "/tmp/s1.jsonl", outputFile: "/tmp/s1.output.md", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } },
    { text: "payload", truncated: true, originalApproxTokens: 50 },
    { maxTokens: 10 },
  );

  const artifactIndex = output.indexOf("Full output: read /tmp/s1.output.md");
  const resumeIndex = output.indexOf('resume session "s1"');
  assert.notEqual(artifactIndex, -1);
  assert.match(output, /normal read tool/);
  assert.match(output, /offsets to inspect parts/);
  assert.match(output, /of ~50 approx\. tokens/);
  assert.ok(artifactIndex < resumeIndex);
});

test("formatEnvelope explains no-session truncation recovery", () => {
  const output = formatEnvelope(
    { agent: "reviewer", agentSource: "inline", task: "review", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } },
    { text: "payload", truncated: true, originalApproxTokens: 50 },
    { maxTokens: 10 },
  );

  assert.match(output, /cannot resume or re-read/);
});

test("aborted output keeps its recovery format uncapped", () => {
  const aborted = baseResult({ agent: "aborted", exitCode: 1, stopReason: "aborted", messages: [assistantText("abort details")] });
  const output = assembleSingleResultText(aborted, 1);

  assert.match(output, /Subagent aborted before completion/);
  assert.doesNotMatch(output, /\[agent:/);
  assert.doesNotMatch(output, /\[truncated:/);
});

test("the artifact payload carries failure diagnostics when there is no assistant text", async () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-failure-artifact-test-"));
  try {
    const failure = baseResult({ exitCode: 1, stopReason: "error", stderr: "stderr details", forkWarning: "fork warning" });
    const payload = buildResultPayload(failure);
    const written = await writeOutputArtifact(sessionsDir, "s1", payload);

    assert.match(payload, /\[warning\] fork warning/);
    assert.match(payload, /Agent error: stderr details/);
    assert.equal(fs.readFileSync(written, "utf8"), payload);
    assert.match(assembleSingleResultText({ ...failure, outputFile: written }, 1), /Full output: read/);
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("an empty payload never creates an artifact file", async () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-empty-artifact-test-"));
  try {
    assert.equal(await writeOutputArtifact(sessionsDir, "s1", ""), undefined);
    assert.deepEqual(fs.readdirSync(sessionsDir), []);
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("unsafe session ids never write an artifact", async () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-unsafe-artifact-test-"));
  try {
    for (const sessionId of ["../escape", "a/b", "..\\\\b", "with\u0000null", "..", "/abs"]) {
      assert.equal(await writeOutputArtifact(sessionsDir, sessionId, "payload"), undefined);
      assert.deepEqual(fs.readdirSync(sessionsDir), []);
    }
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("an artifact write failure returns undefined without throwing", async () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-artifact-failure-test-")), "not-a-directory");
  fs.writeFileSync(filePath, "file");
  try {
    assert.equal(await writeOutputArtifact(filePath, "s1", "payload"), undefined);
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("the truncation notice falls back to the session file when no artifact was written", () => {
  const output = assembleSingleResultText(baseResult({ messages: [assistantText("x".repeat(100))] }), 5);
  assert.match(output, /JSONL tail/);
});

test("output artifact is written atomically with restrictive permissions", async () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-artifact-test-"));
  try {
    const output = "verbatim output\\nwith trailing text";
    const written = await writeOutputArtifact(sessionsDir, "s1", output);

    assert.equal(written, outputArtifactPath(sessionsDir, "s1"));
    assert.equal(fs.readFileSync(written, "utf8"), output);
    assert.equal(fs.statSync(written).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(sessionsDir), ["s1.output.md"]);
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
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
