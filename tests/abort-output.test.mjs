import assert from "node:assert/strict";
import test from "node:test";

import { formatAbortedRecovery } from "../extensions/subagent/abort-output.ts";

test("abort output keeps only the last ten actionable activity items", () => {
  const activity = Array.from({ length: 12 }, (_, index) => ({
    kind: index % 2 === 0 ? "Message" : "Tool call",
    content: `activity-${index + 1}`,
  }));

  const output = formatAbortedRecovery("implementer", "session-123", activity);

  assert.doesNotMatch(output, /activity-1(?:\n|$)/);
  assert.doesNotMatch(output, /activity-2(?:\n|$)/);
  assert.match(output, /activity-3/);
  assert.match(output, /activity-12/);
  assert.match(output, /Stop reason: aborted/);
  assert.match(output, /Session: session-123/);
  assert.match(output, /"resume":"session-123"/);
  assert.doesNotMatch(output, /cost|tokens|usage/i);
});

test("abort output explains when no session id was captured", () => {
  const output = formatAbortedRecovery("worker", undefined, []);

  assert.match(output, /no completed assistant messages or tool calls/);
  assert.match(output, /cannot be resumed because no session id was captured/);
});

test("large activity items are truncated", () => {
  const output = formatAbortedRecovery("worker", "session-456", [
    { kind: "Message", content: "x".repeat(2500) },
  ]);

  assert.match(output, /… \(truncated\)/);
  assert.ok(output.length < 2500);
});

test("abort output includes optional parent line and omits it byte-identically by default", () => {
  const activity = [{ kind: "Message", content: "done" }];
  const withoutParent = formatAbortedRecovery("worker", "session-789", activity);
  const explicitWithoutParent = formatAbortedRecovery("worker", "session-789", activity, {});
  const withParent = formatAbortedRecovery("worker", "session-789", activity, { parent: "parent-123" });

  assert.equal(explicitWithoutParent, withoutParent);
  assert.match(withParent, /Parent agent: parent-123/);
  assert.doesNotMatch(withoutParent, /Parent agent:/);
});
