import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  OPERATIONAL_GUIDELINES,
  buildDelegationPolicyLine,
  loadSubagentConfig,
  shouldRegisterSubagentTools,
} from "../extensions/subagent/config.ts";

function withTempAgentDir(fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSubagentConfig returns depth-budget defaults when subagent.json is missing", () => {
  withTempAgentDir(() => {
    assert.deepEqual(loadSubagentConfig(), {
      maxDepth: 2,
      maxLiveChildren: 4,
      budgetAcquireTimeoutMs: 120000,
    });
  });
});

test("loadSubagentConfig returns parsed fields from a valid subagent.json", () => {
  withTempAgentDir((dir) => {
    fs.writeFileSync(path.join(dir, "subagent.json"), JSON.stringify({ delegationPolicy: "proactive", resultCapTokens: 250, maxDepth: 3, maxLiveChildren: 6, budgetAcquireTimeoutMs: 30000 }));
    assert.deepEqual(loadSubagentConfig(), { delegationPolicy: "proactive", resultCapTokens: 250, maxDepth: 3, maxLiveChildren: 6, budgetAcquireTimeoutMs: 30000 });
  });
});

test("loadSubagentConfig ignores invalid values and keeps depth-budget defaults", () => {
  withTempAgentDir((dir) => {
    fs.writeFileSync(path.join(dir, "subagent.json"), JSON.stringify({ resultCapTokens: -1, maxDepth: 0, maxLiveChildren: 1.5, budgetAcquireTimeoutMs: "soon" }));
    assert.deepEqual(loadSubagentConfig(), {
      maxDepth: 2,
      maxLiveChildren: 4,
      budgetAcquireTimeoutMs: 120000,
    });
  });
});

test("loadSubagentConfig returns depth-budget defaults for invalid JSON", () => {
  withTempAgentDir((dir) => {
    fs.writeFileSync(path.join(dir, "subagent.json"), "{");
    assert.deepEqual(loadSubagentConfig(), {
      maxDepth: 2,
      maxLiveChildren: 4,
      budgetAcquireTimeoutMs: 120000,
    });
  });
});

test("buildDelegationPolicyLine returns the explicit-request default", () => {
  const implicitDefault = buildDelegationPolicyLine(undefined);
  const explicitDefault = buildDelegationPolicyLine("explicit-request-only");

  assert.equal(implicitDefault, explicitDefault);
  assert.match(implicitDefault, /Only use `subagent`/);
  assert.match(implicitDefault, /do the work yourself unless delegation is explicitly requested/);
});

test("buildDelegationPolicyLine returns the proactive policy", () => {
  const line = buildDelegationPolicyLine("proactive");

  assert.match(line, /delegate proactively/);
  assert.match(line, /do not delegate when the result blocks your very next step/);
});

test("buildDelegationPolicyLine passes custom policies through verbatim", () => {
  assert.equal(buildDelegationPolicyLine("Always delegate code review."), "Always delegate code review.");
});

test("OPERATIONAL_GUIDELINES has four subagent-named entries", () => {
  assert.equal(OPERATIONAL_GUIDELINES.length, 4);
  for (const guideline of OPERATIONAL_GUIDELINES) {
    assert.match(guideline, /subagent/);
  }
});

test("shouldRegisterSubagentTools respects maxDepth", () => {
  assert.equal(shouldRegisterSubagentTools(0, 2), true);
  assert.equal(shouldRegisterSubagentTools(1, 2), true);
  assert.equal(shouldRegisterSubagentTools(2, 2), false);
  assert.equal(shouldRegisterSubagentTools(0, 1), true);
  assert.equal(shouldRegisterSubagentTools(1, 1), false);
});
