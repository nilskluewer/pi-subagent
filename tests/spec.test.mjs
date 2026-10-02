import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { readConfig, resolveSpec, selectModel, splitModel, writeMeta } from "../extensions/subagent/spec.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "spec-test-"));

test("splitModel only treats a known thinking level as suffix", () => {
  assert.deepEqual(splitModel("a/b:high"), { model: "a/b", thinking: "high" });
  assert.deepEqual(splitModel("a/b:free"), { model: "a/b:free" });
  assert.deepEqual(splitModel(undefined), {});
});

test("allowlist: exact match, first entry is the default, empty fails closed", () => {
  const allowed = ["a/x:low", "b/y:high"];
  assert.equal(selectModel(undefined, { allowedModels: allowed }), "a/x:low");
  assert.equal(selectModel("b/y:high", { allowedModels: allowed }), "b/y:high");
  assert.throws(() => selectModel("c/z", { allowedModels: allowed }), /not allowed/);
  assert.throws(() => selectModel(undefined, { allowedModels: [] }), /not allowed/);
  assert.equal(selectModel(undefined, { defaultModel: "d/q" }), "d/q");
  assert.equal(selectModel("e/r", {}), "e/r");
});

test("readConfig tolerates missing and malformed files", () => {
  const dir = tmp();
  assert.deepEqual(readConfig(path.join(dir, "none.json")), {});
  fs.writeFileSync(path.join(dir, "bad.json"), "{");
  assert.deepEqual(readConfig(path.join(dir, "bad.json")), {});
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ defaultModel: "a/b:low", allowedModels: ["a/b:low", 3] }));
  assert.deepEqual(readConfig(path.join(dir, "ok.json")), { defaultModel: "a/b:low", allowedModels: ["a/b:low"] });
  fs.writeFileSync(path.join(dir, "empty.json"), JSON.stringify({ allowedModels: "x" }));
  assert.deepEqual(readConfig(path.join(dir, "empty.json")).allowedModels, []);
});

test("inline persona gets a fresh session; placeholders count as absent", () => {
  const dir = tmp();
  const spec = resolveSpec(
    { task: "t", systemPrompt: "Be brief", name: "brief", model: "a/b:high", tools: "read, grep", agent: "", resume: " " },
    dir,
    {},
  );
  assert.equal(spec.name, "brief");
  assert.equal(spec.systemPrompt, "Be brief");
  assert.deepEqual([spec.model, spec.thinking, spec.tools], ["a/b", "high", ["read", "grep"]]);
  assert.equal(spec.isResume, false);
  assert.equal(spec.sessionFile, path.join(dir, `${spec.sessionId}.jsonl`));
});

test("at most one persona source", () => {
  assert.throws(() => resolveSpec({ task: "t", agent: "a", systemPrompt: "b" }, tmp(), {}), /at most one/);
});

test("resume re-applies the stored persona and lets the call override the model", () => {
  const dir = tmp();
  const first = resolveSpec({ task: "t", systemPrompt: "Persona", name: "p", model: "a/b:low", tools: "read" }, dir, {});
  writeMeta(first, dir);
  fs.writeFileSync(first.sessionFile, "");

  const same = resolveSpec({ task: "more", resume: first.sessionId }, dir, {});
  assert.deepEqual(
    [same.isResume, same.sessionId, same.name, same.systemPrompt, same.model, same.thinking, same.tools],
    [true, first.sessionId, "p", "Persona", "a/b", "low", ["read"]],
  );
  assert.equal(resolveSpec({ task: "x", resume: first.sessionId, model: "c/d:high" }, dir, {}).model, "c/d");
});

test("resume rejects unknown ids and path traversal", () => {
  const dir = tmp();
  assert.throws(() => resolveSpec({ task: "t", resume: "nope" }, dir, {}), /Cannot resume/);
  assert.throws(() => resolveSpec({ task: "t", resume: "../etc/passwd" }, dir, {}), /Invalid session id/);
});

test("unknown named agent lists the available ones", () => {
  assert.throws(() => resolveSpec({ task: "t", agent: "../x" }, tmp(), {}), /Unknown agent/);
});
