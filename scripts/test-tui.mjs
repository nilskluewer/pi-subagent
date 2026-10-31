#!/usr/bin/env node
// Offline E2E: real Pi TUI -> real codemode -> two real child processes.
// The provider is deterministic. No account, network, or model spend is needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "subagent-tui-"));
const agentDir = join(tmp, "agent");
const session = `subagent-test-${process.pid}`;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmux = (...args) => {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout;
};
let pane = "";
async function until(predicate, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    pane = tmux("capture-pane", "-p", "-t", session);
    if (predicate(pane)) return pane;
    await sleep(200);
  }
  throw new Error(`Timed out: ${description}\n${pane}`);
}
try {
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    extensions: [process.env.SUBAGENT_TEST_EXTENSION ?? join(root, "extensions/subagent"), join(root, "tests/fixtures/live-provider.ts")],
    defaultProvider: "worker-fixture", defaultModel: "main", defaultTools: ["+codemode"], quietStartup: true,
  }));
  writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ allowedModels: ["worker-fixture/worker-a:medium", "worker-fixture/worker-b:medium"] }));
  const cmd = `cd ${quote(tmp)} && PI_CODING_AGENT_DIR=${quote(agentDir)} pi --offline --no-mcp --no-skills --no-prompt-templates --no-context-files --model worker-fixture/main --thinking off ${quote("Run offline fixture")}`;
  tmux("new-session", "-d", "-s", session, "-x", "160", "-y", "45", cmd);
  const live = await until((text) => /Subagents · 2 active/.test(text) && /running Σ \$0\.002[246]/.test(text) && /Checking files/.test(text), "model, cumulative live costs and assistant preview while codemode is running");
  assert.match(live, /worker-a\s+worker-fixture\/worker-a · think medium \(set\)/);
  assert.match(live, /worker-b\s+worker-fixture\/worker-b · think medium \(set\)/);
  assert.match(live, /↑1\.0k ↓[123]00 tokens/);
  assert.doesNotMatch(live, /Fixture complete/);
  const done = await until((text) => /Fixture complete/.test(text) && /0 active/.test(text), "completed cards shrink and active cost becomes zero");
  assert.match(done, /running Σ \$0\.0000/);
  for (const id of ["a", "b"]) assert.match(done, new RegExp(`✓ worker-${id}.*completed.*\\$0\\.0014`));
  assert.doesNotMatch(done, /tokens ·/);
  // This is the key codemode boundary: script returned text only, not metadata.
  assert.match(done, /return runs\.map\(r => r\.text\)/);
  tmux("send-keys", "-t", session, "-l", "/reload");
  tmux("send-keys", "-t", session, "Enter");
  const reloaded = await until((text) => /Reloaded keybindings/.test(text) && /✓ worker-a.*\$0\.0014/.test(text), "reload restores finished metadata");
  assert.match(reloaded, /✓ worker-b.*\$0\.0014/);
  tmux("send-keys", "-t", session, "-l", "Resume offline fixture");
  tmux("send-keys", "-t", session, "Enter");
  const resumedLive = await until((text) => /2 active/.test(text) && /running Σ \$0\.005[0246]/.test(text), "resumed sessions include prior model costs without double counting");
  assert.match(resumedLive, /\$0\.002[567] reported/);
  const resumed = await until((text) => /0 active/.test(text) && /✓ worker-a.*\$0\.0028/.test(text) && /✓ worker-b.*\$0\.0028/.test(text), "resumed-session final costs");
  assert.equal(resumed.split("\n").filter((line) => /[├└]─ ✓ worker-/.test(line)).length, 2);
  tmux("send-keys", "-t", session, "-l", "/new");
  tmux("send-keys", "-t", session, "Enter");
  await until((text) => !/Subagents ·/.test(text), "new main session clears worker history");
  tmux("send-keys", "-t", session, "-l", "Run offline fixture again");
  tmux("send-keys", "-t", session, "Enter");
  await until((text) => /2 active/.test(text) && /Checking files/.test(text), "workers restart in new session");
  tmux("send-keys", "-t", session, "Escape");
  const aborted = await until((text) => /0 active/.test(text) && /aborted/.test(text), "Escape stops children and updates cards");
  assert.match(aborted, /running Σ \$0\.0000/);
  assert.match(aborted, /■ worker-a.*aborted.*\$0\.001[1-4]/);
  assert.match(aborted, /■ worker-b.*aborted.*\$0\.001[1-4]/);
  tmux("send-keys", "-t", session, "-l", "Plain follow-up one");
  tmux("send-keys", "-t", session, "Enter");
  const firstFollowUp = await until((text) => /Plain follow-up one/.test(text) && /Fixture complete/.test(text), "first user message after worker completion");
  assert.match(firstFollowUp, /Subagents · 0 active/);
  tmux("send-keys", "-t", session, "-l", "/reload");
  tmux("send-keys", "-t", session, "Enter");
  await until((text) => /Reloaded keybindings/.test(text) && /Subagents · 0 active/.test(text), "reload and commands do not count as user messages");
  tmux("send-keys", "-t", session, "-l", "Plain follow-up two");
  tmux("send-keys", "-t", session, "Enter");
  const hidden = await until((text) => /Plain follow-up two/.test(text) && !/Subagents ·/.test(text), "second user message hides finished workers");
  // A reload must not bring the dismissed overview back.
  tmux("send-keys", "-t", session, "-l", "/reload");
  tmux("send-keys", "-t", session, "Enter");
  await sleep(500);
  assert.doesNotMatch(tmux("capture-pane", "-p", "-t", session), /Subagents ·/);
  tmux("send-keys", "-t", session, "-l", "Run offline fixture after hiding");
  tmux("send-keys", "-t", session, "Enter");
  await until((text) => /Subagents · 2 active/.test(text) && /Checking files/.test(text), "new workers automatically reopen the overview");
  await until((text) => /Subagents · 0 active/.test(text) && /✓ worker-a.*\$0\.0014/.test(text), "newly finished workers get a fresh message countdown");
  console.log("TUI E2E passed: live metadata, completion, reload, resume, session reset, abort, hide after two user messages and reopen on new workers.");
  if (process.env.SUBAGENT_TUI_ARTIFACTS) {
    mkdirSync(process.env.SUBAGENT_TUI_ARTIFACTS, { recursive: true });
    writeFileSync(join(process.env.SUBAGENT_TUI_ARTIFACTS, "live.txt"), live);
    writeFileSync(join(process.env.SUBAGENT_TUI_ARTIFACTS, "completed.txt"), done);
    writeFileSync(join(process.env.SUBAGENT_TUI_ARTIFACTS, "aborted.txt"), aborted);
    writeFileSync(join(process.env.SUBAGENT_TUI_ARTIFACTS, "resumed.txt"), resumed);
    writeFileSync(join(process.env.SUBAGENT_TUI_ARTIFACTS, "first-follow-up.txt"), firstFollowUp);
    writeFileSync(join(process.env.SUBAGENT_TUI_ARTIFACTS, "hidden.txt"), hidden);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  spawnSync("tmux", ["kill-session", "-t", session]);
  rmSync(tmp, { recursive: true, force: true });
}
