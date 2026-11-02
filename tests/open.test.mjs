import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../extensions/subagent/index.ts";
import { createSubagentOpener } from "../extensions/subagent/open.ts";

// Oracle: F8 opens the selected normal Pi session, without replacing the parent.
// A busy parent must fork; cancellation/missing files must never start Pi.
// A failed launcher must release the picker lock and restore terminal ownership.
function harness(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-open-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "child.jsonl");
  writeFileSync(file, '{"type":"session","id":"child"}\n');
  const workers = [{ id: "run", sessionId: "child", name: "review", status: "completed", sessionFile: file, cwd: dir }];
  const calls = [];
  const notifications = [];
  const ctx = {
    mode: "tui", cwd: "/parent", isIdle: () => true,
    ui: {
      select: async (title, choices) => { calls.push(["select", title, choices]); return choices[0]; },
      notify: (...args) => notifications.push(args),
      custom: (factory) => new Promise((resolve) => factory({
        stop: () => calls.push("stop"), start: () => calls.push("start"), requestRender: () => calls.push("render"),
      }, {}, {}, resolve)),
    },
  };
  Object.assign(ctx, extra);
  return { dir, file, workers, calls, notifications, ctx };
}

test("F8 and /open-subagent register the short open subagent label", () => {
  const shortcuts = new Map();
  const commands = new Map();
  const pi = {
    on() {}, getActiveTools: () => [], registerTool() {},
    registerShortcut: (key, def) => shortcuts.set(key, def),
    registerCommand: (key, def) => commands.set(key, def),
  };
  extension(pi);
  assert.equal(shortcuts.get("f8").description, "open subagent");
  assert.equal(commands.get("open-subagent").description, "open subagent");
});

test("selected finished child opens in its own cwd and the parent TUI resumes", async (t) => {
  const h = harness(t);
  const targets = [];
  await createSubagentOpener(() => h.workers, async (target) => targets.push(target))(h.ctx);
  assert.deepEqual(targets, [{ file: h.file, cwd: h.dir, fork: false }]);
  assert.deepEqual(h.calls.slice(1), ["stop", "start", "render"]);
  assert.deepEqual(h.notifications, []);
});

test("picker deduplicates resumed sessions, includes older hidden cards, and cancels without launching", async (t) => {
  const h = harness(t);
  h.workers.push({ ...h.workers[0], id: "resume", name: "latest" });
  for (let i = 0; i < 5; i++) h.workers.push({ ...h.workers[0], sessionId: `older-${i}` });
  let choices;
  let launches = 0;
  h.ctx.ui.select = async (_title, options) => { choices = options; return undefined; };
  await createSubagentOpener(() => h.workers, async () => { launches++; })(h.ctx);
  assert.equal(choices.length, 6);
  assert.match(choices.at(-1), /^latest/);
  assert.equal(launches, 0);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.notifications, []);
});

test("busy state is rechecked after selection and uses a fork", async (t) => {
  const h = harness(t);
  let busy = false;
  h.ctx.isIdle = () => !busy;
  h.ctx.ui.select = async (_title, choices) => { busy = true; return choices[0]; };
  const targets = [];
  const open = createSubagentOpener(() => h.workers, async (target) => targets.push(target));
  await open(h.ctx);
  busy = false;
  h.workers[0].status = "running";
  await open(h.ctx);
  assert.deepEqual(targets.map((target) => target.fork), [true, true]);
  assert.deepEqual(h.notifications, []);
});

test("legacy metadata falls back to parent cwd", async (t) => {
  const h = harness(t);
  delete h.workers[0].cwd;
  const targets = [];
  await createSubagentOpener(() => h.workers, async (target) => targets.push(target))(h.ctx);
  assert.equal(targets[0].cwd, "/parent");
});

test("missing files, empty history and non-TUI modes do not launch", async (t) => {
  const h = harness(t);
  const open = createSubagentOpener(() => h.workers, async () => assert.fail("unexpected launch"));
  rmSync(h.file);
  await open(h.ctx);
  assert.match(h.notifications.at(-1)[0], /file is missing/);
  h.workers.length = 0;
  await open(h.ctx);
  assert.match(h.notifications.at(-1)[0], /No subagent/);
  h.ctx.mode = "rpc";
  await open(h.ctx);
  assert.match(h.notifications.at(-1)[0], /requires a terminal/);
});

test("launch failure restores the TUI and allows another open", async (t) => {
  const h = harness(t);
  let attempts = 0;
  const open = createSubagentOpener(() => h.workers, () => { attempts++; throw new Error("fixture failed"); });
  await open(h.ctx);
  await open(h.ctx);
  assert.equal(attempts, 2);
  assert.equal(h.calls.filter((call) => call === "start").length, 2);
  assert.match(h.notifications[0][0], /fixture failed/);
});

test("repeated shortcuts cannot open overlapping pickers", async (t) => {
  const h = harness(t);
  let resolve;
  let selections = 0;
  h.ctx.ui.select = () => { selections++; return new Promise((done) => { resolve = done; }); };
  const open = createSubagentOpener(() => h.workers);
  const first = open(h.ctx);
  await open(h.ctx);
  assert.equal(selections, 1);
  resolve(undefined);
  await first;
});
