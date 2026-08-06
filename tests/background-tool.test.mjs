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
import { registerSubagentTool } from "../extensions/subagent/subagent-tool.ts";

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
