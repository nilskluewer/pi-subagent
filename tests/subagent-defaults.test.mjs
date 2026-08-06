import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  canonicalModelReference,
  getSubagentConfigPath,
  loadSubagentConfig,
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
import { buildPiArguments, registerSubagentTool, resolveSpec, resolveSubagentDefaults } from "../extensions/subagent/subagent-tool.ts";

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
    getAvailable() {
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

test("subagent config parses the combined model default", async () => {
  await withTempAgentDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "subagent.json"),
      JSON.stringify({ defaultModel: "known/model-a:high", otherSetting: true }),
    );
    assert.equal(loadSubagentConfig().defaultModel, "known/model-a:high");
  });
});

test("config updates preserve unknown keys, clear the model default, and use restrictive permissions", async () => {
  await withTempAgentDir(async (dir) => {
    const configPath = path.join(dir, "subagent.json");
    fs.writeFileSync(configPath, JSON.stringify({ customKey: { keep: true }, defaultModel: "known/model-a:high" }));

    const updated = await updateSubagentDefaults({ defaultModel: "known/model-b:medium" });
    assert.equal(updated.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
      customKey: { keep: true },
      defaultModel: "known/model-b:medium",
    });
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

    const cleared = await updateSubagentDefaults({ defaultModel: null });
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
      const result = await updateSubagentDefaults({ defaultModel: "known/model-a:high" });
      assert.equal(result.ok, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { defaultModel: "known/model-a:high" });
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
    const result = await updateSubagentDefaults({ defaultModel: "known/model-a:high" });
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
  assert.deepEqual(parseSubagentDefaultsCommand("model provider/model-id:high"), { kind: "set-model", value: "provider/model-id:high" });
  assert.deepEqual(parseSubagentDefaultsCommand("clear model"), { kind: "clear", field: "model" });
  assert.deepEqual(parseSubagentDefaultsCommand("reset"), { kind: "clear" });
  assert.equal(parseSubagentDefaultsCommand("thinking max").kind, "invalid");
  assert.match(parseSubagentDefaultsCommand("wat").message, /Usage/);
});

test("argument completions stay valid by command stage", () => {
  assert.deepEqual(
    getSubagentDefaultsArgumentCompletions("").map((item) => item.value),
    ["show", "status", "list", "model", "clear", "reset"],
  );
  assert.deepEqual(
    getSubagentDefaultsArgumentCompletions("model ", ["known/model-b", "known/model-a"]).map((item) => item.value),
    ["model clear", "model known/model-a", "model known/model-b"],
  );
  assert.deepEqual(
    getSubagentDefaultsArgumentCompletions("clear ").map((item) => item.value),
    ["clear model"],
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
  assert.equal(definition.getArgumentCompletions("thinking h"), null);
  assert.deepEqual(definition.getArgumentCompletions("clear ").map((item) => item.value), ["clear model"]);
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

test("interactive model picker uses scoped models and falls back to available models", async () => {
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
    assert.equal(emptySelectCalls.length, 2);
    assert.deepEqual(emptySelectCalls[1].options, ["known/model-a", "registry-only/model-z"]);
    assert.equal(emptyMessages.length, 1);
  });
});

test("subagent tool definition uses one required task and concise guidance", async () => {
  await withTempAgentDir(async () => {
    let definition;
    registerSubagentTool({
      registerTool(value) {
        definition = value;
      },
    });
    assert.equal(definition.promptSnippet, "Delegate a self-contained task to a separate Pi agent.");
    assert.match(definition.description, /one task/);
    assert.match(definition.description, /same assistant turn/);
    assert.match(definition.description, /previous result/);
    assert.equal(definition.parameters.properties.thinking, undefined);
    assert.match(definition.parameters.properties.model.description, /provider\/model-id\[:thinking-level\]/);
    assert.equal(definition.parameters.properties.async.type, "boolean");
    assert.deepEqual(definition.parameters.required, ["task"]);
  });
});

test("model schema uses the configured allowlist enum and otherwise stays free-form", async () => {
  await withTempAgentDir(async (dir) => {
    fs.writeFileSync(
      path.join(dir, "subagent.json"),
      JSON.stringify({ allowedModels: ["known/model-a:high", "known/model-b:medium"] }),
    );
    const definitions = [];
    registerSubagentTool({ registerTool(value) { definitions.push(value); } });
    const subagent = definitions.find((value) => value.name === "subagent");

    assert.deepEqual(subagent.parameters.properties.model.enum, ["known/model-a:high", "known/model-b:medium"]);
    assert.match(subagent.parameters.properties.model.description, /must be one of/);

    fs.rmSync(path.join(dir, "subagent.json"));
    const withoutAllowlist = [];
    registerSubagentTool({ registerTool(value) { withoutAllowlist.push(value); } });
    const freeForm = withoutAllowlist.find((value) => value.name === "subagent");
    assert.equal(freeForm.parameters.properties.model.enum, undefined);
    assert.equal(freeForm.parameters.properties.model.type, "string");
  });
});

test("subagent schemas expose no legacy modes or minimum string and array constraints", async () => {
  await withTempAgentDir(async () => {
    const definitions = [];
    registerSubagentTool({
      registerTool(value) {
        definitions.push(value);
      },
    });
    const definition = definitions.find((value) => value.name === "subagent");
    const waitDefinition = definitions.find((value) => value.name === "subagent_wait");
    const properties = definition.parameters.properties;
    assert.deepEqual(Object.keys(waitDefinition.parameters.properties).sort(), ["all", "id", "timeoutMs"]);
    assert.equal(properties.tasks, undefined);
    assert.equal(properties.chain, undefined);

    const forbidden = new Set(["minLength", "minItems", "maxItems"]);
    function assertNoForbiddenConstraints(value, location = "parameters") {
      if (!value || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        assert.equal(forbidden.has(key), false, `${location}.${key} must not be present`);
        assertNoForbiddenConstraints(nested, `${location}.${key}`);
      }
    }
    assertNoForbiddenConstraints(definition.parameters);
    assertNoForbiddenConstraints(waitDefinition.parameters);
  });
});

test("command persists known models without changing the main agent and rejects unknown models", async () => {
  await withTempAgentDir(async () => {
    const messages = [];
    const context = commandContext(registry(), messages);
    await handleSubagentDefaultsCommand("model known/model-a:high", context);
    assert.equal(loadSubagentConfig().defaultModel, "known/model-a:high");
    assert.match(messages.at(-1).message, /main agent model was not changed/);

    const before = fs.readFileSync(getSubagentConfigPath(), "utf8");
    await handleSubagentDefaultsCommand("model known/missing", context);
    assert.equal(fs.readFileSync(getSubagentConfigPath(), "utf8"), before);
    assert.equal(loadSubagentConfig().defaultModel, "known/model-a:high");
  });
});

test("command clears the model default", async () => {
  await withTempAgentDir(async () => {
    const context = commandContext();
    await handleSubagentDefaultsCommand("model known/model-a:high", context);
    await handleSubagentDefaultsCommand("clear model", context);
    assert.equal(loadSubagentConfig().defaultModel, undefined);
    assert.doesNotMatch(formatSubagentDefaults(loadSubagentConfig()), /default thinking/);
  });
});

test("model resolution uses explicit, named, resumed, then configured model specifications", async () => {
  await withTempAgentDir(async (dir) => {
    const modelRegistry = registry([
      { provider: "known", id: "default/model" },
      { provider: "known", id: "explicit/model" },
      { provider: "known", id: "named/model" },
      { provider: "known", id: "resume/model" },
    ]);
    const defaults = { defaultModel: "known/default/model:low" };
    const named = resolveSpec(
      { agent: "reviewer", model: "known/explicit/model:high", task: "review" },
      [{ name: "reviewer", description: "review", systemPrompt: "review", model: "known/named/model:medium", source: "user", filePath: "agent.md" }],
      0,
      defaults,
      modelRegistry,
    );
    assert.equal(named.spec.model, "known/explicit/model:high");
    assert.equal(named.spec.thinking, "high");

    const namedInherited = resolveSpec(
      { agent: "reviewer", task: "review" },
      [{ name: "reviewer", description: "review", systemPrompt: "review", model: "known/named/model:medium", source: "user", filePath: "agent.md" }],
      0,
      defaults,
      modelRegistry,
    );
    assert.equal(namedInherited.spec.model, "known/named/model:medium");
    assert.equal(namedInherited.spec.thinking, "medium");

    const sessionsDir = path.join(dir, "subagent-sessions");
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, "resume-1.jsonl"), "");
    fs.writeFileSync(
      path.join(sessionsDir, "resume-1.meta.json"),
      JSON.stringify({ name: "old", systemPrompt: "old", model: "known/resume/model", thinking: "medium" }),
    );
    const resumed = resolveSpec({ resume: "resume-1", task: "continue" }, [], 0, defaults, modelRegistry);
    assert.equal(resumed.spec.model, "known/resume/model:medium");
    assert.equal(resumed.spec.thinking, "medium");

    const resumedOverride = resolveSpec({ resume: "resume-1", model: "known/explicit/model:max", task: "continue" }, [], 0, defaults, modelRegistry);
    assert.equal(resumedOverride.spec.model, "known/explicit/model:max");
    assert.equal(resumedOverride.spec.thinking, "max");

    fs.writeFileSync(path.join(sessionsDir, "resume-missing.jsonl"), "");
    fs.writeFileSync(
      path.join(sessionsDir, "resume-missing.meta.json"),
      JSON.stringify({ name: "old-missing", systemPrompt: "old" }),
    );
    const resumedMissingMetadata = resolveSpec({ resume: "resume-missing", task: "continue" }, [], 0, defaults, modelRegistry);
    assert.equal(resumedMissingMetadata.spec.model, undefined);
    assert.equal(resumedMissingMetadata.spec.thinking, undefined);
    assert.deepEqual(
      buildPiArguments(resumedMissingMetadata.spec, "/tmp/resume-task.md"),
      ["--mode", "json", "-p", "--session", resumedMissingMetadata.spec.sessionFile, "@/tmp/resume-task.md"],
    );

    const inline = resolveSpec({ systemPrompt: "inline", task: "do" }, [], 0, defaults, modelRegistry);
    assert.equal(inline.spec.model, "known/default/model:low");
    assert.equal(inline.spec.thinking, "low");
  });
});

test("model allowlists override defaults and enforce exact combined specifications", async () => {
  await withTempAgentDir(async () => {
    const modelRegistry = registry();
    const defaults = resolveSubagentDefaults(
      {
        defaultModel: "known/model-b:low",
        allowedModels: [
          { model: "known/model-a", thinking: "high" },
          { model: "known/model-b", thinking: "medium" },
        ],
      },
      modelRegistry,
    );

    const implicit = resolveSpec({ systemPrompt: "inline", task: "run" }, [], 0, defaults, modelRegistry);
    assert.equal(implicit.spec.model, "known/model-a:high");
    assert.equal(implicit.spec.thinking, "high");

    const allowed = resolveSpec(
      { systemPrompt: "inline", model: "known/model-b:medium", task: "run" },
      [],
      0,
      defaults,
      modelRegistry,
    );
    assert.equal(allowed.spec.model, "known/model-b:medium");
    assert.equal(allowed.spec.thinking, "medium");

    const inferredThinking = resolveSpec(
      { systemPrompt: "inline", model: "known/model-b", task: "run" },
      [],
      0,
      defaults,
      modelRegistry,
    );
    assert.equal(inferredThinking.spec.model, "known/model-b:medium");
    assert.equal(inferredThinking.spec.thinking, "medium");

    const rejected = resolveSpec(
      { systemPrompt: "inline", model: "known/model-a:max", task: "run" },
      [],
      0,
      defaults,
      modelRegistry,
    );
    assert.match(rejected.error, /disallowed model/);
    assert.match(rejected.error, /known\/model-a:high/);

    const unknownAllowed = resolveSpec(
      { systemPrompt: "inline", model: "known/missing:high", task: "run" },
      [],
      0,
      defaults,
      modelRegistry,
    );
    assert.match(unknownAllowed.error, /Allowed models: known\/model-a:high, known\/model-b:medium/);
  });
});

test("an invalid configured model allowlist prevents subagent resolution", async () => {
  await withTempAgentDir(async () => {
    const defaults = resolveSubagentDefaults(
      { allowedModels: [] },
      registry(),
    );
    const result = resolveSpec({ systemPrompt: "inline", task: "run" }, [], 0, defaults, registry());
    assert.match(result.error, /must contain at least one valid/);
  });
});

test("an explicit unknown model fails before a child process is started", async () => {
  await withTempAgentDir(async () => {
    const result = resolveSpec(
      { systemPrompt: "inline", model: "unknown/model:high", task: "run" },
      [],
      0,
      {},
      registry(),
    );
    assert.match(result.error, /Unknown subagent model/);
  });
});

test("future calls observe defaults written during the current session", async () => {
  await withTempAgentDir(async () => {
    const modelRegistry = registry();
    await handleSubagentDefaultsCommand("model known/model-b:medium", commandContext(modelRegistry));
    assert.deepEqual(resolveSubagentDefaults(loadSubagentConfig(), modelRegistry), {
      defaultModel: "known/model-b:medium",
    });
  });
});

test("combined model specifications become separate child arguments", () => {
  assert.deepEqual(
    buildPiArguments({ sessionFile: "/tmp/child.jsonl", model: "known/model-a:max", tools: undefined, thinking: "max" }, "/tmp/task.md"),
    ["--mode", "json", "-p", "--session", "/tmp/child.jsonl", "--model", "known/model-a", "--thinking", "max", "@/tmp/task.md"],
  );
});
