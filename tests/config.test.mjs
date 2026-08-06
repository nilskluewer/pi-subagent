import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  OPERATIONAL_GUIDELINES,
  buildDelegationPolicyLine,
  canonicalModelSelection,
  formatModelSelection,
  loadSubagentConfig,
  parseModelSelection,
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
    fs.writeFileSync(
      path.join(dir, "subagent.json"),
      JSON.stringify({
        delegationPolicy: "proactive",
        resultCapTokens: 250,
        defaultModel: "known/model-a:high",
        maxDepth: 3,
        maxLiveChildren: 6,
        budgetAcquireTimeoutMs: 30000,
      }),
    );
    assert.deepEqual(loadSubagentConfig(), {
      delegationPolicy: "proactive",
      resultCapTokens: 250,
      defaultModel: "known/model-a:high",
      maxDepth: 3,
      maxLiveChildren: 6,
      budgetAcquireTimeoutMs: 30000,
    });
  });
});

test("loadSubagentConfig parses an ordered combined model allowlist", () => {
  withTempAgentDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "subagent.json"),
      JSON.stringify({ allowedModels: ["known/model-a:high", "known/model-b:medium"] }),
    );
    assert.deepEqual(loadSubagentConfig().allowedModels, [
      { model: "known/model-a", thinking: "high" },
      { model: "known/model-b", thinking: "medium" },
    ]);
  });
});

test("invalid model allowlists fail closed", () => {
  withTempAgentDir((dir) => {
    fs.writeFileSync(path.join(dir, "subagent.json"), JSON.stringify({ allowedModels: ["known/model-a:unsupported"] }));
    assert.deepEqual(loadSubagentConfig().allowedModels, []);

    fs.writeFileSync(path.join(dir, "subagent.json"), JSON.stringify({ allowedModels: [{ model: "known/model-a", thinking: "high" }] }));
    assert.deepEqual(loadSubagentConfig().allowedModels, []);
  });
});

test("model selections parse and format with an optional thinking suffix", () => {
  assert.deepEqual(parseModelSelection("known/model-a"), { model: "known/model-a", thinking: undefined });
  assert.deepEqual(parseModelSelection("known/model-a:high"), { model: "known/model-a", thinking: "high" });
  assert.equal(formatModelSelection({ model: "known/model-a", thinking: "high" }), "known/model-a:high");
  assert.equal(formatModelSelection({ model: "known/model-a" }), "known/model-a");
});

test("canonical model selections validate the base model through the registry", () => {
  const registry = {
    find(provider, id) {
      return provider === "known" && id === "model-a" ? { provider, id } : undefined;
    },
  };
  assert.deepEqual(canonicalModelSelection("known/model-a:high", registry), { model: "known/model-a", thinking: "high" });
  assert.equal(canonicalModelSelection("known/missing:high", registry), undefined);
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

test("buildDelegationPolicyLine defaults to proactive delegation", () => {
  const line = buildDelegationPolicyLine(undefined);
  assert.equal(line, buildDelegationPolicyLine("proactive"));
  assert.match(line, /proactively/);
});

test("buildDelegationPolicyLine supports explicit opt-in restriction", () => {
  const line = buildDelegationPolicyLine("explicit-request-only");
  assert.match(line, /explicitly requests/);
});

test("buildDelegationPolicyLine passes custom policies through verbatim", () => {
  assert.equal(buildDelegationPolicyLine("Always delegate code review."), "Always delegate code review.");
});

test("operational guidelines cover task quality and parallel write safety", () => {
  assert.equal(OPERATIONAL_GUIDELINES.length, 3);
  assert.match(OPERATIONAL_GUIDELINES[0], /self-contained/);
  assert.match(OPERATIONAL_GUIDELINES[1], /parallel/);
});

test("shouldRegisterSubagentTools respects maxDepth", () => {
  assert.equal(shouldRegisterSubagentTools(0, 2), true);
  assert.equal(shouldRegisterSubagentTools(1, 2), true);
  assert.equal(shouldRegisterSubagentTools(2, 2), false);
  assert.equal(shouldRegisterSubagentTools(0, 1), true);
  assert.equal(shouldRegisterSubagentTools(1, 1), false);
});
