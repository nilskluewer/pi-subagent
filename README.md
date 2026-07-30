# @nilskluewer/pi-subagent

<p align="center">
  <img src="https://raw.githubusercontent.com/nilskluewer/pi-subagent/main/docs/assets/agent-tree.png" alt="A delegation run: main agent, coordinator socket, three subagents, capped result envelopes, and persisted session files" width="560" />
</p>

One subagent extension for Pi that covers exactly what a multi-agent workflow needs:

- **`subagent` tool** - delegate tasks to isolated `pi` child processes with single,
  parallel (up to 8 tasks, concurrency 4), and chain (`{previous}` placeholder) modes.
- **Inline-first personas** - pass `systemPrompt` (+ optional `name`, `model`, `tools`, `thinking`)
  directly in the tool call. Skills define personas in their own text; no agent files needed.
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
  model resolves. Completed single, chain, and parallel views also show each model.
  Press Ctrl+O on the running tool call to inspect streaming output.
- **Nested delegation with a root budget** - by default, depth-1 subagents can spawn one
  more level of subagents (`maxDepth: 2`). A root-scoped coordinator enforces a default
  tree-wide limit of 4 live child processes. Set `maxDepth: 1` to restore the old hard
  grandchild ban.
- **Shared permission gate** - the same gate protects the main agent and all subagents.
  Dangerous bash (`rm -rf`, `git reset --hard`, `sudo`, …) prompts everywhere. Subagent
  requests are proxied over a Unix socket and appear in the parent TUI labeled with the
  agent's name; concurrent prompts are serialized. Normal `write`/`edit` calls follow the
  subagent's configured tool allowlist without an extra prompt. No UI / no channel blocks
  dangerous bash calls.

Replaces both `@nilskluewer/pi-minimal-subagent` (the `delegate` tool) and the standalone
permission-gate extension.

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

Single, inline persona:

```jsonc
{ "systemPrompt": "You are a security reviewer...", "name": "security", "model": "anthropic-vertex/claude-sonnet-5", "tools": "read,grep,find,ls", "thinking": "high", "task": "Review src/auth.ts" }
```

`thinking` is one of `off | minimal | low | medium | high | xhigh`. Omit it to inherit the global
default (`defaultThinkingLevel` in `~/.pi/agent/settings.json`, same as the main agent). Settable
inline, in named-agent frontmatter, or overridden per `resume` call; a resumed session without an
override keeps whatever it was created with.

Parallel council (e.g. from an expert-council-review skill):

```jsonc
{ "tasks": [
  { "systemPrompt": "You are a correctness reviewer...", "name": "correctness", "task": "Review src/auth.ts" },
  { "systemPrompt": "You are a security reviewer...", "name": "security", "task": "Review src/auth.ts" },
  { "systemPrompt": "You are an architecture reviewer...", "name": "architecture", "task": "Review src/auth.ts" }
] }
```

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

Chain (sequential, `{previous}` is the prior step's output):

```jsonc
{ "chain": [
  { "agent": "example-researcher", "task": "Summarize the auth flow" },
  { "systemPrompt": "You write concise ADRs.", "name": "adr-writer", "task": "Write an ADR based on: {previous}" }
] }
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
Precedence is per-item `resultCapTokens`, then top-level call `resultCapTokens`, then `~/.pi/agent/subagent.json`, then the built-in default of `1000`.
This lets one parallel task stay uncapped while others remain small.

Envelope example:

```text
[agent: reviewer | model: github-copilot/gpt-5.6-luna | status: completed | session: 0197c0de]

Result text...

[truncated: showing ~1000 of ~4200 approx. tokens. Full output: read /Users/me/.pi/agent/subagent-sessions/0197c0de.jsonl directly (the JSONL tail has the rest), or resume session "0197c0de" to continue this agent with full context.]
```

Mixed parallel caps:

```jsonc
{ "resultCapTokens": 500, "tasks": [
  { "name": "lint", "systemPrompt": "Check lint output.", "task": "Summarize lint issues." },
  { "name": "deep-review", "systemPrompt": "Do a deep review.", "resultCapTokens": 0, "task": "Return the full review." }
] }
```

## Subagent configuration

`~/.pi/agent/subagent.json` configures delegation guidance, result capping, nested depth, and the root-scoped live-child budget for the `subagent` tool.
The file is optional.
Missing or invalid JSON falls back to the defaults.
Policy, cap, depth, and budget changes take effect at the next session start, such as `/new`, `/resume`, `/fork`, `/reload`, or restarting Pi.

```jsonc
{
  "delegationPolicy": "explicit-request-only",
  "resultCapTokens": 1000,
  "maxDepth": 2,
  "maxLiveChildren": 4,
  "budgetAcquireTimeoutMs": 120000
}
```

`delegationPolicy` accepts:

- `"explicit-request-only"` (default): only use `subagent` when the user or an active skill explicitly asks for delegation, a parallel review/council, or a named agent.
- `"proactive"`: allow opportunistic delegation for self-contained, well-specified work that can run without blocking the next step.
- Any other string: used verbatim as the policy line.

`resultCapTokens` is a non-negative number.
`0` disables the configured default cap unless a per-call or per-item value overrides it.

`maxDepth` is a positive integer.
The default is `2`, so depth-1 subagents get the `subagent` tool and can spawn depth-2 leaves.
Set `maxDepth` to `1` to opt out of nested delegation and restore the old behavior where subagents cannot spawn grandchildren.

`maxLiveChildren` is a positive integer and defaults to `4`.
It is enforced tree-wide by the root coordinator, not separately in each branch.
A normal root-level parallel batch with up to 4 running tasks behaves as before, while parallelism plus nesting is bounded across the whole tree.

`budgetAcquireTimeoutMs` is a positive integer and defaults to `120000`.
If all live-child slots are busy for longer than this timeout, the attempted spawn returns a clear budget-exhausted result instead of waiting forever.

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
model: anthropic-vertex/claude-sonnet-5
thinking: medium
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
  live-child budget leases, and compact `+N nested` widget status updates. This environment
  variable is internal; `PI_SUBAGENT_INHERITED_TOOLS` remains the public inheritance contract.
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
