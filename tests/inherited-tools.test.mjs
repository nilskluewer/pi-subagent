import assert from "node:assert/strict";
import test from "node:test";

import { INHERITED_TOOLS_ENV, inheritedToolsEnv, setActiveToolsProvider } from "../extensions/subagent/inherited-tools.ts";

test("children inherit the parent tool set by default", () => {
  setActiveToolsProvider(() => ["read", "bash", "atlassian_search"]);
  assert.deepEqual(inheritedToolsEnv(), { [INHERITED_TOOLS_ENV]: "read,bash,atlassian_search" });
});

test("an explicit allowlist overrides the parent set", () => {
  setActiveToolsProvider(() => ["read", "bash", "atlassian_search"]);
  assert.deepEqual(inheritedToolsEnv(["read", "grep"]), { [INHERITED_TOOLS_ENV]: "read,grep" });
});

test("duplicates and blanks are dropped", () => {
  setActiveToolsProvider(() => ["read", "read", "", "bash"]);
  assert.deepEqual(inheritedToolsEnv(), { [INHERITED_TOOLS_ENV]: "read,bash" });
});

test("nothing to inherit leaves the child env untouched", () => {
  setActiveToolsProvider(() => []);
  assert.deepEqual(inheritedToolsEnv(), {});
});
