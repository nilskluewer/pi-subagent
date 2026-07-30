import assert from "node:assert/strict";
import test from "node:test";

import { displayModel, modelTag } from "../extensions/subagent/terminal-display.ts";

test("terminal model labels show configured models", () => {
  assert.equal(displayModel("github-copilot/gpt-5.6-luna"), "github-copilot/gpt-5.6-luna");
  assert.equal(modelTag("github-copilot/gpt-5.6-luna"), "[github-copilot/gpt-5.6-luna]");
});

test("terminal model labels remain visible before default model resolution", () => {
  assert.equal(displayModel(undefined), "default");
  assert.equal(modelTag(undefined), "[default]");
});
