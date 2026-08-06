# Codex subagent harness vs. pi-subagent

A comparison of OpenAI Codex's multi-agent harness (repo `openai/codex`, analyzed from `codex-rs/` on a fresh clone) with `@nilskluewer/pi-subagent`.
Codex ships two generations: **V1** (`multi_agent` feature, stable, default-on) and **V2** (`multi_agent_v2`, stable but default-off), where V2 is the richer task-path collaboration system.

## The one big architectural difference

**pi-subagent combines one-task delegation with collectable background runs. Codex is asynchronous collaboration.**

A `subagent` call delegates one task and blocks by default; `async: true` starts it in the background and `subagent_wait` collects the result.
Codex `spawn_agent` returns immediately with a handle; the parent model is explicitly instructed to keep doing "meaningful non-overlapping work" while children run, and only calls `wait_agent` when truly blocked.
Results arrive asynchronously as mailbox messages (`FINAL_ANSWER` envelopes) injected into the parent context at message boundaries.

Everything else follows from that: Codex needs mailboxes, `list_agents`, `interrupt_agent`, and status world-state; Pi uses `subagent_wait` for explicit collection instead.

## Feature-by-feature comparison

| Dimension | pi-subagent | Codex |
|---|---|---|
| Execution model | Separate `pi --mode json -p` child **processes**; JSONL event stream | In-process **Tokio sessions** in one process; shared ThreadManager, auth, MCP, skills services; root-scoped `AgentControl` actor registry |
| Tool surface | One `subagent` tool for one task per call + `subagent_wait` for background results | Tool family: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents` (V2, namespace `collaboration`); V1 adds `send_input`, `close_agent`, `resume_agent` |
| Blocking vs async | Blocking by default; `async: true` returns immediately and `subagent_wait` collects the result | Fire-and-forget spawn; async mailbox delivery of final answers; explicit wait only when blocked |
| Parallelism | Independent `subagent` calls can run concurrently, with one task in each call | V2: 4 concurrent threads default **including root** (so 3 children); execution limiter + residency limiter with LRU unloading of idle agents |
| Nesting depth | Hard block: subagents cannot spawn grandchildren | V1: configurable `max_depth` (default 1); V2: **unlimited depth**, bounded only by the shared concurrency limiter |
| Context inheritance | Child always starts fresh (persona + task only) | `fork_turns`: `none` / `all` / last-N turns; forks are **sanitized** (keeps user/dev/system messages + final answers, drops reasoning, tool calls, inter-agent chatter) |
| Agent-to-agent comms | None (parent is the hub; dependent work uses another call or `resume`) | V2: any agent can message any other agent in the tree via canonical task paths (`/root/task1/sub_a`); per-session mailboxes; `send_message` (queue-only) vs `followup_task` (triggers a turn) |
| Personas | Inline `systemPrompt` first-class; named agents as markdown + frontmatter (`~/.pi/agent/agents/*.md`, project `.pi/agents/`) | Named roles as TOML config layers (`[agents.researcher]` + role config file, or auto-discovered `.codex/agents/*.toml`); role can override model, reasoning effort, developer instructions; nickname candidates for UI identity; **no inline persona** - roles are config-only, selected via `agent_type` |
| Resume | Session id returned in every result; `resume` param continues with full context; abort hands back last 10 messages | V1: `resume_agent` tool exposed to the model; V2: transparent **cold loading** - resuming the root restores agent metadata, agents lazily reload from rollout on next message; parent-child edges persisted in an `AgentGraphStore` |
| Result size control | Non-aborted results use a configurable cap; background artifacts preserve the uncapped payload | Completion payloads **capped at 1,000 tokens**; `wait_agent` deliberately returns only a summary, content arrives separately via mailbox |
| Permissions | Shared gate; dangerous bash proxied over Unix socket to parent TUI, labeled per agent, serialized prompts | Children inherit parent's approval policy, permission profile, cwd, exec policy; delegate path (review/guardian) routes approvals to parent session; children **cannot call `request_user_input`** (root-only) |
| Delegation policy | Tool description + skill text ("only when explicitly invoked") | Injected `<multi_agent_mode>` developer fragment: `ExplicitRequestOnly` (default), `Proactive` (auto-activated at `ultra` reasoning effort), or custom text (400-token cap); rendered last so it overrides earlier hints |
| Model-visible state | None (widget is UI-only; parent blocks anyway) | World-state system: `<environment_context>` continuously lists open child agents; status changes arrive as notifications; `list_agents` for on-demand snapshots |
| UI | Live widget rows above editor (status, model, tool, tokens, turns); Ctrl+O streams child output | Thread-navigation model: `/agents` picker, Alt+Left/Right to switch into a child thread; compact history cells on parent transcript; bounded "Sub-agents running" activity feed; no side-by-side dashboard |
| Cheap chores | No separate cheap-task tool; use one `subagent` call with an inline persona | No equivalent |
| Specialized delegates | Handled via personas/skills | `/review` and Guardian approval-review run through a separate `codex_delegate` path: own prompt, `AskForApproval::Never`, web search and sub-spawning disabled |

## Where we are genuinely ahead

1. **Inline personas.**
   Codex requires TOML role files; a skill or the model itself cannot invent a persona on the fly.
   Our inline-first `systemPrompt` design is more flexible for skill-driven workflows like expert-council-review.
2. **Live result collection.**
   `subagent_wait` gives the parent an explicit way to collect background work by session id.
3. **Collectable background runs.**
   `async: true` keeps the parent responsive while `subagent_wait` collects a result from the current session.
4. **Process isolation.**
   A crashing/hanging child cannot take down the parent; Codex agents share one process and runtime.
5. **Simplicity.**
   One task per call plus an explicit wait tool is easier for a model to use correctly than six tools plus a path-addressing scheme.
   Codex pays for its power with substantial prompt real estate teaching the model the protocol.

## Learnings worth stealing

### 1. Context forking (`fork_turns`) - highest value

Our children always start cold; the parent must serialize all relevant context into the task string.
Codex lets the spawner pass `none | all | N` turns of **sanitized** parent history (final answers kept, reasoning/tool noise dropped).
A `forkContext: "none" | "all" | <n>` option on our tool would remove the most annoying part of writing subagent tasks, and the sanitization recipe (keep system/dev/user + final assistant messages, drop tool calls and thinking) is directly reusable since we already have the parent's JSONL session file.

### 2. Cap and envelope child results

Codex caps completion payloads at 1,000 tokens and wraps them in a structured envelope (`Message Type / Task name / Sender / Payload`).
Several concurrent subagent calls can return many reports to the parent context.
A configurable result token cap (with "full output available via resume/session file") would protect parent context.

### 3. Delegation-policy injection instead of tool-description-only guidance

Codex separates "how the tools work" (tool description) from "when you are allowed to use them" (injected `<multi_agent_mode>` policy, default: explicit request only, proactive at ultra effort).
The default policy text is excellent and worth adapting:
"Requests for depth, thoroughness, research, or detailed codebase analysis do **not** count as permission to spawn."

### 4. Operational guidance in the spawn tool description

Codex's V1 `spawn_agent` description encodes hard-won orchestration rules we could copy nearly verbatim into ours:

- Subtasks must be concrete, well-defined, and self-contained.
- Do not delegate urgent blocking work when your next step depends on the result.
- Do not duplicate work between the main rollout and delegated subtasks.
- Coding subagents must use **disjoint write sets** (no two agents editing the same files).

### 5. Depth via shared limiter instead of a hard grandchild ban

Codex V2 allows recursive spawning but bounds total concurrency with one root-scoped limiter.
Our hard "no grandchildren" rule is safe but limits legitimate patterns (a planner that spawns executors).
A root-scoped budget passed down via env (total live children across the tree) would be a safer generalization than a depth flag.

### 6. Persisted agent graph

Codex persists parent→child spawn edges (`AgentGraphStore`), so resuming a root can restore the whole tree's metadata and lazily reload children.
We store flat `<id>.meta.json` files; adding a `parent` field would enable tree-aware resume and cleanup for nearly free.

### 7. Interrupt as a first-class, non-destructive operation

Codex's `interrupt_agent` stops the current turn but keeps the agent alive for follow-ups.
Our abort story (session id + last 10 messages) is decent, but "interrupted agents remain addressable" is a cleaner contract than "aborted, please resume."

## Things to deliberately not copy

- **In-process actor system.** Right for a Rust binary owning the runtime; wrong for an extension - our process model is the correct boundary for pi.
- **Mailboxes / agent-to-agent messaging.** Enormous complexity that only pays off with async spawning and long-lived peer agents.
  Codex itself gates all of it behind a default-off feature flag and defaults the policy to "don't spawn unless explicitly asked" - a signal that even OpenAI finds the proactive multi-agent UX unproven.
- **Two protocol generations.** V1/V2 coexistence is legacy baggage, not design.

## Maturity note

Despite the engineering depth, Codex's own posture is conservative: V2 defaults off, delegation defaults to explicit-request-only, `/review` runs with subagents disabled, and the repo `docs/` tree contains **no user-facing documentation** for any of it.
The strongest validated pattern in their codebase is the one we already implement: an isolated one-shot delegate with a dedicated prompt, restricted tools, and parent-owned approvals (their `codex_delegate` / review path).
