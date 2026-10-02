# @nilskluewer/pi-subagent

One `subagent` tool for Pi. It runs a task in an isolated `pi` child process and returns the answer **and the exact cost of the run**.

Everything else is left to Pi:

| Need | Use |
|---|---|
| Parallel runs, chains, merge or filter results | the built-in [`codemode`](https://github.com/earendil-works/pi) tool (`Promise.all` over `tools.subagent`) |
| Cost per run | the result header and `cost` field |
| Cost per session | Pi's own totals: the tool result carries `usage`, so the footer and `/session` include it |
| Stop a run | `Esc` (the abort kills the child's process group) |
| Durable, crash-proof agents | [Pi Durable](https://earendil.com/posts/pi-durable/), a separate framework |

The extension is about 570 lines (was about 4,300). Version 0.9.0 removed the live panel, background runs, nested delegation, context forking, the approval coordinator, and the `/subagent-*` commands. See [Migrating](#migrating-from-08).

## Install

```bash
pi install npm:@nilskluewer/pi-subagent     # or: pi install git:github.com/nilskluewer/pi-subagent
```

Turn on codemode for orchestration (`defaultTools: ["+codemode"]` in `~/.pi/agent/settings.json`, see the Pi docs).

## The tool

```jsonc
{ "task": "Review src/auth.ts", "systemPrompt": "You are a security reviewer.", "name": "security",
  "model": "anthropic-vertex/claude-sonnet-5:high", "tools": "read,grep,find,ls" }
```

| Parameter | Meaning |
|---|---|
| `task` | Required. The child starts with an empty context, so include everything it needs. |
| `agent` / `systemPrompt` / `resume` | At most one. A named agent, an inline persona, or the session id of an earlier run. |
| `name` | Display label. |
| `model` | `provider/model-id[:thinking]`. Levels: `off minimal low medium high xhigh max`. |
| `tools` | Comma-separated allowlist. Default: the tools the caller has (see [Tool inheritance](#tool-inheritance)). |
| `cwd` | Working directory of the child. |

The result starts with a header:

```text
[agent: reviewer | model: github-copilot/gpt-6-luna | status: completed | cost: $0.0042 | turns: 3 | session: 0197c0de-…]

Result text…
```

- A failed or aborted run still returns its partial text, its cost, and (when aborted) a `resume` hint.
- The text shown to the model is capped at about 16 KB. The full text is in `<sessionsDir>/<id>.output.md`, and a note names the file.
- Sessions live in `~/.pi/agent/subagent-sessions/<id>.jsonl` with a `<id>.meta.json` that re-applies the persona on `resume`.

## Cost

The tool result has a `usage` field. Pi adds it to the session totals, so the footer and `/session` include the subagent cost. This is also true when the call runs inside a `codemode` script: the script result carries the sum of its nested calls.

Each result also has its own `cost`, `turns`, and `tokens`, so you can see which subagent was expensive.

Custom footers must count `toolResult` usage as well as assistant usage. [pi-cost-transparency-statusline](https://github.com/nilskluewer/pi-cost-transparency-statusline) does.

## Parallel work with codemode

The tool declares an `outputSchema`, so a script gets an object: `{ text, status, sessionId, agent, model, cost, turns, tokens, errorMessage?, outputFile? }`. Only what the script returns reaches the parent context.

Fan out and merge:

```js
const files = ["src/auth.ts", "src/session.ts", "src/token.ts"];
const runs = await Promise.allSettled(
  files.map((file) => tools.subagent({ agent: "reviewer", name: file, task: `Review ${file}. Reply with at most 5 bullet points.` })),
);
const ok = runs.filter((r) => r.status === "fulfilled").map((r) => r.value);
return {
  cost: ok.reduce((sum, r) => sum + r.cost, 0),
  reviews: ok.map((r) => `## ${r.agent} (${r.status})\n${r.text}`).join("\n\n"),
  failed: runs.filter((r) => r.status === "rejected").map((r) => String(r.reason)),
};
```

Chain, with a resume:

```js
const review = await tools.subagent({ agent: "reviewer", task: "Review the diff of HEAD~1." });
// … apply fixes with other tools here …
const verify = await tools.subagent({ resume: review.sessionId, task: "I applied your fixes. Verify them." });
return { review: review.text, verify: verify.text, cost: review.cost + verify.cost };
```

Keep run ids across scripts with `store("runs", [...])` and `load("runs")`. A script has no checkpoints. If Pi exits during a script, the children stop with it. Resume them by session id.

## Named agents

`~/.pi/agent/agents/<name>.md`:

```markdown
---
name: reviewer
description: Read-only reviewer
model: anthropic-vertex/claude-sonnet-5:medium
tools: read, grep, find, ls
---

System prompt goes here.
```

Model precedence: the call, then the agent file (or the resumed session), then `defaultModel` in `subagent.json`.

## Configuration

`~/.pi/agent/subagent.json` is optional and is read on every call:

```jsonc
{
  "defaultModel": "anthropic-vertex/claude-sonnet-5:medium",
  "allowedModels": ["github-copilot/gpt-6-luna:max", "anthropic-vertex/claude-sonnet-5:medium"]
}
```

`allowedModels` limits every subagent to these exact `provider/model:thinking` values. The first entry is the default. An empty or malformed list blocks all calls. Other keys from older versions are ignored.

## How it works

- The child is `pi --mode json -p --session <file>`. The extension folds its JSONL events into one result, summing `usage` of each assistant message. The task goes to the child in an `@file` argument, not in argv.
- The child runs in its own process group on macOS and Linux. An abort sends `SIGTERM`, then `SIGKILL` after 5 s. On Windows only the child itself is signalled.
- Children get `PI_SUBAGENT=1`, `PI_SUBAGENT_NAME`, `PI_SUBAGENT_SESSION_ID`, and exit if the parent dies. Children do not get the `subagent` tool, so delegation is one level deep. The parent orchestrates.
- `PI_SUBAGENT_INHERITED_TOOLS` lists the parent's active tools, or the `tools` allowlist. It re-activates tools that exist only after an in-session activation, such as MCP bridges (see [pi-atlassian-mcp](https://github.com/nilskluewer/pi-atlassian-mcp)).

## Tool inheritance

A child loads the same extensions as the parent and gets the parent's active tools through `PI_SUBAGENT_INHERITED_TOOLS`. Pass `tools` to narrow this.

## Migrating from 0.8

| Removed | Instead |
|---|---|
| `async`, `subagent_wait`, `subagent_stop`, `/subagent-stop` | `Promise.all` in codemode, or several calls in one turn. Stop with `Esc`. |
| Live panel, `F8`, `/subagent-panel` | The footer shows total cost. Each result shows its own. |
| `forkContext` | Put the needed context in `task`. |
| Nested subagents, `maxDepth`, `maxLiveChildren` | Orchestrate from the parent with codemode. |
| `resultCapTokens`, result envelope | Fixed 16 KB cap, full text in `structuredContent` and on disk. |
| `agentScope`, project-local agents | Only `~/.pi/agent/agents`. |
| Approval coordinator socket | None. Children use whatever permission extension they load. |
| `/subagent-defaults`, `delegationPolicy` | Edit `subagent.json`. The tool carries its own usage guidelines. |

## License

MIT
