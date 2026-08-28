import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const comparison = fs.readFileSync(new URL("../docs/codex-subagent-comparison.md", import.meta.url), "utf8");

test("package metadata and comparison document the one-task subagent_wait model", () => {
  assert.match(packageJson.description, /one task per call/);
  assert.match(packageJson.description, /subagent_wait/);
  assert.match(comparison, /one task per call/);
  assert.match(comparison, /subagent_wait/);
  assert.match(comparison, /subagent_stop/);
  assert.doesNotMatch(comparison, /single \/ parallel \/ chain/);
});

test("README documents live allowlist enforcement and session-scoped background runs", () => {
  assert.match(readme, /runtime still enforces the live file immediately after an edit/);
  assert.match(readme, /allowlist changes require a Pi session restart/);
  assert.match(readme, /collectable only during the current Pi session/);
  assert.match(readme, /Session shutdown aborts running children and forgets the background-run registry/);
  assert.match(readme, /subagent_stop/);
  assert.match(readme, /\/subagent-stop <session-id>/);
  assert.match(readme, /F8.*focus/);
  assert.match(readme, /arrow keys.*select/);
  assert.match(readme, /\/subagent-panel/);
  assert.match(readme, /JSON launcher/);
});
