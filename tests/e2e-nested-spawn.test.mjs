import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const MODEL = "github-copilot/gpt-5.6-luna";

test("opt-in E2E nested subagent spawn reaches depth 2 and propagates output", { skip: process.env.PI_SUBAGENT_E2E === "1" ? false : "Set PI_SUBAGENT_E2E=1 to run the real nested-spawn E2E test." }, async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-e2e-"));
  const sessionsDir = path.join(agentDir, "subagent-sessions");
  // The sandboxed PI_CODING_AGENT_DIR needs real credentials and the model registry,
  // otherwise the spawned pi cannot resolve/authenticate the pinned model.
  const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  if (!fs.existsSync(path.join(realAgentDir, "auth.json"))) {
    fs.rmSync(agentDir, { recursive: true, force: true });
    t.skip(`No auth.json in ${realAgentDir}; log in with pi first to run the E2E test.`);
    return;
  }
  for (const file of ["auth.json", "models-store.json", "model-toggles.json"]) {
    const source = path.join(realAgentDir, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(agentDir, file));
  }
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [path.resolve("extensions/subagent")] }, null, 2));
  fs.writeFileSync(path.join(agentDir, "subagent.json"), JSON.stringify({ maxDepth: 2, maxLiveChildren: 4, budgetAcquireTimeoutMs: 120000 }, null, 2));
  const prompt = [
    "Use the subagent tool exactly once at the root.",
    "The depth-1 subagent must use the subagent tool exactly once to spawn a depth-2 subagent.",
    "For the root-to-depth-1 subagent call, set the model parameter exactly to github-copilot/gpt-5.6-luna.",
    "For the depth-1-to-depth-2 subagent call, set the model parameter exactly to github-copilot/gpt-5.6-luna.",
    "The depth-2 subagent should answer exactly DEPTH2_OK and do no file edits.",
    "The depth-1 subagent should return the depth-2 output verbatim.",
    "The root should return only the final propagated marker.",
  ].join("\n");

  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.PI_SUBAGENT_E2E;
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT")) delete env[key];
  }

  const child = spawn("pi", ["--mode", "json", "--model", MODEL, "-p", prompt], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  try {
    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /DEPTH2_OK/);

    const metas = fs.readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".meta.json"))
      .map((name) => ({ id: name.replace(/\.meta\.json$/, ""), meta: JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf-8")) }));
    const depth1 = metas.find(({ id, meta }) => meta.rootId === id && !meta.parent);
    const depth2 = metas.find(({ meta }) => meta.parent && meta.rootId === depth1?.id);
    assert.ok(depth1, "expected a depth-1 meta self-anchored by rootId");
    assert.ok(depth2, "expected a depth-2 meta with parent and rootId lineage");
    assert.equal(depth1.meta.model, MODEL);
    assert.equal(depth2.meta.model, MODEL);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
