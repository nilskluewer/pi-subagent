import assert from "node:assert/strict";
import test from "node:test";

import {
  abortBackgroundRun,
  clearBackgroundRuns,
  getBackgroundRun,
  registerBackgroundRun,
} from "../extensions/subagent/background-runs.ts";
import {
  createSubagentPanelController,
  disposeSubagentPanel,
  getSubagentPanel,
  initializeSubagentPanel,
  renderSubagentPanelLines,
} from "../extensions/subagent/subagent-panel.ts";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function result(overrides = {}) {
  return {
    agent: "worker",
    agentSource: "inline",
    task: "task",
    sessionId: "s1",
    exitCode: 0,
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the project" }] },
      { role: "assistant", content: [{ type: "text", text: "The project is healthy." }] },
    ],
    usage: {
      input: 12,
      output: 34,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 46,
      turns: 1,
    },
    ...overrides,
  };
}

function fakeUi() {
  let inputHandler;
  const widgets = [];
  const ui = {
    widgets,
    get inputHandler() { return inputHandler; },
    setWidget(key, content) {
      widgets.push({ key, content });
    },
    onTerminalInput(handler) {
      inputHandler = handler;
      return () => { inputHandler = undefined; };
    },
  };
  return ui;
}

test.afterEach(() => {
  disposeSubagentPanel();
  clearBackgroundRuns();
});

test("renders selected rows with status, model, tool, usage, and task", () => {
  const rows = [{
    id: "s1",
    sessionId: "s1",
    name: "worker",
    model: "openai/gpt-test",
    status: "running",
    tool: "bash",
    usage: {
      input: 1200,
      output: 3400,
      cacheRead: 10,
      cacheWrite: 20,
      cost: 0.0042,
      contextTokens: 0,
      turns: 2,
    },
    task: "Inspect the project files",
    stopRequested: false,
  }];

  const lines = renderSubagentPanelLines(rows, 100, { selectedIndex: 0, active: true });
  assert.match(lines[0], /Subagents \(1\)/);
  assert.match(lines[1], /worker/);
  assert.match(lines[1], /⏳/);
  assert.match(lines[1], /\[openai\/gpt-test\]/);
  assert.match(lines[1], /· bash/);
  assert.match(lines[1], /in 1\.2k out 3\.4k/);
  assert.match(lines[1], /\$0\.0042/);
  assert.match(lines[2], /task: Inspect the project files/);
  assert.ok(lines[1].startsWith(">"));
  assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length <= 100));
});

test("removes finished rows instead of retaining statusbar history", () => {
  const panel = createSubagentPanelController();
  for (let index = 0; index < 13; index += 1) {
    panel.add({ id: `row-${index}`, name: `worker-${index}`, task: `task-${index}` });
    panel.finish(`row-${index}`, true);
  }

  assert.equal(panel.getRows().length, 0);
  assert.deepEqual(renderSubagentPanelLines(panel.getRows(), 80), []);
});

test("removes completed rows through the narrow sink", () => {
  const panel = createSubagentPanelController();
  panel.add({ id: "s1", name: "worker", task: "first" });
  panel.add({ id: "s2", name: "reviewer", task: "second" });
  panel.update("s1", {
    model: "provider/model",
    tool: "read",
    usage: { input: 5, output: 8, turns: 1 },
  });
  panel.finish("s1", true);

  assert.equal(panel.getRows().length, 1);
  assert.equal(panel.getRows()[0].id, "s2");
  assert.equal(panel.getRows()[0].status, "running");
  assert.equal(panel.getSelectedRow().id, "s2");
});

test("resets a foreground row when the same session starts again", () => {
  const panel = createSubagentPanelController();
  panel.add({ id: "s1", name: "worker", task: "first", status: "done" });
  panel.add({ id: "s1", name: "worker", task: "follow-up" });

  assert.equal(panel.getSelectedRow().status, "running");
  assert.equal(panel.getSelectedRow().task, "follow-up");
  assert.equal(panel.getSelectedRow().usage.input, 0);
});

test("handles panel keys only after panel mode is active", () => {
  const panel = createSubagentPanelController();
  panel.add({ id: "s1", name: "first" });
  panel.add({ id: "s2", name: "second" });

  assert.equal(panel.handleInput("\x1b[B"), undefined);
  assert.equal(panel.getSelectedIndex(), 0);

  panel.enterPanelMode();
  assert.deepEqual(panel.handleInput("\x1b[B"), { consume: true });
  assert.equal(panel.getSelectedIndex(), 1);
  assert.deepEqual(panel.handleInput("\x1b[A"), { consume: true });
  assert.equal(panel.getSelectedIndex(), 0);
  assert.deepEqual(panel.handleInput("escape"), { consume: true });
  assert.equal(panel.isPanelModeActive(), false);
});

test("stops the selected async run through background-runs", () => {
  const pending = deferred();
  let abortCalls = 0;
  const run = registerBackgroundRun({
    sessionId: "s1",
    agent: "worker",
    task: "wait",
    promise: pending.promise,
    abort() { abortCalls += 1; },
  });
  const panel = createSubagentPanelController();
  panel.add({ id: "s1", name: "worker", sessionId: "s1", task: "wait" });
  panel.enterPanelMode();

  assert.deepEqual(panel.handleInput("x"), { consume: true });
  assert.equal(abortCalls, 1);
  assert.equal(getBackgroundRun("s1").stopRequested, true);
  assert.equal(panel.getSelectedRow().stopRequested, true);

  pending.resolve(result({ sessionId: "s1" }));
  return run.promise.then(() => {
    assert.equal(panel.getRows().length, 0);
    assert.equal(panel.getSelectedRow(), undefined);
  });
});

test("follows a replacement run when a completed session is resumed", async () => {
  const ui = fakeUi();
  const panel = createSubagentPanelController({ ui });
  const first = registerBackgroundRun({
    sessionId: "resumed",
    agent: "worker",
    task: "first",
    promise: Promise.resolve(result({ sessionId: "resumed" })),
  });
  await first.promise;
  assert.equal(panel.getRows().length, 0);

  const secondPending = deferred();
  const second = registerBackgroundRun({
    sessionId: "resumed",
    agent: "worker",
    task: "follow-up",
    promise: secondPending.promise,
    replaceSettled: true,
  });
  assert.equal(panel.getSelectedRow().status, "running");
  assert.equal(panel.getSelectedRow().task, "follow-up");
  secondPending.resolve(result({ sessionId: "resumed", task: "follow-up" }));
  await second.promise;
  assert.equal(panel.getRows().length, 0);
});

test("tracks background registration and removes settled rows", async () => {
  const ui = fakeUi();
  const pending = deferred();
  const panel = createSubagentPanelController({ ui });
  const run = registerBackgroundRun({
    sessionId: "event-run",
    agent: "worker",
    task: "observe",
    promise: pending.promise,
    abort() {},
  });

  assert.equal(panel.getRows().length, 1);
  assert.equal(panel.getSelectedRow().name, "worker");
  assert.equal(abortBackgroundRun("event-run"), true);
  assert.equal(panel.getSelectedRow().stopRequested, true);
  pending.resolve(result({ sessionId: "event-run", exitCode: 1, stopReason: "aborted" }));
  await run.promise;
  assert.equal(panel.getRows().length, 0);
});

test("initializes and disposes one session-level panel", () => {
  const ui = fakeUi();
  const ctx = { mode: "tui", hasUI: true, ui };
  const panel = initializeSubagentPanel(ctx);
  assert.equal(getSubagentPanel(), panel);

  panel.add({ id: "s1", name: "worker", task: "run" });
  assert.equal(ui.widgets.at(-1).key, "subagent-panel");
  assert.equal(typeof ui.widgets.at(-1).content, "function");

  disposeSubagentPanel();
  assert.equal(getSubagentPanel(), undefined);
  assert.equal(ui.widgets.at(-1).content, undefined);
});
