import assert from "node:assert/strict";
import test from "node:test";

import { summarizeInput } from "../extensions/subagent/approval-protocol.ts";

test("summarizes bash approval requests with the raw command", () => {
  assert.equal(summarizeInput("bash", { command: "sudo systemctl restart nginx" }), "sudo systemctl restart nginx");
});

test("falls back to JSON for non-bash approval requests", () => {
  assert.equal(summarizeInput("write", { path: "src/example.ts" }), '{"path":"src/example.ts"}');
  assert.equal(summarizeInput("bash", { command: 42 }), '{"command":42}');
});
