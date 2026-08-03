import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  canonicalModelReference,
  getSubagentConfigPath,
  loadSubagentConfig,
  SUBAGENT_THINKING_LEVELS,
  updateSubagentDefaults,
} from "../extensions/subagent/config.ts";
import {
  formatSubagentDefaults,
  getSubagentDefaultsArgumentCompletions,
  handleSubagentDefaultsCommand,
  scopedModelReferences,
  parseSubagentDefaultsCommand,
  registerSubagentDefaultsCommand,
} from "../extensions/subagent/defaults-command.ts";
import { buildPiArguments, resolveSpec, resolveSubagentDefaults } from "../extensions/subagent/subagent-tool.ts";

async function withTempAgentDir(fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-defaults-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function registry(models = [{ provider: "known", id: "model-a" }, { provider: "known", id: "model-b" }]) {
  return {
    find(provider, id) {
      return models.find((model) => model.provider === provider && model.id === id);
    },
    getAll() {
      return models;
    },
  };
}

function commandContext(modelRegistry = registry(), messages = []) {
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      notify(message, type) {
        messages.push({ message, type });
      },
    },
    modelRegistry,
  };
}

test("subagent config parses default model, all thinking levels, and preserves absent defaults", async () => {
  await withTempAgentDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "subagent.json"),
      JSON.stringify({ defaultModel: "known/model-a", defaultThinkingLevel: "max", otherSetting: true }),
    );
    assert.equal(loadSubagentConfig().defaultModel, "known/model-a");
    assert.equal(loadSubagentConfig().defaultThinkingLevel, "max");
    assert.deepEqual(SUBAGENT_THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

test("config updates preserve unknown keys, clear defaults, and use restrictive permissions", async () => {
  await withTempAgentDir(async (dir) => {
    const configPath = path.join(dir, "subagent.json");
    fs.writeFileSync(configPath, JSON.stringify({ customKey: { keep: true }, defaultModel: "known/model-a", defaultThinkingLevel: "high" }));

    const updated = await updateSubagentDefaults({ defaultModel: "known/model-b", defaultThinkingLevel: "max" });
    assert.equal(updated.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
      customKey: { keep: true },
      defaultModel: "known/model-b",
      defaultThinkingLevel: "max",
    });
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

    const cleared = await updateSubagentDefaults({ defaultModel: null, defaultThinkingLevel: null });
    assert.equal(cleared.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { customKey: { keep: true } });
  });
});

test("cleanup failure after rename does not turn a committed update into an error", async () => {
  await withTempAgentDir(async (dir) => {
    const configPath = path.join(dir, "subagent.json");
    const originalRemove = fs.promises.rm;
    fs.promises.rm = async () => {
      throw new Error("simulated cleanup failure");
    };
    try {
      const result = await updateSubagentDefaults({ defaultThinkingLevel: "high" });
      assert.equal(result.ok, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { defaultThinkingLevel: "high" });
    } finally {
      fs.promises.rm = originalRemove;
    }
  });
});

test("malformed config is readable as defaults but never overwritten", async () => {
  await withTempAgentDir(async (dir) => {
    const configPath = path.join(dir, "subagent.json");
    fs.writeFileSync(configPath, "{ definitely not json");
    assert.equal(loadSubagentConfig().defaultModel, undefined);
    const result = await updateSubagentDefaults({ defaultThinkingLevel: "medium" });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(configPath, "utf8"), "{ definitely not json");
  });
});

test("model references use strict registry lookup and canonical metadata", () => {
  const models = registry([{ provider: "provider", id: "model-id" }]);
  assert.equal(canonicalModelReference("provider/model-id", models), "provider/model-id");
  assert.equal(canonicalModelReference("provider/unknown", models), undefined);
  assert.equal(canonicalModelReference("model-id", models), undefined);
});

test("subagent-defaults command parser documents the supported forms", () => {
  assert.deepEqual(parseSubagentDefaultsCommand(""), { kind: "interactive" });
  assert.deepEqual(parseSubagentDefaultsCommand("show"), { kind: "show" });
  assert.deepEqual(parseSubagentDefaultsCommand("model provider/model-id"), { kind: "set-model", value: "provider/model-id" });
  assert.deepEqual(parseSubagentDefaultsCommand("thinking MAX"), { kind: "set-thinking", value: "max" });
  assert.deepEqual(parseSubagentDefaultsCommand("clear model"), { kind: "clear", field: "model" });
  assert.deepEqual(parseSubagentDefaultsCommand("reset"), { kind: "clear" });
  assert.equal(parseSubagentDefaultsCommand("thinking nope").kind, "set-thinking");
  assert.match(parseSubagentDefaultsCommand("wat").message, /Usage/);
});

test("argument completions stay valid by command stage", () => {
  assert.deepEqual(
    getSubagentDefaultsArgumentCompletions("").map((item) => item.value),
    ["show", "status", "list", "model", "thinking", "clear", "reset"],
  );
  assert.deepEqual(
    getSubagentDefaultsArgumentCompletions("thinking ").map((item) => item.value),
    ["thinking off", "thinking minimal", "thinking low", "thinking medium", "thinking high", "thinking xhigh", "thinking max", "thinking clear"],
  );
  assert.deepEqual(
    getSubagentDefaultsArgumentCompletions("thinking h").map((item) => item.value),
    ["thinking high"],
  );
  assert.deepEqual(
    getSubagentDefaultsArgumentCompletions("model ", ["known/model-b", "known/model-a"]).map((item) => item.value),
    ["model clear", "model known/model-a", "model known/model-b"],
  );
  assert.deepEqual(
    getSubagentDefaultsArgumentCompletions("clear ").map((item) => item.value),
    ["clear model", "clear thinking"],
  );
});

test("registered command completions use only the scoped model snapshot", () => {
  const registrations = [];
  let sessionStart;
  registerSubagentDefaultsCommand({
    on(event, handler) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(name, definition) {
      registrations.push({ name, definition });
    },
  });
  sessionStart({}, {
    modelRegistry: registry([{ provider: "known", id: "model-a" }, { provider: "registry-only", id: "model-z" }]),
    scopedModels: [{ model: { provider: "known", id: "model-a" } }],
  });
  const definition = registrations[0].definition;
  assert.deepEqual(
    definition.getArgumentCompletions("model ").map((item) => item.value),
    ["model clear", "model known/model-a"],
  );
  assert.equal(definition.getArgumentCompletions("model ").some((item) => item.value.includes("model-z")), false);
  assert.deepEqual(definition.getArgumentCompletions("thinking h").map((item) => item.value), ["thinking high"]);
  assert.deepEqual(definition.getArgumentCompletions("clear ").map((item) => item.value), ["clear model", "clear thinking"]);
});

test("scoped model references are deduplicated without consulting a registry", () => {
  assert.deepEqual(
    scopedModelReferences([
      { model: { provider: "known", id: "model-b" } },
      { model: { provider: "known", id: "model-a" } },
      { model: { provider: "known", id: "model-a" } },
    ]),
    ["known/model-a", "known/model-b"],
  );
});

test("interactive model picker uses only scoped models and warns when scope is empty", async () => {
  await withTempAgentDir(async () => {
    const scopedSelectCalls = [];
    const scopedMessages = [];
    const scopedContext = {
      hasUI: true,
      mode: "tui",
      scopedModels: [{ model: { provider: "known", id: "model-a" } }],
      modelRegistry: registry([
        { provider: "known", id: "model-a" },
        { provider: "registry-only", id: "model-z" },
      ]),
      ui: {
        select(title, options) {
          scopedSelectCalls.push({ title, options });
          return title === "Subagent defaults" ? "Set default model" : options[0];
        },
        notify(message, type) {
          scopedMessages.push({ message, type });
        },
      },
    };
    await handleSubagentDefaultsCommand("", scopedContext);
    assert.deepEqual(scopedSelectCalls[1].options, ["known/model-a"]);
    assert.equal(scopedSelectCalls[1].options.includes("registry-only/model-z"), false);
    assert.equal(scopedMessages.length, 1);

    const emptySelectCalls = [];
    const emptyMessages = [];
    const emptyContext = {
      ...scopedContext,
      scopedModels: [],
      ui: {
        select(title, options) {
          emptySelectCalls.push({ title, options });
          return "Set default model";
        },
        notify(message, type) {
          emptyMessages.push({ message, type });
        },
      },
    };
    await handleSubagentDefaultsCommand("", emptyContext);
    assert.equal(emptySelectCalls.length, 1);
    assert.match(emptyMessages.at(-1).message, /no scoped models/i);
    assert.match(emptyMessages.at(-1).message, /--models/);
  });
});

test("command persists known models without changing the main agent and rejects unknown models", async () => {
  await withTempAgentDir(async () => {
    const messages = [];
    const context = commandContext(registry(), messages);
    await handleSubagentDefaultsCommand("model known/model-a", context);
    assert.equal(loadSubagentConfig().defaultModel, "known/model-a");
    assert.match(messages.at(-1).message, /main agent model was not changed/);

    const before = fs.readFileSync(getSubagentConfigPath(), "utf8");
    await handleSubagentDefaultsCommand("model known/missing", context);
    assert.equal(fs.readFileSync(getSubagentConfigPath(), "utf8"), before);
    assert.equal(loadSubagentConfig().defaultModel, "known/model-a");
  });
});

test("command writes thinking max and clears only the requested default", async () => {
  await withTempAgentDir(async () => {
    const context = commandContext();
    await handleSubagentDefaultsCommand("model known/model-a", context);
    await handleSubagentDefaultsCommand("thinking max", context);
    assert.equal(loadSubagentConfig().defaultThinkingLevel, "max");
    await handleSubagentDefaultsCommand("clear model", context);
    assert.equal(loadSubagentConfig().defaultModel, undefined);
    assert.equal(loadSubagentConfig().defaultThinkingLevel, "max");
    assert.match(formatSubagentDefaults(loadSubagentConfig()), /thinking: max/);
  });
});

test("resolution precedence is explicit call, named frontmatter, resume metadata, then defaults", async () => {
  await withTempAgentDir(async (dir) => {
    const defaults = { defaultModel: "default/model", defaultThinkingLevel: "minimal" };
    const named = resolveSpec(
      { agent: "reviewer", model: "explicit/model", thinking: "high", task: "review" },
      [{ name: "reviewer", description: "review", systemPrompt: "review", model: "named/model", thinking: "low", source: "user", filePath: "agent.md" }],
      0,
      defaults,
    );
    assert.equal(named.spec.model, "explicit/model");
    assert.equal(named.spec.thinking, "high");

    const namedInherited = resolveSpec(
      { agent: "reviewer", task: "review" },
      [{ name: "reviewer", description: "review", systemPrompt: "review", model: "named/model", thinking: "low", source: "user", filePath: "agent.md" }],
      0,
      defaults,
    );
    assert.equal(namedInherited.spec.model, "named/model");
    assert.equal(namedInherited.spec.thinking, "low");

    const sessionsDir = path.join(dir, "subagent-sessions");
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, "resume-1.jsonl"), "");
    fs.writeFileSync(
      path.join(sessionsDir, "resume-1.meta.json"),
      JSON.stringify({ name: "old", systemPrompt: "old", model: "resume/model", thinking: "medium" }),
    );
    const resumed = resolveSpec({ resume: "resume-1", task: "continue" }, [], 0, defaults);
    assert.equal(resumed.spec.model, "resume/model");
    assert.equal(resumed.spec.thinking, "medium");

    const resumedOverride = resolveSpec({ resume: "resume-1", model: "explicit/model", thinking: "max", task: "continue" }, [], 0, defaults);
    assert.equal(resumedOverride.spec.model, "explicit/model");
    assert.equal(resumedOverride.spec.thinking, "max");

    fs.writeFileSync(path.join(sessionsDir, "resume-missing.jsonl"), "");
    fs.writeFileSync(
      path.join(sessionsDir, "resume-missing.meta.json"),
      JSON.stringify({ name: "old-missing", systemPrompt: "old" }),
    );
    const resumedMissingMetadata = resolveSpec({ resume: "resume-missing", task: "continue" }, [], 0, defaults);
    assert.equal(resumedMissingMetadata.spec.model, undefined);
    assert.equal(resumedMissingMetadata.spec.thinking, undefined);
    assert.deepEqual(
      buildPiArguments(resumedMissingMetadata.spec, "/tmp/resume-task.md"),
      ["--mode", "json", "-p", "--session", resumedMissingMetadata.spec.sessionFile, "@/tmp/resume-task.md"],
    );

    const inline = resolveSpec({ systemPrompt: "inline", task: "do" }, [], 0, defaults);
    assert.equal(inline.spec.model, "default/model");
    assert.equal(inline.spec.thinking, "minimal");
  });
});

test("future calls observe defaults written during the current session", async () => {
  await withTempAgentDir(async () => {
    const modelRegistry = registry();
    await handleSubagentDefaultsCommand("model known/model-b", commandContext(modelRegistry));
    await handleSubagentDefaultsCommand("thinking high", commandContext(modelRegistry));
    assert.deepEqual(resolveSubagentDefaults(loadSubagentConfig(), modelRegistry), {
      defaultModel: "known/model-b",
      defaultThinkingLevel: "high",
    });
  });
});

test("effective thinking max is passed to child pi arguments", () => {
  assert.deepEqual(
    buildPiArguments({ sessionFile: "/tmp/child.jsonl", model: "known/model-a", tools: undefined, thinking: "max" }, "/tmp/task.md"),
    ["--mode", "json", "-p", "--session", "/tmp/child.jsonl", "--model", "known/model-a", "--thinking", "max", "@/tmp/task.md"],
  );
});
