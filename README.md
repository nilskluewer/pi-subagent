# @nilskluewer/pi-subagent

<p align="center">
  <img src="https://raw.githubusercontent.com/nilskluewer/pi-subagent/main/docs/assets/agent-tree.png" alt="A delegation run: main agent, coordinator socket, three subagents, capped result envelopes, and persisted session files" width="560" />
</p>

One subagent extension for Pi that covers exactly what a multi-agent workflow needs:

- **`subagent` tool** - delegate one task to an isolated `pi` child process per call.
  Emit several `subagent` calls in the same assistant turn for independent parallel work.
  Call again with the previous result when work depends on an earlier task.
- **`subagent_wait` tool** - collect results from background calls started with `async: true`.
- **Inline-first personas** - pass `systemPrompt` (+ optional `name`, `model`, and `tools`)
  directly in the tool call. Use `model` as `provider/model-id[:thinking-level]`.
  Skills define personas in their own text; no agent files are needed.
- **Tool inheritance** - a subagent starts with the tools the main agent has, including
  extension tools that are activated per session (MCP bridges). Pass `tools` to narrow it.
- **Named agents (optional)** - markdown definitions in `~/.pi/agent/agents/*.md`
  (or project-local `.pi/agents/*.md` with `agentScope: "both"`).
- **Resumable sessions** - every run is a persistent session; pass the returned
  session id as `resume` to continue that agent with full context
  (e.g. reviewer proposes a fix → main agent implements → `resume` the reviewer to verify).
  If a run is aborted, the parent receives the session id, stop reason, and last 10 completed
  assistant messages/tool calls so it can inspect the working tree and resume intelligently.
- **Live widget** - per-agent row above the editor: status, model, current tool, tokens, and
  turns. The configured model is visible immediately; `default` is shown until an inherited
  model resolves. Completed subagent views also show each model.
  Press Ctrl+O on the running tool call to inspect streaming output.
- **Nested delegation with a root budget** - by default, depth-1 subagents can spawn one
  more level of subagents (`maxDepth: 2`). A root-scoped coordinator enforces a default
  tree-wide limit of 4 live child processes. Set `maxDepth: 1` to restore the old hard
  grandchild ban.
- **Parent-side approval coordinator** - dangerous-command policy itself lives in
  [`@nilskluewer/pi-auto-permission-gate`](https://github.com/nilskluewer/pi-auto-permission-gate),
  which loads in the main agent and in every subagent child.
  When a child needs a manual confirmation, the gate proxies it over a Unix socket and the
  prompt appears in the parent TUI labeled with the agent's name; concurrent prompts are
  serialized. Normal `write`/`edit` calls follow the subagent's configured tool allowlist
  without an extra prompt. No UI and no approval channel blocks the call.

Replaces `@nilskluewer/pi-minimal-subagent` (the `delegate` tool).
Install the permission gate extension alongside this one to keep dangerous bash commands
gated in the main agent and in subagents.

## Install

```bash
pi install npm:@nilskluewer/pi-subagent
```

From git:

```bash
pi install git:github.com/nilskluewer/pi-subagent
```

From a local checkout:

```bash
pi install /path/to/pi-subagent
```

## How a delegation runs

Six stations, from the first tool call to a resumable session:

<p align="center">
  <img src="https://raw.githubusercontent.com/nilskluewer/pi-subagent/main/docs/assets/walkthrough.png" alt="Six-step walkthrough: Delegate, Fork, Spawn, Gate, Report, Resume" width="820" />
</p>

There is an animated version of this walkthrough: open
[`docs/one-pager.html`](https://github.com/nilskluewer/pi-subagent/blob/main/docs/one-pager.html)
locally (`open docs/one-pager.html`) for the step-through animation, feature grid,
and config reference on a single page.

## Tool usage

One call with an inline persona:

```jsonc
{ "systemPrompt": "You are a security reviewer...", "name": "security", "model": "anthropic-vertex/claude-sonnet-5:high", "tools": "read,grep,find,ls", "task": "Review src/auth.ts" }
```

`model` accepts an exact `provider/model-id` and an optional `:thinking-level` suffix.
Thinking levels are `off | minimal | low | medium | high | xhigh | max`.
Omit the model to use the configured or child-process default.

For independent work, emit several separate `subagent` calls in the same assistant turn.
Give each call a disjoint write scope so the calls can run concurrently without conflicts.

Continue an agent later (session id is in every result):

```jsonc
{ "resume": "0197c0de-...", "task": "I implemented your fix in src/auth.ts - verify it is correct." }
```

Fork parent context into a new agent session:

```jsonc
{ "agent": "example-researcher", "forkContext": "all", "task": "Continue from the main conversation and inspect the retry logic." }
```

Named agent:

```jsonc
{ "agent": "example-researcher", "task": "Where is the retry logic implemented?" }
```

For dependent work, call `subagent` again with the previous result in the new task.
Pass the returned session id as `resume` when the same agent should continue with its full context.

```jsonc
{ "systemPrompt": "You write concise ADRs.", "name": "adr-writer", "task": "Write an ADR based on the previous review result:\n\n<previous result>" }
```

## Context forking

By default, every subagent starts with an isolated, empty conversation and only the task text you give it.
Set `forkContext` to copy sanitized context from the calling agent into the child session before it starts.
Use `"all"` to fork the full active context, or a positive integer string such as `"3"` to fork the last three user-message turns.
Use `"none"` or omit the field to keep the old isolated behavior.
`forkContext` and `resume` are mutually exclusive because a resumed session already has its own append-only history.
Forking keeps user messages verbatim, keeps assistant text, drops tool noise and thinking, and converts compaction or branch summaries into a synthetic user summary.
Large forks over roughly 8k approximate tokens return a warning and continue.

Examples:

```jsonc
{ "systemPrompt": "You are a focused reviewer.", "name": "reviewer", "forkContext": "all", "task": "Review the current plan using the conversation context." }
{ "agent": "example-researcher", "forkContext": "2", "task": "Use the last two turns of context and find the relevant files." }
```

## Result cap

Non-aborted subagent results returned to the calling model are wrapped in a compact envelope and capped by approximate token count.
Aborted results keep their specialized recovery format, including recent activity and resume guidance, and are not re-capped.
The cap affects only the model-facing tool result text for non-aborted results.
It never truncates the child process, the child session file, or the rich details used by the TUI and Ctrl+O.
The default cap is 1000 approximate tokens.
Set `resultCapTokens` to `0` to disable capping.
Precedence is the call's `resultCapTokens`, then `~/.pi/agent/subagent.json`, then the built-in default of `1000`.
Set the cap separately on each call when several subagents run concurrently.
When a run finishes, its uncapped result payload is written atomically to `<sessionsDir>/<sessionId>.output.md` with restrictive permissions.
If the result is truncated, the envelope points to that artifact first and recommends the normal `read` tool with offsets for inspecting parts of it.
The envelope header includes non-zero cost and turn counts, while zero or unknown cost is omitted.

Envelope example:

```text
[agent: reviewer | model: github-copilot/gpt-5.6-luna | status: completed | cost: $0.0042 | turns: 3 | session: 0197c0de]

Result text...

[truncated: showing ~1000 of ~4200 approx. tokens. Full output: read /Users/me/.pi/agent/subagent-sessions/0197c0de.output.md with the normal read tool; use offsets to inspect parts of it. Then resume session "0197c0de" to continue this agent with full context.]
```

## Subagent configuration

`~/.pi/agent/subagent.json` configures delegation guidance, result capping, nested depth, the root-scoped live-child budget, subagent model defaults, and the optional model allowlist.
The file is optional.
Missing or malformed JSON falls back to safe built-in values, and a malformed file is never overwritten by `/subagent-defaults`.
Policy, cap, depth, and budget changes take effect at the next session start, such as `/new`, `/resume`, `/fork`, `/reload`, or restarting Pi.
The model default changed with `/subagent-defaults` applies to future subagent calls immediately.
Thinking levels are configured in the combined `model` value.
The `allowedModels` policy is read from the live file for every subagent call, so the runtime still enforces the live file immediately after an edit.
The model schema enum snapshots the allowlist when the tools register, so allowlist changes require a Pi session restart before the schema reflects them.
The current scoped model candidates are injected into the system prompt each turn.
When no scope is active, the candidates fall back to Pi's available model registry.

```jsonc
{
  "delegationPolicy": "proactive",
  "resultCapTokens": 1000,
  "defaultModel": "anthropic-vertex/claude-sonnet-5:medium",
  "allowedModels": [
    "github-copilot/gpt-5.6-luna:high",
    "anthropic-vertex/claude-sonnet-5:medium"
  ],
  "maxDepth": 2,
  "maxLiveChildren": 4,
  "budgetAcquireTimeoutMs": 120000
}
```

`allowedModels` is optional.
When present, it overrides `defaultModel` and restricts every subagent to the exact combined values in the list.
Each entry must use `provider/model-id:thinking-level`.
The first entry is the fallback when a call does not specify a model.
An empty or malformed `allowedModels` value fails closed and prevents subagent resolution.

### `/subagent-defaults`

Use `/subagent-defaults` with no arguments in the UI for an interactive picker.
The model picker and model argument completions use scoped models when a scope is active and all available models otherwise.
Configure a session model scope with Pi's `--models` option or the `enabledModels` setting to narrow the candidates.
Use `/subagent-defaults show` to display the current values without changing the main agent model.
Use `/subagent-defaults model <provider/model-id[:thinking]>` to set an exact model specification from Pi's current model registry.
Use `/subagent-defaults clear model` or `/subagent-defaults model clear` to clear the model default.
Use `/subagent-defaults clear` or `/subagent-defaults reset` to clear the model default.
Thinking levels are part of each combined model specification.

Model specifications are validated with Pi's exact registry lookup before they are persisted.
Known models can be configured even when their provider is not currently authenticated.
Unknown models are rejected and are never written to `subagent.json`.
The command preserves unrelated JSON keys and uses a safe atomic update.
The extension splits the combined value into `--model` and `--thinking` when launching a child process.
An explicit tool-call model takes precedence over named-agent configuration, the configured default, resumed-session metadata, and the Pi child-process default.

`delegationPolicy` accepts:

- `"proactive"` (default): use subagents when they can make useful independent progress.
- `"explicit-request-only"`: only use `subagent` when the user or an active skill explicitly requests delegation.
- Any other string: use it verbatim as the policy line.

`resultCapTokens` is a non-negative number.
`0` disables the configured default cap unless a per-call value overrides it.

`maxDepth` is a positive integer.
The default is `2`, so depth-1 subagents get the `subagent` tool and can spawn depth-2 leaves.
Set `maxDepth` to `1` to opt out of nested delegation and restore the old behavior where subagents cannot spawn grandchildren.

`maxLiveChildren` is a positive integer and defaults to `4`.
It is enforced tree-wide by the root coordinator, not separately in each branch.
Several root-level calls emitted in one assistant turn run concurrently, while each delegation tree remains bounded by its configured live-child budget.

`budgetAcquireTimeoutMs` is a positive integer and defaults to `120000`.
If all live-child slots are busy for longer than this timeout, the attempted spawn returns a clear budget-exhausted result instead of waiting forever.

## Delegating one task per call

The `subagent` tool accepts one delegated task per call.
Emit multiple `subagent` calls in the same assistant turn for independent parallel work.
For dependent work, call again with the previous result or pass a returned session id as `resume`.

Set `async` to `true` to start a subagent without blocking the parent turn.
The async response names the agent and session id, and instructs the parent to call `subagent_wait` with that id.
Call `subagent_wait` with `all: true` to collect every tracked run, omit `id` to collect the first run to finish, or pass `timeoutMs` to bound the wait.
Background runs are tracked and collectable only during the current Pi session.
A timeout reports still-running session ids without cancelling their child processes.
Completed and failed results remain available for repeated collection by session id during the current session.
Session shutdown aborts running children and forgets the background-run registry.

## Default-on nesting change in 0.5.0

The default `maxDepth` is now `2`.
Depth-1 subagents can use the `subagent` tool to spawn depth-2 leaves, and a coordinator socket is active by default to enforce `maxLiveChildren` across the tree.
Set `maxDepth` to `1` in `~/.pi/agent/subagent.json` to restore the previous no-grandchildren behavior.

## Breaking change in 0.3.0

The `quick_task` tool has been removed.
`~/.pi/agent/quick-task.json` is no longer read and is now inert.
If you used `quick_task`, call `subagent` directly with an inline `systemPrompt`, or move that prompt into a named agent under `~/.pi/agent/agents/`.
All `subagent` calls are persistent, resumable sessions.

## Agent definition format (named agents)

`~/.pi/agent/agents/<name>.md`:

```markdown
---
name: example-researcher
description: Read-only research agent
tools: read, grep, find, ls
model: anthropic-vertex/claude-sonnet-5:medium
---

System prompt goes here.
```

## How it works

- Subagents are spawned as `pi --mode json -p --session <file>` child processes; the JSONL
  event stream drives live rendering, the widget, and usage accounting.
- Sessions and metadata live in `~/.pi/agent/subagent-sessions/` (`<id>.jsonl` + `<id>.meta.json`);
  metadata re-applies the persona/model/tools on `resume`.
- The extension loads in child processes too (global discovery). It registers the `subagent`
  tool whenever the current `PI_SUBAGENT_DEPTH` is below `maxDepth`. With the default
  `maxDepth: 2`, depth-1 children can spawn depth-2 leaves; depth-2 leaves cannot spawn deeper.
- The root process owns a coordinator socket when UI approvals are needed or when `maxDepth > 1`
  (the default). Children receive `PI_SUBAGENT_COORDINATOR_SOCKET` for approval proxying,
  live-child budget leases, and compact `+N nested` widget status updates. The permission gate
  extension is the client for the approval part of that protocol (see
  `extensions/subagent/approval-protocol.ts`). This environment variable is internal;
  `PI_SUBAGENT_INHERITED_TOOLS` remains the public inheritance contract.
- Aborting a subagent attempts to terminate the whole spawned process group on macOS and Linux.
  Windows uses a best-effort `taskkill /pid <pid> /t /f` fallback that is implemented but untested.
- Every child is spawned with `PI_SUBAGENT_INHERITED_TOOLS`: a comma-separated list of the
  parent's active tools, or of the explicit `tools` allowlist when one was given. Built-in and
  extension tools load in the child anyway; the variable exists for tools that are only
  registered after an in-session activation, such as MCP bridges, which cannot run their
  interactive picker in a headless child. Extensions that opt into the contract read the
  variable at `session_start` and re-activate the same selection - see
  [pi-atlassian-mcp](https://github.com/nilskluewer/pi-atlassian-mcp).

## Repository

https://github.com/nilskluewer/pi-subagent

## License

MIT
