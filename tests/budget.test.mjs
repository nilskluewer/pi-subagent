import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runChild } from "../extensions/subagent/child.ts";
import { resolveSpec, writeMeta } from "../extensions/subagent/spec.ts";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const invocation = (args) => ({ command: process.execPath, args: [cli,
  "--offline", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-extensions",
  "-e", join(root, "tests/fixtures/budget-provider.ts"), ...args] });

// Oracle: user defaults are $10 and 100 turns. The fixture costs exactly $3 per
// response. A $5 threshold allows two responses ($6), but never a third ($9).
// Limits apply to each call, including retries, not the history loaded on resume.
// Wrong implementations: > instead of >=, parent-side kill races, reset on each
// tool turn, a lost error reason, or stopping without retaining the final usage.
async function run(t, params = {}, task = "loop", options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spec = resolveSpec({ task, model: "budget-fixture/loop", tools: "read", ...params }, dir, {});
  writeMeta(spec, dir);
  const result = await runChild({ spec, task, cwd: root, invocation, ...options });
  return { spec, result, dir };
}

test("real Pi child stops after the turn limit and preserves its last answer and exact usage", { timeout: 30000 }, async (t) => {
  const { spec, result } = await run(t, { maxTurns: 2, maxCost: 100 });
  assert.equal(result.status, "aborted");
  assert.equal(result.turns, 2);
  assert.equal(result.text, "Answer 2");
  assert.equal(result.usage.cost.total, 6);
  assert.match(result.errorMessage, /maxTurns.*2/);
  const entries = readFileSync(spec.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(entries.filter((entry) => entry.message?.role === "assistant").length, 2);
  assert.equal(entries.filter((entry) => entry.message?.role === "toolResult").length, 1);
});

test("real Pi child stops at the cost threshold, including equality", { timeout: 30000 }, async (t) => {
  for (const maxCost of [5, 6]) {
    const { result } = await run(t, { maxCost, maxTurns: 100 });
    assert.equal(result.status, "aborted");
    assert.equal(result.turns, 2);
    assert.equal(result.usage.cost.total, 6);
    assert.match(result.errorMessage, /maxCost/);
  }
});

test("default cost limit is $10", { timeout: 30000 }, async (t) => {
  const { result } = await run(t);
  assert.equal(result.status, "aborted");
  assert.equal(result.turns, 4);
  assert.equal(result.usage.cost.total, 12);
  assert.match(result.errorMessage, /maxCost.*10/);
});

test("default turn limit stops zero-priced models after 100 responses", { timeout: 30000 }, async (t) => {
  const { result } = await run(t, {}, "zero-cost loop");
  assert.equal(result.status, "aborted");
  assert.equal(result.turns, 100);
  assert.equal(result.usage.cost.total, 0);
  assert.match(result.errorMessage, /maxTurns.*100/);
});

test("a normal completion below both limits stays completed", { timeout: 30000 }, async (t) => {
  const { result } = await run(t, {}, "finish-now");
  assert.equal(result.status, "completed");
  assert.equal(result.turns, 1);
  assert.equal(result.usage.cost.total, 3);
  assert.equal(result.errorMessage, undefined);
});

test("resume gets a fresh per-call allowance without counting old usage twice", { timeout: 30000 }, async (t) => {
  const { spec, result, dir } = await run(t, { maxTurns: 2, maxCost: 100 });
  assert.equal(result.usage.cost.total, 6);
  const resumedSpec = resolveSpec({ task: "continue", resume: spec.sessionId, maxTurns: 1, maxCost: 4 }, dir, {});
  const resumed = await runChild({ spec: resumedSpec, task: "continue", cwd: root, invocation });
  assert.equal(resumed.status, "aborted");
  assert.equal(resumed.turns, 1);
  assert.equal(resumed.usage.cost.total, 3);
  assert.equal(resumed.text, "Answer 3");
  assert.match(resumed.errorMessage, /maxTurns.*1/);
});

test("automatic retries share the call's turn allowance", { timeout: 30000 }, async (t) => {
  const { result } = await run(t, { maxTurns: 2, maxCost: 100 }, "retry-loop");
  assert.equal(result.status, "aborted");
  assert.equal(result.turns, 2);
  assert.equal(result.usage.cost.total, 6);
  assert.match(result.errorMessage, /maxTurns.*2/);
});
