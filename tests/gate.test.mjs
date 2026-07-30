import assert from "node:assert/strict";
import test from "node:test";

import { classify } from "../extensions/subagent/gate.ts";

test("write and edit rely on the subagent tool allowlist", () => {
  assert.deepEqual(classify("write", { path: "src/example.ts", content: "updated" }), []);
  assert.deepEqual(classify("edit", { path: "src/example.ts", edits: [] }), []);
});

test("ordinary bash commands do not require approval", () => {
  assert.deepEqual(classify("bash", { command: "npm test" }), []);
});

test("dangerous bash commands still require approval", () => {
  assert.deepEqual(classify("bash", { command: "git reset --hard HEAD~1" }), ["git reset hard"]);
  assert.deepEqual(classify("bash", { command: "rm -rf build" }), ["recursive/forced rm"]);
});
