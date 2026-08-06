import assert from "node:assert/strict";
import test from "node:test";

import {
  clearBackgroundRuns,
  getBackgroundRun,
  listBackgroundRuns,
  markBackgroundRunCollected,
  registerBackgroundRun,
  waitForAllBackgroundRuns,
  waitForBackgroundRun,
  waitForFirstBackgroundRun,
} from "../extensions/subagent/background-runs.ts";

function result(overrides = {}) {
  return {
    agent: "worker",
    agentSource: "inline",
    task: "task",
    sessionId: "s1",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test.afterEach(() => {
  clearBackgroundRuns();
});

test("registers a running background run with its metadata and promise", async () => {
  const pending = deferred();
  const run = registerBackgroundRun({
    sessionId: "s1",
    agent: "worker",
    task: "inspect the code",
    startedAt: 42,
    promise: pending.promise,
    resultCapTokens: 17,
  });

  assert.equal(run.sessionId, "s1");
  assert.equal(run.agent, "worker");
  assert.equal(run.task, "inspect the code");
  assert.equal(run.startedAt, 42);
  assert.equal(run.resultCapTokens, 17);
  assert.equal(run.status, "running");
  assert.equal(getBackgroundRun("s1"), run);
  assert.equal(listBackgroundRuns().length, 1);

  pending.resolve(result());
  await run.promise;
  assert.equal(run.status, "done");
});

test("a waiter started before settlement resolves from the run's deferred promise", async () => {
  const pending = deferred();
  const run = registerBackgroundRun({ sessionId: "s1", agent: "worker", task: "task", promise: pending.promise });
  const capturedPromise = run.promise;
  const waiting = waitForBackgroundRun("s1", 1000);
  const completed = result({ sessionId: "s1" });

  pending.resolve(completed);

  const outcome = await waiting;
  assert.equal(await capturedPromise, completed);
  assert.equal(run.promise, capturedPromise);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.settled[0], run);
});

test("failed promises become failed runs with a settled result", async () => {
  const run = registerBackgroundRun({
    sessionId: "s1",
    agent: "worker",
    task: "task",
    promise: Promise.reject(new Error("child crashed")),
  });

  const settled = await run.promise;
  assert.equal(run.status, "failed");
  assert.equal(run.result, settled);
  assert.match(settled.errorMessage, /child crashed/);
});

test("waits for one run and returns its settled result", async () => {
  const pending = deferred();
  registerBackgroundRun({ sessionId: "s1", agent: "worker", task: "task", promise: pending.promise });
  const waiting = waitForBackgroundRun("s1", 1000);

  pending.resolve(result());
  const outcome = await waiting;
  assert.deepEqual(outcome.unknown, []);
  assert.deepEqual(outcome.running, []);
  assert.equal(outcome.settled.length, 1);
  assert.equal(outcome.settled[0].sessionId, "s1");
});

test("waits for the first run to finish and leaves later runs running", async () => {
  const first = deferred();
  const second = deferred();
  registerBackgroundRun({ sessionId: "s1", agent: "first", task: "first", promise: first.promise });
  registerBackgroundRun({ sessionId: "s2", agent: "second", task: "second", promise: second.promise });
  const waiting = waitForFirstBackgroundRun(1000);

  second.resolve(result({ sessionId: "s2", agent: "second" }));
  const outcome = await waiting;
  assert.equal(outcome.settled.length, 1);
  assert.equal(outcome.settled[0].sessionId, "s2");
  assert.deepEqual(outcome.running, []);
  assert.equal(getBackgroundRun("s1").status, "running");

  first.resolve(result({ sessionId: "s1", agent: "first" }));
  await getBackgroundRun("s1").promise;
});

test("waits for the first settled run when every run is already complete", async () => {
  registerBackgroundRun({ sessionId: "s1", agent: "first", task: "first", promise: Promise.resolve(result({ sessionId: "s1" })) });
  registerBackgroundRun({ sessionId: "s2", agent: "second", task: "second", promise: Promise.resolve(result({ sessionId: "s2" })) });
  await Promise.all(listBackgroundRuns().map((run) => run.promise));

  const outcome = await waitForFirstBackgroundRun(1000);
  assert.deepEqual(outcome.settled.map((run) => run.sessionId), ["s1"]);
});

test("an aborted wait returns promptly, reports running runs, and collects nothing", async () => {
  const pending = deferred();
  const run = registerBackgroundRun({ sessionId: "s1", agent: "worker", task: "task", promise: pending.promise });
  const controller = new AbortController();
  const waiting = waitForAllBackgroundRuns(600_000, controller.signal);

  controller.abort();
  const outcome = await waiting;

  assert.equal(outcome.aborted, true);
  assert.equal(outcome.timedOut, false);
  assert.deepEqual(outcome.running.map((item) => item.sessionId), ["s1"]);
  assert.equal(run.collectedAt, undefined);
});

test("an already aborted signal skips the wait without arming a timer", async () => {
  const pending = deferred();
  registerBackgroundRun({ sessionId: "s1", agent: "worker", task: "task", promise: pending.promise });
  const controller = new AbortController();
  controller.abort();
  const before = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

  const outcome = await waitForAllBackgroundRuns(600_000, controller.signal);
  const after = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

  assert.equal(outcome.aborted, true);
  assert.equal(outcome.running.length, 1);
  assert.equal(after, before);
});

test("an aborted wait leaves a later named wait able to collect the run", async () => {
  const pending = deferred();
  const run = registerBackgroundRun({ sessionId: "s1", agent: "worker", task: "task", promise: pending.promise });
  const controller = new AbortController();
  const waiting = waitForBackgroundRun("s1", 600_000, controller.signal);
  controller.abort();
  const aborted = await waiting;
  assert.equal(aborted.aborted, true);

  const completed = result({ sessionId: "s1" });
  pending.resolve(completed);
  await run.promise;
  const collected = await waitForBackgroundRun("s1", 1000);

  assert.deepEqual(collected.settled.map((item) => item.sessionId), ["s1"]);
  assert.equal(run.collectedAt, undefined);
});

test("waits for every tracked run", async () => {
  const first = deferred();
  const second = deferred();
  registerBackgroundRun({ sessionId: "s1", agent: "first", task: "first", promise: first.promise });
  registerBackgroundRun({ sessionId: "s2", agent: "second", task: "second", promise: second.promise });
  const waiting = waitForAllBackgroundRuns(1000);

  first.resolve(result({ sessionId: "s1" }));
  second.resolve(result({ sessionId: "s2" }));
  const outcome = await waiting;
  assert.equal(outcome.settled.length, 2);
  assert.deepEqual(outcome.settled.map((run) => run.sessionId), ["s1", "s2"]);
  assert.equal(outcome.timedOut, false);
});

test("an unnamed wait advances past runs that were already collected", async () => {
  registerBackgroundRun({ sessionId: "s1", agent: "first", task: "first", promise: Promise.resolve(result({ sessionId: "s1" })) });
  registerBackgroundRun({ sessionId: "s2", agent: "second", task: "second", promise: Promise.resolve(result({ sessionId: "s2" })) });
  await Promise.all(listBackgroundRuns().map((run) => run.promise));

  const first = await waitForFirstBackgroundRun(1000);
  assert.deepEqual(first.settled.map((run) => run.sessionId), ["s1"]);
  markBackgroundRunCollected("s1");

  const second = await waitForFirstBackgroundRun(1000);
  assert.deepEqual(second.settled.map((run) => run.sessionId), ["s2"]);
  markBackgroundRunCollected("s2");

  const exhausted = await waitForFirstBackgroundRun(1000);
  assert.deepEqual(exhausted.selected, []);

  // A named wait still returns a collected result, so a parent can re-read it.
  const named = await waitForBackgroundRun("s1", 1000);
  assert.deepEqual(named.settled.map((run) => run.sessionId), ["s1"]);
});

test("reports an unknown id without waiting", async () => {
  const outcome = await waitForBackgroundRun("missing", 1000);

  assert.deepEqual(outcome.unknown, ["missing"]);
  assert.deepEqual(outcome.selected, []);
  assert.equal(outcome.timedOut, false);
});

test("re-collects an already finished run from the registry", async () => {
  const run = registerBackgroundRun({ sessionId: "s1", agent: "worker", task: "task", promise: Promise.resolve(result()) });
  const first = await waitForBackgroundRun("s1", 1000);
  const second = await waitForBackgroundRun("s1", 1000);

  assert.equal(first.settled[0], run);
  assert.equal(second.settled[0], run);
  assert.equal(run.status, "done");
  assert.equal(listBackgroundRuns().length, 1);
});
