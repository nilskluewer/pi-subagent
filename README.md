# @nilskluewer/pi-subagent

One `subagent` tool for Pi. It runs a task in an isolated `pi` child process and returns the answer **and the exact cost of the run**.

**0.11.0:** Add F8 to open subagent sessions and per-call spending limits (default: $10 or 100 turns).

Everything else is left to Pi:

| Need | Use |
|---|---|
| Parallel runs, chains, merge or filter results | the built-in [`codemode`](https://github.com/earendil-works/pi) tool (`Promise.all` over `tools.subagent`) |
| Live model, tokens, time, and cost | the automatic worker widget, also inside `codemode` |
| Cost per run | the result header and `cost` field |
| Cost per session | Pi's own totals: the tool result carries `usage`, so the footer and `/session` include it |
| Stop a run | `Esc` (the abort kills the child's process group) |
| Durable, crash-proof agents | [Pi Durable](https://earendil.com/posts/pi-durable/), a separate framework |

Version 0.9.0 removed the legacy live panel, background runs, nested delegation, context forking, the approval coordinator, and the `/subagent-*` commands. A compact worker widget now provides live metadata without a separate panel or background orchestration. See [Migrating](#migrating-from-08).

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
| `maxCost` | Reported assistant-cost stop threshold in USD for this call. Default: **10**. Must be finite and greater than zero. |
| `maxTurns` | Maximum assistant responses for this call, including retries. Default: **100**. Must be a positive safe integer. |

The result starts with a header:

```text
[agent: reviewer | model: github-copilot/gpt-6-luna | status: completed | cost: $0.0042 | turns: 3 | session: 0197c0de-…]

Result text…
```

- A failed or aborted run still returns its partial text, its cost, and (when aborted) a `resume` hint.
- The text shown to the model is capped at about 16 KB. The full text is in `<sessionsDir>/<id>.output.md`, and a note names the file.
- Sessions live in `~/.pi/agent/subagent-sessions/<id>.jsonl` with a `<id>.meta.json` that re-applies the persona on `resume`.

## Live workers

In Pi's interactive terminal, a widget above the editor appears as soon as a child process starts. It works for direct calls and calls inside `codemode`, even when the script returns only `run.text`.

```text
Subagents · 2 active · running Σ $0.0042 reported
├─ ◐ reviewer  github-copilot/gemini-4-argon · think medium (set)
│   00:24 · ↑1.2k ↓830 tokens · $0.0031 reported
│   Checking the error handling…
└─ ◐ tests  github-copilot/claude-sonnet-5.5 · think medium (set)
    00:11 · ↑1.0k ↓420 tokens · $0.0011 reported
    bash · npm test
```

- Model and thinking settings appear at dispatch. `(requested)` marks an unconfirmed model; `(set)` marks a configured thinking level. Reported model and thinking values replace these when the child emits them.
- Each worker shows its **subagent-session cost**, including previous runs on resume. `running Σ` sums only sessions with active workers, not completed sessions and not the main model.
- Time and the activity indicator update while a worker waits. Tokens and costs update when the provider reports usage; some providers report it only at the end of a response. They are not estimates or a percentage-complete indicator.
- The preview shows the latest normal assistant text, or current tool activity. It does not show internal thinking text. Terminal control sequences are removed before display.
- Completed, failed, and aborted workers shrink to compact rows showing the latest three finished sessions. On narrower terminals, a second line keeps final costs visible.
- **F8 — open subagent** (or `/open-subagent`) lists all child sessions from the current branch, including older hidden rows. Choose one to open its normal Pi session in the same terminal. Exit that Pi with `Ctrl+D` to return to the parent. Opening does not send a model request. While the parent is busy, Pi opens a persistent fork instead, so inspection cannot write to a session that a worker could still change. The fork stays in the normal Pi session directory. New workers can be opened after Pi first saves their session file.
- After the last worker finishes, the overview stays visible for the next user message and disappears on the **second** user message. Messages submitted while workers are active, extension-generated prompts, and commands such as `/reload` do not advance the count. Image-only user messages do count. New workers automatically reopen the overview and start a new count after completion.
- Finished metadata and the message count are saved outside the model context and restored on reload, so hidden results stay hidden without losing their cost data. A new main session clears the display; tree navigation restores the selected branch. The existing footer is not replaced.

JSON, print, and RPC modes do not mount the terminal widget. Structured results still include `model`, `requestedModel`, `thinking`, `requestedThinking`, `cost`, `turns`, and `tokens`. Here `cost` remains **per run**, so adding results does not count old resumed-session costs twice.

## Context boundaries

A new subagent does not receive the main session's conversation. It receives the explicit `task` and loads its own system and project instructions. It can access files through its tools, so conversation isolation is **not** a filesystem or permission boundary. A resumed subagent receives its own saved history, not the main session's history.

The main session receives the final response and metadata, not every child tool call or assistant message. With `codemode`, only values printed or returned by the script enter the main model's context. The worker widget is independent of that output filter.

## Cost

The tool result has a `usage` field. Pi adds it to the session totals, so the footer and `/session` include the subagent cost. This is also true when the call runs inside a `codemode` script: the script result carries the sum of its nested calls.

Each result also has its own `cost`, `turns`, and `tokens`, so you can see which subagent was expensive.

Custom footers must count `toolResult` usage as well as assistant usage. [pi-cost-transparency-statusline](https://github.com/nilskluewer/pi-cost-transparency-statusline) does.

### Spending limits

Each call stops when either `maxCost` or `maxTurns` is reached. Set smaller or larger limits on the call:

```js
await tools.subagent({ task: "Review the diff.", maxCost: 2, maxTurns: 20 });
```

The child checks after each assistant response, before it executes that response's tools or sends another model request. A limit stop returns `status: "aborted"`, a clear `errorMessage`, the last answer, and the reported usage. Each `resume` call gets a fresh allowance; previous session costs do not count against it. These are per-call limits, not a shared budget across parallel children or recovery calls.

**The cost threshold is not a hard billing cap.** A single response can exceed it before usage arrives. Only reported assistant costs are counted, as in the result's `cost` field; missing usage, tool-internal model calls, compaction, and other provider charges are not covered. Set an enforced provider budget for billing protection.

## Parallel work with codemode

The tool declares an `outputSchema`, so a script gets an object: `{ text, status, sessionId, agent, model?, requestedModel?, thinking?, requestedThinking?, cost, turns, tokens, errorMessage?, outputFile? }`. Only what the script returns reaches the parent context.

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

- The child is `pi --mode json -p --session <file> --extension <limits.ts>`. The limits extension is loaded explicitly, including when the parent extension was loaded only with `-e`. The extension folds the child's JSONL events into one result, summing `usage` of each assistant message. The task goes to the child in an `@file` argument, not in argv.
- The child runs in its own process group on macOS and Linux. An abort sends `SIGTERM`, then `SIGKILL` after 5 s. On Windows only the child itself is signalled.
- Children get `PI_SUBAGENT=1`, `PI_SUBAGENT_NAME`, `PI_SUBAGENT_SESSION_ID`, `PI_SUBAGENT_MAX_COST`, `PI_SUBAGENT_MAX_TURNS`, and exit if the parent dies. Children do not get the `subagent` tool, so delegation is one level deep. The parent orchestrates.
- `PI_SUBAGENT_INHERITED_TOOLS` lists the parent's active tools, or the `tools` allowlist. It re-activates tools that exist only after an in-session activation, such as MCP bridges (see [pi-atlassian-mcp](https://github.com/nilskluewer/pi-atlassian-mcp)).

## Tool inheritance

A child loads the same extensions as the parent and gets the parent's active tools through `PI_SUBAGENT_INHERITED_TOOLS`. Pass `tools` to narrow this.

## Migrating from 0.8

| Removed | Instead |
|---|---|
| `async`, `subagent_wait`, `subagent_stop`, `/subagent-stop` | `Promise.all` in codemode, or several calls in one turn. Stop with `Esc`. |
| Live panel, `/subagent-panel` | Automatic worker widget for live metadata; footer for total session cost. `F8` now opens a child session. |
| `forkContext` | Put the needed context in `task`. |
| Nested subagents, `maxDepth`, `maxLiveChildren` | Orchestrate from the parent with codemode. |
| `resultCapTokens`, result envelope | Fixed 16 KB cap, full text in `structuredContent` and on disk. |
| `agentScope`, project-local agents | Only `~/.pi/agent/agents`. |
| Approval coordinator socket | None. Children use whatever permission extension they load. |
| `/subagent-defaults`, `delegationPolicy` | Edit `subagent.json`. The tool carries its own usage guidelines. |

## Development checks

```bash
npm test             # unit tests and offline real-Pi spending-limit tests
npm run smoke        # load the packed package in a real Pi process
npm run test:tui     # real TUI -> codemode -> two real child processes; requires pi + tmux
```

The TUI check uses an isolated agent directory and an offline fixture provider. It checks live metadata, completion, F8 session opening and return, safe forking while busy, reload, resume costs, session reset, Escape cancellation, dismissal after two user messages, and automatic reopening without model costs or user credentials.

## License

MIT
