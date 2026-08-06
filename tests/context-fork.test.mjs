import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import {
  applyForkContext,
  describeForkSize,
  parseForkContext,
  sanitizeForFork,
  selectLastNTurns,
} from "../extensions/subagent/context-fork.ts";
import { resolveSpec } from "../extensions/subagent/subagent-tool.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function user(content, timestamp = 1) {
  return { role: "user", content, timestamp };
}

function assistant(content, timestamp = 2) {
  return { role: "assistant", content, api: "test", provider: "test", model: "test", usage, stopReason: "stop", timestamp };
}

test("parseForkContext parses none, all, and positive turn counts", () => {
  assert.deepEqual(parseForkContext(undefined), { mode: "none" });
  assert.deepEqual(parseForkContext("none"), { mode: "none" });
  assert.deepEqual(parseForkContext("all"), { mode: "all" });
  assert.deepEqual(parseForkContext("5"), { mode: "turns", n: 5 });
  assert.ok("error" in parseForkContext("0"));
  assert.ok("error" in parseForkContext("-1"));
  assert.ok("error" in parseForkContext("abc"));
  assert.ok("error" in parseForkContext("9".repeat(400)));
});

test("selectLastNTurns uses user messages as turn boundaries", () => {
  const messages = [user("u1"), assistant([{ type: "text", text: "a1" }]), user("u2"), assistant([{ type: "text", text: "a2" }]), user("u3"), assistant([{ type: "text", text: "a3" }])];

  assert.deepEqual(selectLastNTurns(messages, 1), messages.slice(4));
  assert.deepEqual(selectLastNTurns(messages, 5), messages);
  const noUsers = [assistant([{ type: "text", text: "a" }])];
  assert.deepEqual(selectLastNTurns(noUsers, 1), noUsers);
});

test("sanitizeForFork keeps user messages verbatim and filters assistant text", () => {
  const userMessage = user([{ type: "text", text: "hello" }], 10);
  const messages = [
    userMessage,
    assistant([{ type: "toolCall", id: "tc1", name: "read", arguments: {} }], 11),
    assistant([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "visible" }], 12),
    { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "tool" }], isError: false, timestamp: 13 },
    { role: "bashExecution", command: "ls", output: "out", exitCode: 0, cancelled: false, truncated: false, timestamp: 14 },
    { role: "custom", customType: "x", content: "custom", display: true, timestamp: 15 },
    { role: "compactionSummary", summary: "compacted", tokensBefore: 100, timestamp: 16 },
    { role: "branchSummary", summary: "branched", fromId: "e1", timestamp: 17 },
  ];

  const sanitized = sanitizeForFork(messages);

  assert.deepEqual(sanitized[0], userMessage);
  assert.equal(sanitized.some((message) => message.role === "toolResult"), false);
  assert.equal(sanitized.some((message) => message.role === "bashExecution"), false);
  assert.equal(sanitized.some((message) => message.role === "custom"), false);
  assert.deepEqual(sanitized[1].content, [{ type: "text", text: "visible" }]);
  assert.equal(sanitized[2].role, "user");
  assert.match(sanitized[2].content, /\[Earlier context summary\]\ncompacted/);
  assert.match(sanitized[3].content, /\[Earlier context summary\]\nbranched/);
});

test("describeForkSize labels and warns with calibration", () => {
  assert.deepEqual(describeForkSize(1999), { label: "small" });
  assert.deepEqual(describeForkSize(5000), { label: "medium" });
  const large = describeForkSize(8001);

  assert.equal(large.label, "large");
  assert.match(large.warning, /~2k/);
  assert.match(large.warning, /~8k/);
  assert.match(large.warning, /forkContext:<N>/);
});

test("applyForkContext writes sanitized messages to a child session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-fork-"));
  try {
    const parentPath = path.join(dir, "parent.jsonl");
    const childPath = path.join(dir, "child.jsonl");
    const parent = SessionManager.open(parentPath, undefined, dir);
    parent.appendMessage(user("first"));
    parent.appendMessage(assistant([{ type: "thinking", thinking: "hidden" }, { type: "toolCall", id: "tc1", name: "read", arguments: {} }, { type: "text", text: "visible" }]));
    parent.appendMessage({ role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "tool" }], isError: false, timestamp: Date.now() });

    const result = await applyForkContext({ sessionFile: childPath, cwd: dir, forkContext: { mode: "all" } }, { mode: "all" }, parent);
    assert.equal(result.warning, undefined);
    assert.equal(result.forkedFrom, parentPath);

    const child = SessionManager.open(childPath, undefined, dir);
    const messages = child.buildContextEntries().flatMap(sessionEntryToContextMessages);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.deepEqual(messages[1].content, [{ type: "text", text: "visible" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyForkContext warns for ephemeral parents and zero assistant history", async () => {
  const ephemeral = SessionManager.inMemory(process.cwd());
  const ephemeralResult = await applyForkContext({ sessionFile: "/tmp/unused.jsonl", cwd: process.cwd(), forkContext: { mode: "all" } }, { mode: "all" }, ephemeral);
  assert.match(ephemeralResult.warning, /no session/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-fork-"));
  try {
    const parent = SessionManager.open(path.join(dir, "parent.jsonl"), undefined, dir);
    parent.appendMessage(user("only user"));
    const childPath = path.join(dir, "child.jsonl");
    const zeroAssistant = await applyForkContext({ sessionFile: childPath, cwd: dir, forkContext: { mode: "all" } }, { mode: "all" }, parent);
    assert.match(zeroAssistant.warning, /no prior assistant/);
    assert.equal(fs.existsSync(childPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyForkContext returns the large fork warning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-fork-"));
  try {
    const parent = SessionManager.open(path.join(dir, "parent.jsonl"), undefined, dir);
    parent.appendMessage(user("start"));
    parent.appendMessage(assistant([{ type: "text", text: "x".repeat(40000) }]));
    const result = await applyForkContext({ sessionFile: path.join(dir, "child.jsonl"), cwd: dir, forkContext: { mode: "all" } }, { mode: "all" }, parent);
    assert.match(result.warning, /large context/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSpec ignores forkContext placeholders on a resume call", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-resume-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const sessionsDir = path.join(dir, "subagent-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "session-1.jsonl"), "");
    fs.writeFileSync(path.join(sessionsDir, "session-1.meta.json"), JSON.stringify({ name: "prior", systemPrompt: "prior" }));

    const result = resolveSpec({ resume: "session-1", forkContext: "all", task: "continue" }, [], 0);

    assert.ok("spec" in result);
    assert.equal(result.spec.isResume, true);
    assert.deepEqual(result.spec.forkContext, { mode: "none" });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSpec falls back to the inline persona when placeholder fields are filled", () => {
  const result = resolveSpec(
    { agent: "general", resume: " ", systemPrompt: "You are a helper", name: "helper", task: "work" },
    [],
    0,
  );

  assert.ok("spec" in result);
  assert.equal(result.spec.source, "inline");
  assert.equal(result.spec.name, "helper");
});

test("resolveSpec still reports an unknown named agent when no inline persona is given", () => {
  const result = resolveSpec({ agent: "general", task: "work" }, [], 0);

  assert.ok("error" in result);
  assert.match(result.error, /Unknown agent/);
});
