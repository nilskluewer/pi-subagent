import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage } from "../extensions/subagent/child.ts";
import { createWorkerMonitor, readSessionCost, renderWorkers, sessionCost, WORKER_ENTRY } from "../extensions/subagent/workers.ts";

const usage = (cost) => ({ ...emptyUsage(), input: 1200, output: 30, cost: { ...emptyUsage().cost, total: cost } });
const worker = (id, cost, status = "running", extra = {}) => ({
  id, sessionId: id, name: id, requestedModel: "p/requested", requestedThinking: "medium",
  priorCost: 0, startedAt: 0, status, progress: { usage: usage(cost), turns: 1, preview: "Checking errors" }, ...extra,
});

// Oracle: user Q5 requires each subagent session's costs and the sum of active
// sessions only. A resumed session with .10 + .20 and another with .40 = .70;
// an unrelated completed .90 must not inflate that sum.
test("active sum excludes completed sessions but includes earlier runs of a resumed worker", () => {
  const workers = [worker("a1", .1, "completed", { sessionId: "a" }), worker("a2", .2, "running", { sessionId: "a", priorCost: .1 }), worker("b", .4), worker("c", .9, "completed")];
  assert.equal(sessionCost(workers, "a"), .1 + .2);
  const lines = renderWorkers(workers, 24000, 180);
  assert.match(lines[0], /2 active.*\$0\.7000/);
  assert.match(lines.join("\n"), /00:24.*↑1.2k ↓30 tokens.*\$0\.3000/);
  assert.match(lines.join("\n"), /p\/requested \(requested\).*think medium \(set\)/);
  assert.match(lines.join("\n"), /Checking errors/);
  workers[1].status = "completed";
  const finished = renderWorkers(workers, 25000, 180);
  assert.match(finished[0], /1 active.*\$0\.4000/);
  assert.match(finished.join("\n"), /a2.*completed.*\$0\.3000/);
});

test("actual model/level replace dispatch values; tool activity takes priority over preview", () => {
  const lines = renderWorkers([worker("a", .01, "running", { model: "p/actual", thinking: "low", progress: { usage: usage(.01), turns: 1, preview: "old text", tool: "read · auth.ts" } })], 1000, 180);
  assert.match(lines.join("\n"), /p\/actual · think low/);
  assert.doesNotMatch(lines.join("\n"), /requested|old text/);
  assert.match(lines.join("\n"), /read · auth.ts/);
});

test("terminal sequences and newlines cannot escape cards, even with wide Unicode", () => {
  const states = [worker("a", .1, "running", { name: "名字\n\x1b[31mred", progress: { usage: usage(.1), turns: 1, preview: "\x1b]0;title\x07hello\nworld\r" } })];
  for (const width of [1, 20, 60, 120]) {
    const lines = renderWorkers(states, 1000, width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width && !/[\x00-\x1f\x7f]/.test(line)));
  }
  assert.match(renderWorkers(states, 1000, 180).join("\n"), /hello world/);
});

test("completed costs remain visible when the terminal is narrower", () => {
  const lines = renderWorkers([worker("reviewer", .1234, "completed", { model: "github-copilot/gemini-4-argon", thinking: "medium", endedAt: 1000 })], 1000, 80);
  assert.match(lines.join("\n"), /github-copilot\/gemini-4-argon/);
  assert.match(lines.join("\n"), /completed.*\$0\.1234/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test("finished cards shrink and older results do not grow the widget without limit", () => {
  const states = Array.from({ length: 20 }, (_, i) => worker(String(i), .01, i === 19 ? "aborted" : "completed", { endedAt: 1000 }));
  const lines = renderWorkers(states, 9000, 180);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /0 active.*\$0\.0000/);
  assert.match(lines.join("\n"), /■ 19.*aborted/);
  assert.match(lines.at(-1), /17 earlier sessions/);
});

function harness(mode = "tui") {
  const handlers = new Map();
  const saved = [];
  let component;
  let redraws = 0;
  const ctx = {
    mode, sessionManager: { getSessionId: () => "parent", getBranch: () => saved },
    ui: { setWidget: (_key, factory) => { component = typeof factory === "function" ? factory({ requestRender: () => redraws++ }, { fg: (_token, text) => text }) : undefined; } },
  };
  const pi = { on: (event, handler) => handlers.set(event, handler), appendEntry: (customType, data) => saved.push({ type: "custom", customType, data }) };
  const monitor = createWorkerMonitor(pi);
  return { handlers, saved, ctx, monitor, render: () => component?.render(180) ?? [], redraws: () => redraws };
}

test("monitor works with no onUpdate, persists costs, restores and clears on session replacement", () => {
  const h = harness();
  const spec = { sessionId: "child", name: "review", model: "p/m", thinking: "high" };
  h.handlers.get("session_start")({}, h.ctx);
  h.monitor.dispatch(h.ctx, "codemode/1", spec)();
  h.monitor.dispatch(h.ctx, "codemode/2", { ...spec, sessionId: "other" })();
  h.monitor.update("codemode/1", { usage: usage(.1), turns: 1, model: "p/actual", preview: "live text" });
  assert.match(h.render().join("\n"), /live text/);
  assert.match(h.render()[0], /2 active.*\$0\.1000/);
  h.monitor.finish("codemode/1", { usage: usage(.2), turns: 2, status: "completed", model: "p/actual" });
  assert.equal(h.saved[0].customType, WORKER_ENTRY);
  assert.match(h.render()[0], /1 active.*\$0\.0000/);
  h.monitor.fail("codemode/2");
  assert.match(h.render().join("\n"), /✖ review.*error/);
  h.handlers.get("session_start")({}, h.ctx);
  assert.match(h.render().join("\n"), /p\/actual.*completed.*\$0\.2000/);
  // A branch or new main session must not display abandoned worker records.
  h.handlers.get("session_tree")({}, { ...h.ctx, sessionManager: { getSessionId: () => "new", getBranch: () => [] } });
  assert.deepEqual(h.render(), []);
  h.monitor.update("codemode/1", { usage: usage(99), turns: 9 });
  assert.deepEqual(h.render(), []);
  h.handlers.get("session_shutdown")();
});

test("late successful spawn cannot restore a stale session or branch", () => {
  const h = harness();
  h.handlers.get("session_start")({}, h.ctx);
  const started = h.monitor.dispatch(h.ctx, "late", { sessionId: "child", name: "stale" });
  h.handlers.get("session_tree")({}, h.ctx);
  started();
  h.monitor.finish("late", { usage: usage(99), turns: 1, status: "completed" });
  assert.deepEqual(h.render(), []);
  assert.equal(h.saved.length, 0);
  h.handlers.get("session_shutdown")();
});

test("resume imports child-session cost even when the main session has no prior worker records", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worker-cost-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "child.jsonl");
  writeFileSync(file, [
    { type: "session", id: "child" },
    { type: "message", message: { role: "assistant", usage: usage(.1) } },
    { type: "message", message: { role: "toolResult", content: [] } },
    { type: "message", message: { role: "assistant", usage: usage(.2) } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + '\n{"truncated":');
  assert.equal(readSessionCost(file), .1 + .2);
  const h = harness();
  h.monitor.dispatch(h.ctx, "resume", { sessionId: "child", name: "resumed", isResume: true, sessionFile: file })();
  h.monitor.update("resume", { usage: usage(.4), turns: 1 });
  assert.match(h.render()[0], /running Σ \$0\.7000/);
  h.monitor.finish("resume", { usage: usage(.5), turns: 1, status: "completed" });
  assert.match(h.render().join("\n"), /completed.*\$0\.8000/);
  h.handlers.get("session_shutdown")();
});

// Oracle: user requests dismissal on the second submitted user message after
// all workers finish. Assistant/tool activity and messages during a run do not count.
test("finished overview hides on exactly the second user message, survives reload, and reopens for new work", () => {
  const h = harness();
  const spec = { sessionId: "child", name: "review" };
  const finish = (id) => h.monitor.finish(id, { usage: usage(.1), turns: 1, status: "completed" });
  const input = (source = "interactive", text = "Follow-up") => h.handlers.get("input")({ type: "input", source, text }, h.ctx);
  h.monitor.dispatch(h.ctx, "first", spec)();
  input(); input(); // Input while running must not age the finished overview.
  finish("first");
  input("extension");
  input("interactive", "   ");
  assert.match(h.render()[0], /0 active/);
  input();
  assert.match(h.render()[0], /0 active/);
  h.handlers.get("session_start")({}, h.ctx); // Keep the first submitted-message count.
  assert.match(h.render()[0], /0 active/);
  input("rpc");
  assert.deepEqual(h.render(), []);
  assert.ok(h.saved.some((entry) => entry.customType === WORKER_ENTRY));
  h.handlers.get("session_start")({}, h.ctx);
  assert.deepEqual(h.render(), []); // Reload must not resurrect hidden results.
  h.monitor.dispatch(h.ctx, "second", { ...spec, sessionId: "new-child" })();
  assert.match(h.render()[0], /1 active/);
  finish("second");
  input();
  assert.match(h.render()[0], /0 active/);
  input();
  assert.deepEqual(h.render(), []);
  h.handlers.get("session_shutdown")();
});

test("message countdown starts only when the last parallel worker finishes and accepts image-only input", () => {
  const h = harness();
  const finish = (id, status) => h.monitor.finish(id, { usage: usage(.1), turns: 1, status });
  h.monitor.dispatch(h.ctx, "a", { sessionId: "a", name: "a" })();
  h.monitor.dispatch(h.ctx, "b", { sessionId: "b", name: "b" })();
  finish("a", "error");
  for (let i = 0; i < 3; i++) h.handlers.get("input")({ source: "interactive", text: "During work" }, h.ctx);
  assert.match(h.render()[0], /1 active/);
  finish("b", "aborted");
  const imageInput = { source: "interactive", text: "", images: [{ type: "image", data: "test", mimeType: "image/png" }] };
  h.handlers.get("input")(imageInput, h.ctx);
  assert.match(h.render()[0], /0 active/);
  h.handlers.get("input")(imageInput, h.ctx);
  assert.deepEqual(h.render(), []);
  h.handlers.get("session_shutdown")();
});

test("non-interactive runs keep metadata without creating terminal widgets", () => {
  const h = harness("json");
  h.monitor.dispatch(h.ctx, "call", { sessionId: "child", name: "review" })();
  h.monitor.finish("call", { usage: usage(.1), turns: 1, status: "completed" });
  assert.deepEqual(h.render(), []);
  assert.equal(h.saved.length, 1);
  h.handlers.get("session_shutdown")();
});
