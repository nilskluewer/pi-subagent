import assert from "node:assert/strict";
import test from "node:test";

import {
  clearBackgroundRuns,
  registerBackgroundRun,
} from "../extensions/subagent/background-runs.ts";
import {
  getSubagentStopArgumentCompletions,
  handleSubagentStopCommand,
  registerSubagentStopCommand,
} from "../extensions/subagent/stop-command.ts";

test.afterEach(() => {
  clearBackgroundRuns();
});

function context(messages) {
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      notify(message, type) {
        messages.push({ message, type });
      },
    },
  };
}

test("stop command completes only running session ids", async () => {
  registerBackgroundRun({
    sessionId: "running-id",
    agent: "running-agent",
    task: "run",
    promise: new Promise(() => {}),
    abort() {},
  });
  registerBackgroundRun({
    sessionId: "done-id",
    agent: "done-agent",
    task: "done",
    promise: Promise.resolve({
      agent: "done-agent",
      agentSource: "inline",
      task: "done",
      sessionId: "done-id",
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(getSubagentStopArgumentCompletions("running"), [
    { value: "running-id", label: "running-id (running-agent)" },
  ]);
  assert.equal(getSubagentStopArgumentCompletions("done"), null);
});

test("stop command aborts the requested background run", async () => {
  let stopCalled = false;
  registerBackgroundRun({
    sessionId: "stop-id",
    agent: "worker",
    task: "stop",
    promise: new Promise(() => {}),
    abort() {
      stopCalled = true;
    },
  });
  const messages = [];

  await handleSubagentStopCommand("stop-id", context(messages));

  assert.equal(stopCalled, true);
  assert.deepEqual(messages, [{
    message: 'Stop requested for background subagent "worker" (session: stop-id).',
    type: "info",
  }]);
});

test("stop command registers the expected slash command", () => {
  const registrations = [];
  registerSubagentStopCommand({
    registerCommand(name, definition) {
      registrations.push({ name, definition });
    },
  });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "subagent-stop");
  assert.equal(registrations[0].definition.description, "Stop a running background subagent by session id");
  assert.equal(registrations[0].definition.handler("missing", context([])) instanceof Promise, true);
});
