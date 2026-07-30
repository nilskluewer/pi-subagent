import assert from "node:assert/strict";
import test from "node:test";

import { createAbortKillController, selectKillStrategy, shouldDetachChild } from "../extensions/subagent/subagent-tool.ts";

class FakeSignal {
  aborted = false;
  listeners = new Set();

  addEventListener(type, listener) {
    assert.equal(type, "abort");
    this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    assert.equal(type, "abort");
    this.listeners.delete(listener);
  }

  abort() {
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
  }
}

test("kill strategy uses a process group only for detached POSIX children", () => {
  assert.equal(shouldDetachChild("darwin", 0), true);
  assert.equal(shouldDetachChild("linux", 0), true);
  assert.equal(shouldDetachChild("darwin", 1), false);
  assert.equal(shouldDetachChild("win32", 0), false);

  assert.equal(selectKillStrategy("darwin", true), "process-group");
  assert.equal(selectKillStrategy("linux", false), "direct");
  assert.equal(selectKillStrategy("win32", false), "windows-taskkill");
});

test("abort controller removes abort listener and clears escalation timer on close", () => {
  const signal = new FakeSignal();
  const sent = [];
  const timers = [];
  const controller = createAbortKillController(
    signal,
    (signalName) => sent.push(signalName),
    (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    (timer) => {
      timer.cleared = true;
    },
  );

  assert.equal(signal.listeners.size, 1);
  signal.abort();
  assert.deepEqual(sent, ["SIGTERM"]);
  assert.equal(controller.wasAborted(), true);
  assert.equal(timers.length, 1);

  controller.onClose();
  assert.equal(signal.listeners.size, 0);
  assert.equal(timers[0].cleared, true);

  timers[0].callback();
  assert.deepEqual(sent, ["SIGTERM"]);
});

test("abort controller escalates only while the child has not exited", () => {
  const signal = new FakeSignal();
  const sent = [];
  let timer;
  createAbortKillController(
    signal,
    (signalName) => sent.push(signalName),
    (callback) => {
      timer = { callback, cleared: false };
      return timer;
    },
    (value) => {
      value.cleared = true;
    },
  );

  signal.abort();
  timer.callback();
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
});
