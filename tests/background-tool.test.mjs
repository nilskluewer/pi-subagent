import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  clearBackgroundRuns,
  getBackgroundRun,
  registerBackgroundRun,
} from "../extensions/subagent/background-runs.ts";
import {
  createWidgetTracker,
  registerSubagentTool,
} from "../extensions/subagent/subagent-tool.ts";
import { createSubagentPanelController } from "../extensions/subagent/subagent-panel.ts";

async function withTempAgentDir(fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-background-tool-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function registeredTools() {
  const definitions = [];
  registerSubagentTool({
    registerTool(definition) {
      definitions.push(definition);
    },
  });
  return definitions;
}

function registry() {
  return {
    find() {
      return undefined;
    },
    getAll() {
      return [];
    },
    getAvailable() {
      return [];
    },
  };
}

test.afterEach(() => {
  clearBackgroundRuns();
});

test("the widget tracker removes finished panel rows", () => {
  const panel = createSubagentPanelController();
  const tracker = createWidgetTracker({ hasUI: true, ui: { setWidget() {} } }, "widget", undefined, panel);
  tracker.add("panel-run", "worker", "provider/model", "Inspect the project");
  tracker.setTool("panel-run", "read src/index.ts");
  tracker.setUsage("panel-run", {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.0042,
    contextTokens: 30,
    turns: 1,
  });
  tracker.setNestedCount("panel-run", 2);

  const row = panel.getSelectedRow();
  assert.equal(row.name, "worker");
  assert.equal(row.status, "running");
  assert.equal(row.task, "Inspect the project");
  assert.equal(row.nestedCount, 2);
  assert.equal(row.usage.cost, 0.0042);
  assert.match(panel.getRows()[0].usage.cost.toFixed(4), /0\.0042/);

  tracker.finish("panel-run", true);

  assert.equal(panel.getRows().length, 0);
  panel.dispose();
});

test("the widget tracker clears its transient widget on finish", () => {
  const updates = [];
  const tracker = createWidgetTracker({
    hasUI: true,
    ui: { setWidget(id, lines) { updates.push({ id, lines }); } },
  }, "widget");

  tracker.add("run", "worker");
  tracker.setUsage("run", {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.0042,
    contextTokens: 30,
    turns: 1,
  });
  assert.match(updates.at(-1).lines.join("\n"), /\$0\.0042/);
  tracker.finish("run", true);

  assert.equal(updates.at(-1).id, "widget");
  assert.equal(updates.at(-1).lines, undefined);
});

test("subagent_stop aborts a running background session", async () => {
  await withTempAgentDir(async () => {
    let resolvePending;
    let stopCalled = false;
    const pending = new Promise((resolve) => {
      resolvePending = resolve;
    });
    const run = registerBackgroundRun({
      sessionId: "stop-me",
      agent: "worker",
      task: "stop",
      promise: pending,
      abort: () => {
        stopCalled = true;
        resolvePending({
          agent: "worker",
          agentSource: "inline",
          task: "stop",
          sessionId: "stop-me",
          exitCode: 1,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          stopReason: "aborted",
        });
      },
    });
    const stopTool = registeredTools().find((definition) => definition.name === "subagent_stop");
    const responsePromise = stopTool.execute("call", { id: "stop-me" });
    const repeatedPromise = stopTool.execute("call-2", { id: "stop-me" });
    const response = await responsePromise;
    const repeated = await repeatedPromise;

    assert.equal(stopCalled, true);
    assert.equal(run.stopRequested, true);
    assert.match(response.content[0].text, /Stop requested/);
    assert.match(repeated.content[0].text, /Stop already requested/);
    await run.promise;
    assert.equal(run.status, "failed");
    assert.equal(run.result.stopReason, "aborted");
  });
});

test("subagent_stop rejects an empty session id", async () => {
  await withTempAgentDir(async () => {
    const stopTool = registeredTools().find((definition) => definition.name === "subagent_stop");
    const response = await stopTool.execute("call", { id: "   " });

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /non-empty/);
  });
});

test("subagent_wait passes its AbortSignal and leaves aborted runs uncollected", async () => {
  await withTempAgentDir(async () => {
    const pending = new Promise(() => {});
    const run = registerBackgroundRun({
      sessionId: "wait-abort",
      agent: "worker",
      task: "wait",
      promise: pending,
    });
    const waitTool = registeredTools().find((definition) => definition.name === "subagent_wait");
    const controller = new AbortController();
    const waiting = waitTool.execute("call", { id: "wait-abort", timeoutMs: 600_000 }, controller.signal);

    controller.abort();
    const response = await waiting;
    const text = response.content[0].text;

    assert.match(text, /aborted/);
    assert.match(text, /Still running: worker \(wait-abort\): running/);
    assert.equal(run.collectedAt, undefined);
  });
});

test("a second async resume is refused while its background session is running", async () => {
  await withTempAgentDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "subagent.json"), JSON.stringify({ maxDepth: 1 }));
    const sessionsDir = path.join(dir, "subagent-sessions");
    fs.mkdirSync(sessionsDir);
    const sessionId = "live-session";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, "existing transcript\n");
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({ name: "worker", systemPrompt: "worker" }),
    );
    registerBackgroundRun({
      sessionId,
      agent: "worker",
      task: "first",
      promise: new Promise(() => {}),
    });

    const subagent = registeredTools().find((definition) => definition.name === "subagent");
    const response = await subagent.execute(
      "call",
      { resume: sessionId, task: "second", async: true },
      undefined,
      undefined,
      {
        cwd: dir,
        hasUI: false,
        ui: { setWidget() {} },
        modelRegistry: registry(),
        sessionManager: undefined,
      },
    );

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /subagent_wait/);
    assert.equal(getBackgroundRun(sessionId).task, "first");
    assert.equal(fs.readFileSync(sessionFile, "utf8"), "existing transcript\n");
  });
});
