import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { resolveSpec, writeSessionMeta } from "../extensions/subagent/subagent-tool.ts";

function withTempAgentDir(fn) {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousParent = process.env.PI_SUBAGENT_SESSION_ID;
  const previousRoot = process.env.PI_SUBAGENT_ROOT_ID;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-graph-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT_SESSION_ID;
  delete process.env.PI_SUBAGENT_ROOT_ID;
  try {
    return fn(dir);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousParent === undefined) delete process.env.PI_SUBAGENT_SESSION_ID;
    else process.env.PI_SUBAGENT_SESSION_ID = previousParent;
    if (previousRoot === undefined) delete process.env.PI_SUBAGENT_ROOT_ID;
    else process.env.PI_SUBAGENT_ROOT_ID = previousRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function spec(sessionId) {
  return {
    name: "worker",
    systemPrompt: "",
    source: "inline",
    sessionId,
    sessionFile: "/tmp/unused.jsonl",
    isResume: false,
    forkContext: { mode: "none" },
  };
}

test("depth-1 session meta self-anchors rootId and has no parent", () => {
  withTempAgentDir((dir) => {
    const s = spec("child-1");
    writeSessionMeta(s, dir);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, "subagent-sessions", "child-1.meta.json"), "utf-8"));
    assert.equal(meta.rootId, "child-1");
    assert.equal(meta.parent, undefined);
    assert.equal(s.rootId, "child-1");
    assert.equal(s.parent, undefined);
  });
});

test("depth-2 session meta uses parent and rootId from the environment", () => {
  withTempAgentDir((dir) => {
    process.env.PI_SUBAGENT_SESSION_ID = "parent-1";
    process.env.PI_SUBAGENT_ROOT_ID = "root-1";

    const s = spec("child-2");
    writeSessionMeta(s, dir);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, "subagent-sessions", "child-2.meta.json"), "utf-8"));
    assert.equal(meta.parent, "parent-1");
    assert.equal(meta.rootId, "root-1");
    assert.equal(s.parent, "parent-1");
    assert.equal(s.rootId, "root-1");
  });
});

test("old-shape session meta resumes with undefined graph fields", () => {
  withTempAgentDir((dir) => {
    const sessionId = "old-session";
    const sessionsDir = path.join(dir, "subagent-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), "");
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.meta.json`), JSON.stringify({ name: "old", systemPrompt: "", createdAt: new Date().toISOString() }));

    const resolved = resolveSpec({ resume: sessionId, task: "continue" }, [], 0);

    assert.ok("spec" in resolved);
    assert.equal(resolved.spec.parent, undefined);
    assert.equal(resolved.spec.rootId, undefined);
  });
});
