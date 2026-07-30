# Implementation Plan: Codex Learnings for pi-subagent

This plan turns the six ideas in `docs/codex-subagent-comparison.md` into concrete, file-level engineering work for `@nilskluewer/pi-subagent`.
It is written against the extension code as of `subagent-tool.ts` (~1400 lines), `gate.ts`, `approval-server.ts`, `agents.ts`, `quick-task.ts` (removed by this plan, see Phase 1), `inherited-tools.ts`, `abort-output.ts`, and the current test suite under `tests/*.test.mjs`.
Every claim about the pi extension API is checked against `docs/extensions.md`, `docs/session-format.md`, `docs/sessions.md`, `docs/json.md`, `docs/environment-variables.md`, `docs/settings.md`, and the installed package's `.d.ts`/`.js` sources under `@earendil-works/pi-coding-agent/dist`.
Where the API does not support something we need, that is called out explicitly, with a fallback.

This is the final version of the plan.
All open questions raised during planning have been decided by Nils; every decision is folded directly into the relevant section below, and section 8 is a short decisions log rather than a list of unresolved items.

## 0. Scope and how to read this plan

The plan is organized into three phases, matching the value/effort/risk ranking from the task.
Phase 1 covers features 3 and 4 (tool description and delegation policy), plus the removal of the `quick_task` tool: pure text, config, and one tool-surface simplification, lowest risk.
Phase 2 covers features 1 and 2 (context forking and result cap/envelope): the highest-value features, touching the core spawn path but not the process/security model.
Phase 3 covers features 5 and 6 (root-scoped depth budget and persisted agent graph): the riskiest phase, because it changes the trust boundary (subagents can now spawn subagents, by default) and adds a new cross-process coordination protocol that is now active on every call, not just for users who opt in.

Each phase section has: design decisions with alternatives considered, exact schema/API changes, a file-by-file change list, new/changed tests, and edge cases/risks specific to that phase.
Section 1 documents the pi API surface this plan relies on, verified against the installed package, so later sections can reference it without re-justifying each call.
Section 7 lists cross-cutting testing/rollout concerns that span phases.
Section 8 is a decisions log: a short, numbered record of every decision Nils made on the open questions raised while drafting this plan, each pointing back to the section where it is fully worked through above.

## 1. API grounding: what is verified, what is not

All of the following were confirmed by reading `docs/extensions.md`, `docs/session-format.md`, and the installed package's compiled `.d.ts`/`.js` files (not inferred or invented):

- `pi.registerTool(definition)` can be called more than once for the same tool name, including after startup, and the docs state the tool is "refreshed immediately in the same session."
  This means we can recompute `description`/`promptGuidelines` from a config file and re-register on every `session_start` (including `reason: "startup"`, `"new"`, `"resume"`, `"fork"`, `"reload"`), without needing a dynamic/callback-based description field, which the API does not offer (`description` and `promptGuidelines` are plain static values at registration time).
- `promptGuidelines: string[]` is the documented mechanism for "when/how to use this tool" bullets appended to the system prompt's Guidelines section, as opposed to `description`, which documents mechanics and is "paid on every turn" per the extensions doc's own guidance to keep it tight.
  This is the "better injection point" the task asks us to consider for features 3 and 4: use `promptGuidelines` for the operational rules and the delegation-policy line, keep `description` focused on modes/params.
- `ExtensionContext` (the `ctx` passed into every hook and into `registerTool`'s `execute(toolCallId, params, signal, onUpdate, ctx)`) exposes `ctx.sessionManager`, `ctx.cwd`, `ctx.hasUI`, `ctx.ui`, `ctx.signal`, among others.
  This is confirmed by the extensions doc's own file-mutation example, which uses `ctx.cwd` inside `execute()`, and by the `ExtensionContext` section, which documents `ctx.sessionManager` generically for "all handlers."
- `ctx.sessionManager` is typed as `ReadonlySessionManager`, a `Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "buildContextEntries" | "getHeader" | "getEntries" | "getTree" | "getSessionName">` (verified in `dist/core/session-manager.d.ts`).
  Importantly, **`buildSessionContext()` is not in that list** even though the prose in `docs/extensions.md` mentions it as an instance method; the `ctx.sessionManager` object handed to extensions does not expose it.
  We must use `ctx.sessionManager.buildContextEntries()` (which is exposed) plus the standalone exported function `sessionEntryToContextMessages(entry)` (exported from the package root, confirmed in `dist/index.d.ts`) to reconstruct the flattened `AgentMessage[]` ourselves.
  This is the answer to the task's question "how do we locate the parent session file / context from within the extension": we do not need the file path at all for reading, because `ctx.sessionManager` already gives us the live, compaction-aware context of the exact running parent agent.
  We do use `ctx.sessionManager.getSessionFile()` (present in the Pick list) for provenance and for detecting an ephemeral (`--no-session`) parent, where it returns `undefined`.
- `SessionManager` (the class, not just the read-only view) is exported from the package root and documented as public API (`docs/extensions.md` shows `const parentSession = ctx.sessionManager.getSessionFile();` and `SessionManager.list(...)` used directly).
  `SessionManager.open(path, sessionDir?, cwdOverride?)` on a **non-existent** path creates a fresh in-memory session, preserves the exact path we asked for, and lazily persists to disk (verified by reading `dist/core/session-manager.js`).
  `SessionManager.appendMessage(message)` accepts `Message | CustomMessage | BashExecutionMessage` (i.e. `UserMessage | AssistantMessage | ToolResultMessage | BashExecutionMessage | CustomMessage`), and explicitly **rejects** writing `CompactionSummaryMessage`/`BranchSummaryMessage` directly (those need `appendCompaction`/`branchWithSummary`).
  This matters for the sanitizer: compaction/branch summaries must be converted into synthetic `UserMessage`s before being appended to a forked child session, not passed through as-is.
- A subtlety in `SessionManager`'s internals: `_persist()` defers the actual file write until the buffered entries contain at least one `assistant`-role message (avoids leaving junk empty session files from aborted first turns).
  If a forked/sanitized message set has **zero** assistant messages, the file will never be flushed to disk through the public API, and the child process would see no injected history at all.
  This is treated as an explicit edge case (see 5.1.10), not worked around by hand-rolling the JSONL format, to keep the implementation on the documented, versioned public API.
- `pi --session <path>` on a path that does not yet exist creates a fresh session there; on a path that already contains a valid session, it resumes it exactly like `resume` does today.
  This is inferred from `docs/sessions.md`'s `--session <path|id>` description plus the existing, working `resume` code path in `subagent-tool.ts`, which already relies on this behavior (a previously-created, non-empty session file is reused by a later `pi --session <file>` invocation).
  There is no documented "this session was pre-seeded, treat specially" flag; a well-formed, pre-populated session file is indistinguishable from an organically-grown one, which is exactly what we want.
- `docs/json.md` documents `turn_start`/`turn_end` as live agent-loop events in `--mode json` output, but **these are not persisted into the session JSONL** (`docs/session-format.md`'s message-entry union has no turn marker type).
  There is therefore no API to ask "where did turn N begin" from a session file after the fact.
  The plan defines "a turn" for the `forkContext: <N>` case as "one user message and everything up to (but not including) the next user message," computed by scanning the flattened message list for `role === "user"` boundaries.
  This is a pragmatic, testable definition that does not require replaying the conversation through a live agent; it is called out explicitly as an approximation of Codex's turn semantics, which pi does not expose.
- `docs/extensions.md`'s custom-tools section states plainly: "Use `StringEnum` from `@earendil-works/pi-ai` for string enums... `Type.Union`/`Type.Literal` doesn't work with Google's API."
  `forkContext` needs to accept either an enum string (`"none" | "all"`) or a positive integer; a `Type.Union` mixing those is exactly the pattern the docs warn against for Google-backed models.
  The plan avoids this by making `forkContext` a plain string parameter (`"none"`, `"all"`, or a numeric string like `"5"`), parsed and validated in the extension, mirroring the existing `tools` parameter, which is already a comma-separated string parsed manually for the same cross-provider-compatibility reason.
- `pi.on("tool_call", ...)` (used by `gate.ts` today) can return `{ block: true, reason }` to veto a call before it executes, and `event.input` is mutable.
  This is confirmed by the existing, working `gate.ts` code and by the extensions doc's `tool_call` section.
- Nothing in the documented API exposes "how many sibling/cousin subagent processes are currently alive across the whole tree" - that state does not exist anywhere in pi itself, because each subagent is an independent OS process running an independent `pi` instance.
  The plan's root-scoped budget (feature 5) therefore has to be implemented as new, extension-owned IPC (a Unix domain socket), not as a pi API call; this is explicitly not an invented pi API, it is new coordination code owned entirely by this extension, following the same pattern `approval-server.ts` already uses for the permission gate.

## 2. Config surface: `~/.pi/agent/subagent.json`

A new config file, `~/.pi/agent/subagent.json`, is introduced to hold the "policy" knobs from features 2, 4, and 5.
It follows the exact convention already established by `~/.pi/agent/quick-task.json`: optional, missing-is-fine, read fresh (JSON parse, tolerant of a missing/invalid file, falling back to defaults).
`quick-task.ts` and its own config file are removed entirely in Phase 1 (4.2), an unrelated cleanup; the convention itself, established by that file, remains the right model for `subagent.json` to follow, and once `quick-task.ts` is deleted, `~/.pi/agent/quick-task.json` simply becomes inert (nothing reads it; no migration code is needed).
`subagent.json` is introduced incrementally, one phase at a time, rather than fully speced up front, to avoid designing fields for features not yet built.

Final shape after all three phases (shown here once for reference; each phase section below states exactly which fields it adds):

```jsonc
// ~/.pi/agent/subagent.json
{
  "delegationPolicy": "explicit-request-only",   // "explicit-request-only" | "proactive" | any custom string (phase 1)
  "resultCapTokens": 1000,                        // 0 disables the cap; also overridable per call and per task item (phase 2)
  "maxDepth": 2,                                  // shipped default; allows one level of grandchildren. Set to 1 to restore the old hard ban (phase 3)
  "maxLiveChildren": 4,                           // tree-wide budget, enforced by default since maxDepth defaults above 1 (phase 3)
  "budgetAcquireTimeoutMs": 120000                // bounded wait before "budget exhausted" (phase 3)
}
```

A single shared loader module, `extensions/subagent/config.ts`, is added in phase 1 and extended (not replaced) in phases 2 and 3.

## 3. Release plan overview

| Phase | Features | Theme | Risk | Primary files touched |
|---|---|---|---|---|
| 1 | 3 (operational guidance), 4 (delegation policy), removal of `quick_task` | Text and config, plus a tool-surface simplification (breaking) | Low, but ships one breaking change | `index.ts`, `subagent-tool.ts` (registration only), `quick-task.ts` (deleted), `README.md`, new `config.ts` |
| 2 | 1 (context forking), 2 (result cap + envelope) | Core spawn-path improvements | Medium | `subagent-tool.ts`, new `context-fork.ts`, new `result-cap.ts` |
| 3 | 5 (root-scoped depth budget), 6 (persisted agent graph) | Trust boundary and coordination changes, active by default | High | `index.ts`, `gate.ts`, `approval-server.ts`, `subagent-tool.ts`, new `agent-budget.ts` |

Phase 1 ships first because it is almost entirely text/config with no behavioral risk, and bundles in the one piece of pure tool-surface cleanup (removing `quick_task`) that is cheapest to do before the remaining phases add more surface area to `subagent-tool.ts`.
The `quick_task` removal is a breaking change and must be called out prominently in that release's notes, distinct from the purely additive `promptGuidelines`/delegation-policy work shipping in the same phase.
Phase 2 ships second because it is "the meat": the two features most directly requested by users of the tool (better task-writing ergonomics via forking, and protecting parent context from oversized results).
Phase 3 ships last and is explicitly the riskiest, more so than originally scoped: it changes a security-relevant invariant (subagents currently cannot spawn subagents at all) and adds new IPC, and, per the decision recorded in 6.1.1, that new IPC and the ability to spawn grandchildren are both **on by default** in the shipped release, not gated behind an opt-in config value.
Within phase 3, feature 6 (persisted `parent`/`rootId` fields) is nearly free once feature 5's env-var plumbing exists, so they are implemented together but feature 6's code lands first inside phase 3 since it has no behavioral risk of its own.

## 4. Phase 1: tool description, delegation policy, and removing `quick_task` (features 3 and 4)

### 4.1 Design decisions

**Decision: split "what the tool does" from "when to use it."**
`description` stays focused on mechanics: modes, parameter shapes, resume, where named agents live.
The Codex-derived operational rules (feature 3) and the delegation policy line (feature 4) move into `promptGuidelines`, which `docs/extensions.md` documents as exactly this: tool-specific bullets appended to the system prompt's Guidelines section, included only while the tool is active.
Alternative considered: keep everything in `description` (simplest, matches today's code, one string to reason about).
Rejected because the docs explicitly frame `description` as paid-every-turn and recommend keeping it tight, and because `promptGuidelines` is the idiomatic, purpose-built mechanism pi already offers for "when/how" guidance; using it also means these bullets are visually/structurally distinct from tool mechanics in the rendered system prompt, which should help the model treat them as behavioral rules rather than API docs.

**Decision: three-tier delegation policy config, default `"explicit-request-only"`.**
`delegationPolicy` in `subagent.json` is one of:
- `"explicit-request-only"` (default): renders Codex's adapted default text, emphasizing that requests for depth/thoroughness/research do not by themselves justify spawning a subagent.
- `"proactive"`: a shorter, permissive line telling the model it may delegate opportunistically for genuinely parallelizable or isolable work, matching Codex's `Proactive` mode.
- any other string: used verbatim as the policy line (full override), with no length cap enforced by us (Codex caps custom policy text at 400 tokens; that is a Codex-internal budget concern for their injected fragment, not something pi-subagent needs to replicate, since our bullet is one line inside `promptGuidelines`, not a whole injected block; if the maintainer wants a cap, it is trivial to add a soft length warning in `config.ts`, but the plan does not add one by default).
Alternative considered: two-valued enum only (`"explicit-request-only" | "proactive"`), no custom text.
Rejected because supporting arbitrary override text is nearly free (it is just "else branch: use the string as-is") and gives Nils and future skill authors control without needing a code change, matching this project's existing philosophy of configuration files being "edit anytime."

**Decision: exact wording, adapted (not copied verbatim) from Codex.**
Default `"explicit-request-only"` text:
> "Only use `subagent` when the user (or an active skill) explicitly asks for delegation, a parallel review/council, or a named agent by name.
> Requests for depth, thoroughness, more research, or a more detailed analysis do not, by themselves, count as permission to spawn a subagent; do the work yourself unless delegation is explicitly requested."

Default `"proactive"` text:
> "You may delegate proactively when a subtask is self-contained, well-specified, and can run without your involvement (for example: an isolated code review, a parallel search across independent areas, or a long-running chore); do not delegate when the result blocks your very next step."

Operational guidance bullets (feature 3), added as additional `promptGuidelines` entries, phrased per the docs' own rule that each guideline must name the tool (avoid "use this tool"):
- "Give `subagent` tasks that are concrete, self-contained, and answerable without further back-and-forth; vague tasks produce vague results you cannot use."
- "Do not delegate to `subagent` when your very next step depends on the result and nothing else can proceed in the meantime; call it only when you can either wait productively or the result is not immediately blocking."
- "Do not use `subagent` to redo work you can already see the result of in your own context; avoid handing an agent a task whose output you will just re-derive yourself."
- "When delegating file-editing work to more than one `subagent` task in parallel, give each task a disjoint set of files or directories to write; two parallel agents editing the same file will race and silently lose changes."

**Decision: `promptGuidelines` is assembled at registration time, refreshed on every `session_start`.**
Because `promptGuidelines` (like `description`) is a static value passed to `registerTool()`, config freshness is bounded to "next session start" (covers `/new`, `/resume`, `/fork`, `pi restart`, and `/reload`), not "next tool call."
This exactly matches how `agents.ts` named-agent definitions are already only picked up per-invocation of `discoverAgents()` inside `execute()`, but is one level coarser for the *policy text itself* because of the API's static-registration constraint documented in section 1.
Alternative considered: read `subagent.json` inside `execute()` and prepend the policy line to the model-visible tool **result** text on every call instead of the registration-time description.
Rejected: that would repeat the policy text in every single tool result (wasteful, and it is guidance for *whether to call the tool*, which is useless to repeat after the call already happened); the registration-time approach is the correct semantic fit even though it is less "live."

### 4.2 Removing the `quick_task` tool

**Decision: `quick_task` is deleted entirely in this phase, not deprecated gradually.**
Nils already runs with `quick_task` disabled in practice, and its continued existence works against the exact goal `promptGuidelines` (4.1) is trying to serve: a model now has to choose between two overlapping "spawn a small helper" primitives (`subagent` with an inline persona vs. `quick_task`) instead of having exactly one, well-guided delegation tool.
Removing it in the same phase as the `promptGuidelines`/delegation-policy work is the natural point to bring the tool surface back down to one primitive, which also matches this project's stated "single-tool simplicity" constraint more closely than the current two-tool surface does.
Alternative considered: deprecate `quick_task` first (keep it working, mark it discouraged in its description) and remove it in a later release.
Rejected: there is no compatibility surface worth preserving here (it is already disabled by the maintainer), and a deprecation period only prolongs the exact tool-choice ambiguity this change exists to remove.

**This is a breaking change.**
Any user relying on `quick_task`, or on `~/.pi/agent/quick-task.json`, loses that tool immediately on upgrading to this phase's release.
It must be called out explicitly and prominently in that release's changelog/notes, separate from the purely additive `promptGuidelines`/policy work landing in the same phase, so it cannot be mistaken for a minor internal change.

**Migration path for anyone who was using it**: call `subagent` directly with an inline `systemPrompt` (the removed default quick_task system prompt can be copied verbatim into a call, or into a named agent file under `~/.pi/agent/agents/` for reuse across calls), plus `tools`/`model`/`thinking` overrides matching the old `quick-task.json` fields.
There is no ephemeral/no-session mode preserved by this removal; every `subagent` call is now always a resumable session.
This is a deliberate simplification, not an oversight: if a genuinely ephemeral, non-resumable mode turns out to be wanted again later, it should be reconsidered as a `subagent` parameter (for example, an explicit opt-out of session persistence) rather than as a second tool, to avoid reintroducing the exact ambiguity this removal fixes.
`~/.pi/agent/quick-task.json` itself is not deleted or migrated by any code; once `quick-task.ts` is removed, nothing reads that file anymore and it becomes inert, and users may delete it manually at their leisure.

**Consequence for the codebase**: `AgentSpec.ephemeral` and the corresponding `--no-session`/skip-metadata branches in `runSingleAgent()` were only ever set to `true` by `quick-task.ts`; once that file is deleted, they become dead code.
They are removed in the same change (not left behind as unreachable code), which also means `SingleResult.sessionId`/`sessionFile` are effectively always present going forward for every `subagent` result (still typed optional defensively, for the rare case a run fails before `writeSessionMeta()` completes).

### 4.3 Schema / config changes

New file read by the extension: `~/.pi/agent/subagent.json`.
Phase 1 fields:

```jsonc
{
  "delegationPolicy": "explicit-request-only"
}
```

No changes to the `subagent` tool's parameter schema in this phase; only its `description`/`promptGuidelines` strings change.
`quick_task`'s schema is removed entirely together with the tool (4.2).

### 4.4 File-by-file changes

- **New: `extensions/subagent/config.ts`**
  - `interface SubagentConfig { delegationPolicy?: string }` (grows in later phases).
  - `function loadSubagentConfig(): SubagentConfig` - reads `path.join(getAgentDir(), "subagent.json")`, JSON-parses, tolerant of missing/invalid file (returns `{}`), same pattern as `quick-task.ts`'s (removed) `loadConfig()`.
  - `function buildDelegationPolicyLine(policy: string | undefined): string` - returns the appropriate default/proactive/custom text.
  - `const OPERATIONAL_GUIDELINES: string[]` - the four bullets above, exported as a constant so tests can assert on their content without string-matching the whole tool registration.
- **Modified: `extensions/subagent/subagent-tool.ts`**
  - `registerSubagentTool(pi: ExtensionAPI)` gains a `promptGuidelines: [...OPERATIONAL_GUIDELINES, buildDelegationPolicyLine(loadSubagentConfig().delegationPolicy)]` field on the tool definition.
  - `description` is trimmed to remove anything that overlaps with the new guidelines (nothing currently overlaps; the existing description text is kept nearly as-is, mechanics-only).
  - `AgentSpec.ephemeral` and the `--no-session`/skip-metadata branches in `runSingleAgent()` are removed as dead code (4.2), since `quick-task.ts` was their only caller.
  - No other change to `execute()`, `renderCall()`, or `renderResult()` in this phase.
- **Deleted: `extensions/subagent/quick-task.ts`** (4.2) - the entire file is removed.
- **Modified: `extensions/subagent/index.ts`**
  - Move the `registerSubagentTool(pi)` call from the default export's top level into a `pi.on("session_start", (_event, _ctx) => { ... })` handler, so config is re-read (and the tool re-registered with fresh guidelines) on every session start, including `/new` and `/resume`, per the verified behavior in section 1 that `session_start` fires even for `reason: "startup"`.
  - Remove the `registerQuickTaskTool(pi)` call and its import entirely (4.2), not just move it.
  - The gate (`registerGate(pi)`) and `setActiveToolsProvider(...)` calls stay at the top level (unchanged; they are not config-driven).
  - The existing `if (!process.env.PI_SUBAGENT)` guard is kept exactly as-is in this phase; it is only generalized in phase 3.
- **Modified: `README.md`**
  - Document `~/.pi/agent/subagent.json` and `delegationPolicy` next to where `quick-task.json` used to be documented.
  - Remove the `quick_task` tool feature bullet, the entire "## quick_task configuration" section, and the "Usage from the main agent" `quick_task` examples.
- **`package.json`**: checked; its `description` and `keywords` fields do not reference `quick_task` or `quick-task`, so no change is needed there.
- **Tests**: confirmed none of the four existing test files (`gate.test.mjs`, `inherited-tools.test.mjs`, `abort-output.test.mjs`, `terminal-display.test.mjs`) import `quick-task.ts`, so no test file needs deleting as part of this removal.

### 4.5 Tests

- **New: `tests/config.test.mjs`**
  - `loadSubagentConfig()` returns `{}` when the file is missing (use a temp `PI_CODING_AGENT_DIR` override, see 7 for the shared test harness pattern needed).
  - `loadSubagentConfig()` returns parsed fields when the file exists and is valid JSON.
  - `loadSubagentConfig()` returns `{}` (not a throw) when the file exists but is invalid JSON.
  - `buildDelegationPolicyLine(undefined)` and `buildDelegationPolicyLine("explicit-request-only")` both return the default text.
  - `buildDelegationPolicyLine("proactive")` returns the proactive text.
  - `buildDelegationPolicyLine("Always delegate code review.")` returns that exact string verbatim (custom override passthrough).
  - `OPERATIONAL_GUIDELINES` has exactly 4 entries and each one contains the substring `subagent` (guards against the "must name the tool" rule from the docs regressing silently).
- No new test is needed for the `quick_task` removal itself beyond the confirmation above that nothing still imports it; running the full suite after deletion is the actual verification step.

### 4.6 Edge cases and risks

- A malformed `subagent.json` must never crash extension load; `loadSubagentConfig()` fails closed to `{}` exactly like `quick-task.ts`'s `loadConfig()` did.
- Because `promptGuidelines`/`description` are only refreshed at `session_start`, a user editing `subagent.json` mid-session will not see the new policy text until `/new`, `/resume`, or restart; this should be called out in the README next to the config docs so it is not mistaken for a bug.
- Risk: over-long `promptGuidelines` (very verbose custom `delegationPolicy` text) increases per-turn token cost; not enforced by the plan (see 4.1), left as a documented user responsibility, consistent with how pi itself does not cap custom `--append-system-prompt` text either.
- **Breaking-change risk**: the `quick_task` removal must not be buried in a release whose headline is "improved tool guidance"; it needs its own clearly-labeled line in the release notes, since it silently breaks any external skill/workflow that still calls `quick_task` by name.

## 5. Phase 2: context forking and result cap (features 1 and 2)

### 5.1 Feature 1: context forking

#### 5.1.1 Design decisions and alternatives considered

**Decision: `forkContext` is a per-item string parameter, not a typed union.**
Added to `agentSelectionFields` (so it is available identically on the top-level single-mode params object and on each `TaskItem`/`ChainItem`, exactly like `resume`/`model`/`tools`/`thinking` already are), typed as `Type.Optional(Type.String({ description: '"none" (default), "all", or a positive integer as a string, e.g. "5", meaning the last N turns' }))`.
Values are parsed by a new pure function `parseForkContext(raw: string | undefined): { mode: "none" } | { mode: "all" } | { mode: "turns"; n: number } | { error: string }`.
Alternative considered: `StringEnum(["none", "all"]) | Type.Integer` via `Type.Union`.
Rejected per the verified constraint in section 1 (`Type.Union`/`Type.Literal` do not work with Google's tool-calling schema translation); a plain string parsed manually sidesteps this entirely and matches the existing `tools` field's convention in this same file.

**Decision: sanitize using `ctx.sessionManager.buildContextEntries()` + `sessionEntryToContextMessages()`, not by reading the parent's `.jsonl` file from disk.**
This is the direct, verified answer to the task's open question about locating/reading the parent session.
`ctx.sessionManager` (available in the tool's own `execute()`, per section 1) already reflects the parent agent's live, compaction-aware active branch; re-parsing the raw file would (a) require duplicating compaction/branch-summary resolution logic that `SessionManager` already implements and (b) risk reading a stale on-disk copy that lags one flush behind the in-memory state.
Alternative considered: shell out to read `ctx.sessionManager.getSessionFile()` from disk directly with our own JSONL parser.
Rejected as strictly worse: more code, does not benefit from compaction handling, and the docs explicitly hand us the resolved, in-memory API instead.
`getSessionFile()` is still used, but only for two narrow purposes: detecting an ephemeral parent (`undefined` return means `--no-session`, in which case forking is impossible and the call degrades gracefully with a warning), and future provenance (see 5.1.10).

**Decision: sanitization recipe, matching Codex's `fork_turns` semantics.**
Input: `messages: AgentMessage[]`, obtained via `ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)`.
Output: a filtered `AgentMessage[]` containing only entries that satisfy:
- `role === "user"`: kept verbatim (content and timestamp unchanged).
- `role === "assistant"`: `content` is filtered down to `type === "text"` parts only (dropping `thinking` and `toolCall` parts); the message is kept only if at least one `text` part remains after filtering, otherwise it is dropped entirely (an assistant turn that was pure tool-calling, with no final text, contributes nothing to "final answers").
- `role === "toolResult"` or `role === "bashExecution"`: always dropped (tool noise).
- `role === "custom"`: always dropped, unconditionally, with no `display: true` special case. This mirrors Codex's own simple recipe (drop inter-agent/extension chatter) and is a deliberate simplification, not an oversight; a concrete integration such as pi-atlassian-mcp that ever wants meaningful `custom_message` content preserved across a fork can be revisited later against a real use case, but is not designed for speculatively here.
- `role === "compactionSummary"` or `role === "branchSummary"` (the flattened forms `sessionEntryToContextMessages` produces for `compaction`/`branch_summary` entries): converted into a synthetic `UserMessage` with `content: "[Earlier context summary]\n" + summary` and the original `timestamp`.
  This is required because `SessionManager.appendMessage()` explicitly rejects writing these two message roles directly (verified in section 1); converting to a plain user message is both the only way to persist the information and a reasonable way to represent it (a condensed prior-context note the child can read like anything else a user said).
pi has no persisted "system"/"developer" message role in its session format (verified against the `AgentMessage` union in `session-format.md`); Codex's "keep system/developer messages" instruction has no direct analog here, because the system prompt is applied per-process via `--append-system-prompt`/agent config, never stored as a session message.
This is explicitly noted as a difference from Codex, not a gap: pi-subagent's forked children already get their own persona/system prompt through the normal `AgentSpec.systemPrompt` mechanism, so there is nothing extra to carry over on that axis.

**Decision: "turn" = one user message up to (not including) the next user message.**
`selectLastNTurns(messages: AgentMessage[], n: number): AgentMessage[]`:
1. Find the indices of all `role === "user"` messages in `messages` (pre-sanitization, on the full flattened list, so tool-heavy turns are still counted as one turn each).
2. If there are `k` such indices and `k <= n`, return all of `messages` (nothing to trim).
3. Otherwise, return `messages.slice(indices[k - n])` (from the start of the Nth-from-last user turn to the end).
4. If there are zero user messages at all (degenerate: parent has not sent a first message yet), return `messages` unchanged.
This runs on the pre-sanitized list so turn boundaries are counted against real conversational structure, then the result is passed through the same sanitizer described above.
Alternative considered: define a turn using `--mode json`'s live `turn_start`/`turn_end` events by replaying the parent conversation through an ephemeral agent instance.
Rejected: this is not a documented capability for an already-running session's history (those events exist only for the live event stream of an agent that is currently executing, not as a queryable property of a session file), would be dramatically more expensive (re-running an LLM-driving loop just to count turns), and is unnecessary complexity for a boundary definition that the simple heuristic above already answers unambiguously and testably.

**Decision: emit a calibrated size warning whenever a fork is large, included in this phase's v1.**
`context-fork.ts` exports `describeForkSize(approxTokens: number): { label: "small" | "medium" | "large"; warning?: string }` (reusing `approxTokens()` from feature 2's `result-cap.ts`, a small, acceptable coupling since both features ship in the same phase and need the identical char-based approximation).
Fixed reference points give the calling model calibration instead of an opaque "this is big" statement: under ~2,000 approx tokens is `"small"`, ~2,000-8,000 is `"medium"` (neither warns), and over ~8,000 approx tokens is `"large"` and returns a warning such as:
> "forkContext produced a large context (~{N} approx tokens; for reference: small is under ~2k, large is over ~8k). Consider forkContext:<N> (a specific turn count) instead of \"all\" to reduce cost."

This runs on the actual sanitized+turn-selected message set (measuring the real outcome, not just the requested mode), so it fires for an overly-large `forkContext: <N>` just as readily as for `"all"`.
The warning shares the same one-line warning channel `applyForkContext()` already returns (`{ warning?: string }`); it and the zero-assistant-message warning (5.1.5) are mutually exclusive, so at most one is ever surfaced per call.
This is now committed v1 scope, not a deferred nice-to-have: it is cheap to build (a threshold check plus a fixed string) and serves the same "give the model calibration, not just an alarm" principle the result-cap envelope (5.2) already commits to, so shipping both together in the same phase is more coherent than splitting them across releases.

**Decision: fork happens once per `execute()` call, not once per parallel/chain item, and always forks from the orchestrating (root of this tool call) agent's context, never from a sibling subagent's session.**
For `tasks` (parallel) with several items requesting `forkContext`, each gets its own independently-written child session file, but the *source* message list (the parent's `buildContextEntries()` output) is computed once and reused, then re-sliced per item's own `n`/`all`/`none` value; this avoids redundant work and guarantees every item that asks for "all" gets byte-identical seed content.
Chain steps: a step's `forkContext` always forks from the top-level orchestrating agent (the one whose `execute()` is running), never from the *previous chain step's own subagent session*.
This is a **permanent** scope boundary, not deferred: forking from a sibling/preceding subagent's own session (rather than from the orchestrating agent) is a materially different feature - cross-subagent context forking - that Codex's own `fork_turns` does not support either (it only ever forks from the spawning agent), and this plan intentionally matches that scope exactly rather than extending past it.

**Decision: `forkContext` and `resume` are mutually exclusive, rejected at validation time.**
If an item sets both `resume` and a non-`"none"` `forkContext`, `resolveSpec()` returns `{ error: ... }` before anything spawns, exactly like today's "provide exactly one of agent/systemPrompt/resume" check.
Rationale: a resumed session's file already has accumulated history; there is no meaningful, safe way to retroactively splice sanitized parent history into an already-populated append-only session tree without corrupting its structure.

#### 5.1.2 Locating the parent session (API answer, repeated for emphasis)

No new/invented API is used.
`ctx.sessionManager.buildContextEntries()` (documented, present on `ReadonlySessionManager`) plus the exported standalone `sessionEntryToContextMessages()` function together reconstruct exactly the message list the parent agent itself is using for its next LLM call, respecting compaction and the current branch/leaf.
`ctx.sessionManager.getSessionFile()` is used only for the ephemeral-parent check and optional provenance metadata (see 5.1.10), not for reading content.

#### 5.1.3 Sanitization algorithm (restated as pseudocode for implementers)

```ts
function sanitizeForFork(messages: AgentMessage[]): AgentMessage[] {
  const kept: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") { kept.push(m); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((c) => c.type === "text");
      if (text.length > 0) kept.push({ ...m, content: text });
      continue;
    }
    if (m.role === "compactionSummary" || m.role === "branchSummary") {
      kept.push({ role: "user", content: `[Earlier context summary]\n${m.summary}`, timestamp: m.timestamp });
      continue;
    }
    // toolResult, bashExecution, custom, custom_message: always dropped
  }
  return kept;
}
```

#### 5.1.4 Turn definition for N (restated)

See 5.1.1; implemented as `selectLastNTurns(messages, n)` applied *before* `sanitizeForFork`, operating on the unsanitized flattened list so turn boundaries reflect real conversational turns.

#### 5.1.5 Writing the forked child session

```ts
async function applyForkContext(
  spec: AgentSpec,
  forkContext: ForkContext, // parsed value from parseForkContext
  sessionManager: ReadonlySessionManager,
): Promise<{ warning?: string }> {
  if (forkContext.mode === "none") return {};
  const parentFile = sessionManager.getSessionFile();
  if (!parentFile) return { warning: "forkContext requested but the calling agent has no session (--no-session); proceeding without inherited context." };

  const entries = sessionManager.buildContextEntries();
  let messages = entries.flatMap(sessionEntryToContextMessages);
  if (forkContext.mode === "turns") messages = selectLastNTurns(messages, forkContext.n);
  const sanitized = sanitizeForFork(messages);

  if (!sanitized.some((m) => m.role === "assistant")) {
    return { warning: "forkContext requested but there is no prior assistant turn to fork yet; proceeding without inherited context." };
  }

  const sizeInfo = describeForkSize(approxTokens(sanitized.map((m) => JSON.stringify(m)).join("")));

  const sm = SessionManager.open(spec.sessionFile, undefined, spec.cwd);
  for (const m of sanitized) sm.appendMessage(m as Message | CustomMessage | BashExecutionMessage);
  return sizeInfo.warning ? { warning: sizeInfo.warning } : {};
}
```

This is called from `execute()` in `subagent-tool.ts`, once per resolved spec, immediately after `resolveSpec()` succeeds and before `writeSessionMeta()`/spawn - deliberately *not* threaded into `runSingleAgent()`, keeping that function's responsibility limited to "spawn and stream one process" (a clean separation of concerns; `runSingleAgent()`'s signature does not change for this feature).
The zero-assistant-message edge case (see section 1's `_persist()` note) is handled by explicitly checking for at least one assistant message before attempting to write, rather than fighting the internal laziness; when it triggers, the call proceeds without forking and surfaces a one-line warning in the tool's output text, which is a fully acceptable degraded behavior for what is an edge case (delegating before the parent has said anything yet).

#### 5.1.6 Schema changes

- `agentSelectionFields.forkContext?: string` added to `subagent-tool.ts`'s shared field set, so it appears on the top-level `SubagentParams`, `TaskItem`, and `ChainItem` schemas.
- `AgentSpec` gains `forkContext: ForkContext` (the parsed, non-string form) and optionally `forkWarning?: string`.
- `SessionMeta` (the `.meta.json` shape) gains an optional `forkedFrom?: string` (absolute path to the parent's session file at fork time) and `forkContext?: "none" | "all" | number` for provenance/debugging; purely additive, backward compatible with old meta files that lack it.

#### 5.1.7 Interaction with resume / parallel / chain (restated as a table)

| Mode | Behavior |
|---|---|
| single | `forkContext` on the top-level params forks from the calling agent's context into the new session before spawn. |
| parallel (`tasks`) | Each task item's own `forkContext` is honored independently; parent context is read once and re-sliced per item. |
| chain | Each step's own `forkContext` forks from the orchestrating agent; never from a previous step's own subagent session (permanent scope boundary, 5.1.1). |
| `resume` set | `forkContext` other than `"none"` is a validation error, surfaced before any process spawns. |

#### 5.1.8 File-by-file changes

- **New: `extensions/subagent/context-fork.ts`**
  - `parseForkContext(raw: string | undefined): ForkContext | { error: string }`.
  - `selectLastNTurns(messages: AgentMessage[], n: number): AgentMessage[]`.
  - `sanitizeForFork(messages: AgentMessage[]): AgentMessage[]`.
  - `describeForkSize(approxTokens: number): { label: "small" | "medium" | "large"; warning?: string }` (imports `approxTokens` from `./result-cap.ts`).
  - `applyForkContext(spec, forkContext, sessionManager): Promise<{ warning?: string }>` (imports `SessionManager`, `sessionEntryToContextMessages` from `@earendil-works/pi-coding-agent`).
- **Modified: `extensions/subagent/subagent-tool.ts`**
  - `agentSelectionFields` gains `forkContext`.
  - `AgentSpec` gains `forkContext`/`forkWarning`.
  - `resolveSpec()` calls `parseForkContext()`, returns `{ error }` on parse failure or on `resume` + non-`"none"` conflict.
  - `execute()`: after each successful `resolveSpec()` (single, each parallel item, each chain step), call `applyForkContext(...)`, collect any `warning`, and prepend it to that item's eventual output text (or to the chain/parallel step's result text) so it is visible to the calling model, not silently swallowed.
  - `writeSessionMeta()` extended to persist `forkedFrom`/`forkContext` when applicable.
  - `renderCall()` shows a small `[fork: all]`/`[fork: 5]` tag next to the scope tag when set, for human visibility in the transcript.
  - `renderResult()`'s single/parallel/chain expanded views show the fork provenance line (`forked from: <parent session file>`) when `forkedFrom` is present in meta/details.
- **Modified: `README.md`**
  - New "Context forking" section with the `forkContext` examples and the `resume` exclusion stated plainly.

#### 5.1.9 Tests

- **New: `tests/context-fork.test.mjs`**
  - `parseForkContext`: `"none"`/`undefined` -> `{mode:"none"}`; `"all"` -> `{mode:"all"}`; `"5"` -> `{mode:"turns", n:5}`; `"0"`, `"-1"`, `"abc"` -> `{error:...}`.
  - `selectLastNTurns`: a 3-user-turn message list with `n=1` returns only the last turn's messages; `n` larger than available turns returns everything unchanged; a message list with zero user messages returns everything unchanged.
  - `sanitizeForFork`: an assistant message with only a `toolCall` part is dropped entirely; an assistant message with `thinking` + `text` parts keeps only the `text` part; a `toolResult`/`bashExecution` message is dropped; a `custom`/`custom_message` entry is dropped unconditionally, including one with `display: true`; a `compactionSummary`/`branchSummary` message becomes a synthetic `user` message containing `"[Earlier context summary]"` and the original summary text; a plain `user` message passes through unchanged (deep-equal check, including `timestamp`).
  - `describeForkSize`: just under 2000 approx tokens -> `"small"`, no warning; between 2000 and 8000 -> `"medium"`, no warning; just over 8000 -> `"large"`, warning text contains both `"~2k"` and `"~8k"` reference points and the phrase `forkContext:<N>`.
  - `applyForkContext` (integration-style, using a real temp directory and a real `SessionManager` from `@earendil-works/pi-coding-agent` acting as a fake "parent"): building a parent session with a few user/assistant/tool-call turns, then forking `"all"` into a fresh target path, then re-opening the target with `SessionManager.open()` and asserting `buildContextEntries()` on the child contains exactly the sanitized message set and no tool-call/thinking content; this is the round-trip test that guards against silent format drift, per the concern raised in section 1.
  - `applyForkContext` returns a `warning` (does not throw, does not create a file) when the parent has no session file (ephemeral parent simulation) and when the parent has zero prior assistant messages.
  - `applyForkContext` returns the `describeForkSize` warning when forking a large synthetic parent history.
  - `resolveSpec` (existing test file extension in `subagent-tool.ts`'s own tests, or a new focused test): `resume` + `forkContext: "all"` together produces an `{error}`.

#### 5.1.10 Edge cases and risks

- **Cost/size risk**: `forkContext: "all"` on a long-running parent conversation can inject a very large amount of history into every forked child, and into every item of a parallel batch that requests it, multiplying token cost.
  Mitigated by the committed size warning (5.1.1), which surfaces calibrated guidance (`describeForkSize`) rather than leaving this as a silent cost; the warning is advisory only and does not block the call, since a genuinely large fork can still be the right choice.
- **Zero-assistant-message parent**: handled explicitly (5.1.5), degrades to "no fork" with a warning rather than a crash or a silently empty child session.
- **`CustomMessage` always dropped**: an extension that injects meaningful context via `custom_message` entries loses that context on fork, unconditionally, including `display: true` ones (5.1.1's decision).
  This is a deliberate, permanent v1 simplification, not an open question; a concrete integration such as pi-atlassian-mcp can be revisited later against a real, demonstrated need, but is not designed for speculatively here.
- **Fork writes happen synchronously in the extension's own process, before spawn**: this adds a small amount of latency (reading+writing a JSONL file) to every forking call; expected to be negligible (single-digit milliseconds for realistic session sizes) but worth a note in case very large ("all" on a multi-thousand-message session) parents make it noticeable; no special handling planned beyond noting it.
- **Chain-to-chain / parallel-sibling forking is permanently out of scope**: not a deferred decision; if a genuine need for it emerges later it would need its own separate design (addressing a sibling subagent's own session as a fork source), not an extension of this feature.

### 5.2 Feature 2: result cap and envelope

#### 5.2.1 Design decisions and alternatives considered

**Decision: cap the text sent to the calling model (`content[].text`), never the rich `details` used for TUI rendering, and never the child process itself.**
`AgentToolResult` already separates `content` (what the LLM sees) from `details` (what `renderResult()`/Ctrl+O use); this split already exists in the codebase and needs no new API.
Capping only `content` means the human-facing expanded view (Ctrl+O) and the resumable session remain fully intact and uncapped; only the token cost paid by the *orchestrating model* is bounded.
This is stated as an explicit, load-bearing guarantee, not an implementation detail: **the cap never disrupts, truncates, or otherwise affects the child subagent process itself.**
The child always runs to completion exactly as it would without a cap, and every message it produced is fully preserved in its own session file; only the text handed back to the *calling* model in this one tool result is shortened.
This means a capped result is always recoverable in two ways: reading the child's session file directly (see below), or calling `subagent` again with `resume` set to the same session id, which returns to that agent with its full accumulated context regardless of how any earlier result was capped.

**Decision: char-based approximation for "tokens," not a real tokenizer.**
`approxTokens(text) = Math.ceil(text.length / 4)` (a widely used, provider-agnostic heuristic), matching the task's explicit allowance for "a char-based approximation" and consistent with this codebase's existing byte-based cap (`PER_TASK_OUTPUT_CAP`, which this feature replaces).
Alternative considered: pull in a real tokenizer (e.g. a BPE library) per-model.
Rejected: adds a dependency, and the "right" tokenizer differs per provider/model (the very inconsistency this project otherwise avoids by staying model-agnostic); a documented approximation is good enough for a soft protective cap whose purpose is "roughly bound context usage," not exact accounting.

**Decision: three-tier `resultCapTokens` (per-item > per-call > config default > built-in 1000), on by default, no phased rollout.**
`resultCapTokens` is added to `agentSelectionFields`, the same shared field set `forkContext`/`resume`/`model`/`tools`/`thinking` already live in, so it is available identically on `TaskItem`, `ChainItem`, and the top-level `SubagentParams` object (which doubles as both "the call" for single mode and "the batch default" for parallel/chain items that omit their own value).
The effective cap for a given agent run is resolved as `item.resultCapTokens ?? callLevel.resultCapTokens ?? loadSubagentConfig().resultCapTokens ?? 1000`, using `??` rather than `||` so an explicit `0` at any level is honored as "disable the cap at that level" instead of being treated as absent.
This directly supports mixed-priority parallel batches, for example capping three quick lint-check agents to a small size while leaving one deep-review agent uncapped in the same call, by setting `resultCapTokens: 0` on just that one task item.
The feature ships on by default at ~1000 tokens, matching Codex's own always-on completion cap; there is no opt-in/phased-rollout period, since the `0` escape hatch (at any of the three levels) and the "read the session file directly" recovery path (below) already fully cover the "I need the full thing" case without needing a slower rollout.
This precedence is documented in the `resultCapTokens` parameter's own schema description, not only in this plan, so the calling model can discover it without reading source.

**Decision: the truncation notice points at the child's session file path first, `resume` second.**
When a result is truncated, the envelope's trailing notice is:
> `[truncated: showing ~{cappedTokens} of ~{originalApproxTokens} approx. tokens. Full output: read {sessionFile} directly (the JSONL tail has the rest), or resume session "{sessionId}" to continue this agent with full context.]`

or, for the rare case a session file is unavailable, `(cannot resume or re-read: this run has no session file)`.
The session file path is surfaced first and the `resume` pointer second, because the calling model already has a `read` tool, and reading a JSONL file's tail lines is strictly cheaper (no new subagent process, no extra turn, immediate) than a full `resume` round trip through another `subagent` call; `resume` remains valuable as the way to *continue* the conversation with that agent, not merely to *see* more of what it already said.
This requires `SingleResult` to carry the resolved session file path (`sessionFile?: string`, populated from `AgentSpec.sessionFile` at the same point `sessionId`/`model` already are); since `quick_task`'s ephemeral mode is removed (4.2), `sessionFile`/`sessionId` are now effectively always present on every `SingleResult` going forward.

**Decision: plain-text envelope, one line per result, not JSON.**
Format: `[agent: <name> | model: <model> | status: <completed|failed|aborted> | session: <id>]` followed by the (possibly capped) payload text and, when truncated, the notice above.
Alternative considered: a structured JSON object as the envelope, closer to Codex's internal `Message Type / Task name / Sender / Payload` framing.
Rejected: the calling model only ever sees `content[].text`, a string; a JSON envelope burns tokens on syntax the model has to re-parse mentally for no benefit over an equally information-dense plain-text header line, and it does not match this codebase's existing plain-text conventions (the existing `sessionHint()`/parallel summaries are already plain text headers).
This envelope subsumes and replaces today's ad hoc `sessionHint()` (single mode) and the `### [name] status (session: id)` headers used in parallel mode's summary construction; both are consolidated into one shared formatter used by all three modes.

**Decision: cap applies uniformly to single/parallel/chain's calling-model-visible text.**
For chain mode specifically, the `{previous}` substitution between steps uses the **uncapped, un-enveloped** final output of the prior step (an internal pipeline handoff between subagents that never touches the orchestrating model's context, so there is no reason to degrade it); only the very last step's contribution to the tool's final `content[]` text is capped/enveloped, and each intermediate step's own `details.results[i]` entry stays uncapped for the rich renderer.
For parallel mode, each task's own summary block inside the concatenated output is capped/enveloped individually using that task item's own resolved cap (replacing today's single, cruder `truncateParallelOutput()`/`PER_TASK_OUTPUT_CAP`), so 8 agents each returning a lot of text cannot together blow well past the intended per-call budget, and a mixed-priority batch (lint checks capped, deep review uncapped) works exactly as described above.

#### 5.2.2 Schema changes

- `agentSelectionFields.resultCapTokens?: Type.Optional(Type.Integer({ minimum: 0, description: "Override the result cap (approx. tokens) for this agent; 0 disables it. Falls back to the call-level value, then the configured default, then 1000." }))`, available on `TaskItem`, `ChainItem`, and (via the same shared field set) the top-level `SubagentParams`.
  A plain optional integer, deliberately not unioned with anything else, so it carries no Google-compatibility risk (see section 1).
- `subagent.json` gains `resultCapTokens?: number` (default 1000 when absent), read by `config.ts`; this is the third, lowest-precedence tier.
- `SingleResult` gains `sessionFile?: string`.

#### 5.2.3 File-by-file changes

- **New: `extensions/subagent/result-cap.ts`**
  - `approxTokens(text: string): number`.
  - `capText(text: string, maxTokens: number): { text: string; truncated: boolean; originalApproxTokens: number }` - `maxTokens <= 0` means no cap (returns input unchanged, `truncated: false`).
  - `resolveResultCap(itemLevel: number | undefined, callLevel: number | undefined, configLevel: number | undefined): number` - implements the `??`-chained precedence in 5.2.1, defaulting to `1000`.
  - `formatEnvelope(result: SingleResult, capped: { text: string; truncated: boolean }, opts: { maxTokens: number }): string` - builds the one-line header plus payload plus, when `truncated`, the trailing notice from 5.2.1 (session file path first, `resume` second), matching the wording style already used in `abort-output.ts`.
- **Modified: `extensions/subagent/config.ts`**
  - `SubagentConfig` gains `resultCapTokens?: number`; `loadSubagentConfig()` validates it is a non-negative number, otherwise ignores it (falls back to default).
- **Modified: `extensions/subagent/subagent-tool.ts`**
  - `agentSelectionFields` gains `resultCapTokens` (shared placement, per 5.2.2).
  - `runSingleAgent()` populates `SingleResult.sessionFile` from `spec.sessionFile`.
  - `execute()`: for each resolved item (single params object, each parallel task, each chain step), resolve its effective cap via `resolveResultCap(item.resultCapTokens, params.resultCapTokens, loadSubagentConfig().resultCapTokens)`.
  - Single mode: replace the `sessionHint()`-appended success text with `formatEnvelope(result, capText(getFinalOutput(result.messages), effectiveCap), { maxTokens: effectiveCap })`.
  - Parallel mode: replace `truncateParallelOutput(getResultOutput(r))` and the `### [${r.agent}] ...` header construction with `formatEnvelope(r, capText(getResultOutput(r), effectiveCap), { maxTokens: effectiveCap })` per task (using that task's own resolved cap), keeping the outer `Parallel: N/M succeeded` summary line as-is.
  - Chain mode: only the final `content[]` text (the last step's output) goes through `formatEnvelope`/`capText`; the `{previous}` substitution keeps using raw `getFinalOutput()` as today.
  - Remove now-dead code: `sessionHint()`, `truncateParallelOutput()`, `PER_TASK_OUTPUT_CAP` constant (all superseded).
  - `renderResult()` is unaffected in its expanded/rich paths (those already read from `details`, not the capped `content`), except that the *collapsed* single-line preview at the very bottom of a result (if it currently echoes `content[0].text`) should keep using the uncapped `details`-derived text for the TUI, not the capped model-facing text; this needs a small check when implementing to make sure a capped/enveloped string never accidentally becomes the primary thing a human sees in the TUI (humans should see the good, existing rich renderer; only the LLM sees the capped envelope).
- **Modified: `README.md`**
  - New "Result cap" section documenting the three-tier `resultCapTokens` (item, call, config), the `0`-disables-it escape hatch at each level, and the envelope format with an example, including the mixed-priority parallel-batch example.

#### 5.2.4 Tests

- **New: `tests/result-cap.test.mjs`**
  - `approxTokens`: simple length/4 rounding checks.
  - `capText`: text shorter than the cap returns unchanged with `truncated:false`; text longer than the cap is truncated to approximately the right length with `truncated:true`; `maxTokens: 0` disables capping regardless of input length.
  - `resolveResultCap`: item value wins when present, even `0`; falls back to call value when item is `undefined`; falls back to config value when both item and call are `undefined`; falls back to `1000` when all three are `undefined`; `0` at any level is honored, never treated as "absent."
  - `formatEnvelope`: contains agent name, model, status, and session id for a successful result; contains the truncation notice with both the session file path and `resume session "<id>"` wording when `truncated` is true; contains the "cannot resume or re-read" wording only in the (now rare) case `sessionFile` is absent.
- **Modified: `tests/abort-output.test.mjs`**: unaffected (feature 2 explicitly does not re-cap the abort-recovery path, per 5.2.1); add one assertion confirming `getResultOutput()` for an aborted result is *not* passed through `capText`/`formatEnvelope` in `execute()` (covered indirectly via a `subagent-tool`-level test if one gets added; otherwise documented as a manual invariant to preserve during implementation).

#### 5.2.5 Edge cases and risks

- **Truncation boundary cutting mid-multibyte-character or mid-markdown-construct**: `capText` should truncate on a UTF-8-safe boundary (reuse the existing byte-safe truncation loop pattern already present in `truncateParallelOutput()` today, adapted to the new char-based token approximation) to avoid producing invalid UTF-8 or a dangling unterminated code fence; call out as an implementation detail worth a dedicated test (truncate a string containing a multi-byte emoji and a triple-backtick code fence, assert no invalid UTF-8 and no obviously broken markdown left open - or, more simply, always append a closing notice fenced clearly so any broken markdown before it is visually contained).
- **Interaction with the abort path**: `formatAbortedResult()`/`formatAbortedRecovery()` already have their own tailored truncation (`ABORT_ITEM_MAX_CHARS`, last-10-items); the plan deliberately does not re-run these through the new cap to avoid double-truncation artifacts or losing the carefully structured recovery format; this must be preserved during implementation (see the test note above).
- **Precedence footguns**: a parallel batch's per-item `resultCapTokens: 0` on one task while the call-level default stays capped is intentional and expected (the lint-check vs. deep-review scenario); this is documented in both the parameter's own schema description and the README so the calling model and human operators can discover it without reading this plan or the source.
- **Backward compatibility**: omitting `resultCapTokens` everywhere still returns *some* text (previously literally unbounded single/chain output, and byte-capped-at-50KB parallel output); this is a behavior change by design (that is the point of the feature), ships on by default with no phased rollout, and should be called out clearly in the release notes as a default-on change, not hidden as a silent default.

## 6. Phase 3: root-scoped depth budget and persisted agent graph (features 5 and 6)

This phase is the riskiest because it removes the current hard invariant "subagents cannot spawn subagents" (enforced today by simply not registering the `subagent` tool inside a child process) and replaces it with a runtime, cross-process budget that is active by default, not opt-in.

### 6.1 Feature 5: root-scoped budget instead of a hard grandchild ban

#### 6.1.1 Design decisions and alternatives considered

**Decision: `maxDepth` defaults to `2`, not `1`; the hard grandchild ban is lifted by default.**
Children (depth-1 subagents) get the `subagent` tool registered by default, and can spawn their own depth-2 subagents, bounded by the tree-wide `maxLiveChildren: 4` budget below.
`maxDepth: 1` remains available and fully supported as an explicit config value for anyone who wants to restore the exact pre-existing behavior (no grandchildren at all); it is documented in the README as the way to opt back out, not removed.
This default is chosen because: the tree-wide budget (`maxLiveChildren: 4`) is a real safety mechanism from the moment it ships, not a theoretical one waiting for opt-in validation; its default value of `4` happens to exactly match the existing, already-shipped, already-trusted local parallel concurrency limit (`MAX_CONCURRENCY = 4` in `subagent-tool.ts`), so a plain, non-nested parallel batch of up to 4 tasks behaves identically to today even with the coordinator always active; and a depth of `2` (not "unlimited") is a small, bounded expansion - one additional level, a planner can spawn executors, executors cannot themselves spawn further executors - rather than the fully open-ended recursion Codex V2 allows, keeping the blast radius of a misbehaving delegation chain small even in the worst case.
Alternative considered: keep `maxDepth: 1` as the shipped default, with `2` only available as an opt-in (this was the original recommendation drafted while writing this plan).
Rejected: the budget mechanism is judged to be a real, always-correct safety net rather than a claim needing separate validation by early adopters first, and a bounded depth of `2` is a modest enough expansion that shipping it as the default is worth the added exposure of the new coordinator code from day one described immediately below.

**Honest consequences of this default**, stated plainly rather than left implicit:
- The coordinator (this section's Unix-socket protocol) now starts on **every** top-level `subagent` tool call by default, including plain, non-nested, single-task calls with no UI, because the "should a coordinator exist" condition (below) is now true unconditionally by default. This is accepted: the coordinator's cost (one `mkdtempSync`'d Unix socket per top-level call, torn down in the same `finally` block that already exists today) is small, and having it exercised on every call from day one, rather than only by users who explicitly opt into nesting, means bugs in the new coordinator code surface quickly across the whole user base instead of only for a small, self-selected group of deep-nesting early adopters.
- A depth-1 subagent process now has the `subagent` tool registered by default, meaning a model running as a depth-1 subagent can decide, on its own, to delegate further; this is a genuine expansion of subagent capability that did not exist before this plan, and depends on the same `promptGuidelines`/delegation-policy text (4.1) being visible inside that subagent process too (it is: the guard below controls whether the tool is *registered*, not whether the guidelines apply once it is).
- A dangerous-bash approval request from a depth-2 grandchild now goes through the coordinator's `{ type: "approval" }` path and gets an explicit `{ allow: false }` reply when there is no UI to prompt through (because `ui.select` is `undefined`), rather than the older "no approval channel at all" block reason; the net behavior (blocked) is unchanged, only the block *message* text differs slightly, which is noted here so it does not look like a regression during review.
- `maxLiveChildren: 4` is, by default, enforced tree-wide across every subagent call now, not just ones that opt into nesting. Because its value matches the pre-existing local `MAX_CONCURRENCY` constant exactly, an ordinary parallel batch of up to 4 tasks from a non-nested root is unaffected in practice (it never needs more than 4 concurrent slots, which the budget grants immediately); only batches that combine parallelism *and* nesting (for example a root's 4 parallel tasks each also delegating further) can actually hit the budget ceiling and see a "budget exhausted" result, which is exactly the scenario this mechanism exists to bound.

**Decision: depth is tracked via a new environment variable, `PI_SUBAGENT_DEPTH` (integer, absent/`"0"` at the true root), incremented by 1 on every spawn.**
`index.ts`'s current guard `if (!process.env.PI_SUBAGENT) { registerSubagentTool(pi); }` generalizes to `if (depth < maxDepth) { registerSubagentTool(pi); }` where `depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0")` and `maxDepth` comes from `subagent.json` (default `2`, per above).
With this default, a depth-0 root (`0 < 2`) and a depth-1 child (`1 < 2`) both register the tool; a depth-2 grandchild (`2 < 2` is false) does not, so it remains a leaf, exactly matching the "one additional level" framing above.
Setting `maxDepth: 1` in config reduces this to today's exact original behavior (`1 < 1` is false, so depth-1 children do not register the tool).

**Decision: the live-children budget is a single, tree-wide semaphore hosted by the true root, reached over the existing Unix domain socket, using a hold-open-connection lease pattern.**
The socket already used for approval proxying (`approval-server.ts`/`gate.ts`, env var currently named `PI_SUBAGENT_GATE_SOCKET`) is generalized into a small coordinator protocol with three message kinds instead of one:
- `{ type: "approval", id, agent, toolName, input, reasons }` (today's message, now explicitly tagged; the existing shape is otherwise unchanged, and the response is unchanged: `{ id, allow }`).
- `{ type: "acquire", id, agent }` - requests one "live child" slot. The server does **not** reply immediately if the tree is at capacity; it queues the request and keeps the connection open. When capacity frees up, it replies `{ id, granted: true }` on that same connection and leaves it open. If `budgetAcquireTimeoutMs` (default 120000) elapses first, it replies `{ id, granted: false, reason: "budget exhausted" }` and closes.
- `{ type: "status_count", agentSessionId, nestedCount }` - fire-and-forget, no reply; see the widget decision below.
Release is implicit: the client holds the *same* socket connection open for the entire lifetime of the spawned child process, and closes it (`socket.end()`) right after the child process exits. The server's existing `connection.on("close")` handler (already present in `approval-server.ts` for cleanup) decrements the live-child counter and immediately tries to grant the next queued `acquire` request, if any.
Alternative considered (explicitly the one hinted at in the task): an env-passed counter, decremented locally as depth increases.
Rejected as insufficient for the stated goal ("total across the tree"): concurrent sibling branches spawned by *different* nodes in the tree cannot see each other's live-child counts through a value baked into environment variables at spawn time, because each subagent is an independent OS process with its own copy of the environment; only a single shared, mutable counter reachable by every node (i.e. IPC to one coordinator) can enforce a true tree-wide cap. The env-var approach is kept only for `PI_SUBAGENT_DEPTH` (a monotonically-increasing value that genuinely does not need cross-process coordination) and for propagating the fixed `maxLiveChildren`/`budgetAcquireTimeoutMs` values down so every node uses the same configured numbers even though only the root enforces them.
Alternative considered for the lease itself: explicit `acquire`/`release` request-response pairs as two separate short-lived connections (matching the existing one-shot `requestApproval()` pattern exactly).
Rejected in favor of the hold-open-lease pattern: an explicit "release" message can be lost if the child process (or the extension code in the spawning process) crashes/is killed before it gets a chance to send it, silently leaking a permanent slot for the remainder of that root tool call; tying release to the OS-level fact of "the socket connection closed" (which happens automatically on process death, `SIGKILL` included) makes leak-proof cleanup free instead of something that has to be gotten right in every code path (including the abort/kill path below).

**Decision: bounded wait, not infinite queueing, and not immediate rejection.**
A pure "reject immediately if full" policy would make ordinary, expected near-capacity moments (for example, 4 slots busy, one about to finish in half a second) needlessly fail a legitimate delegation.
A pure "queue forever" policy risks a real deadlock specific to this project's synchronous, blocking child-process model: a node that is *itself* holding a live-child slot for its entire run can, partway through, ask for one more slot to spawn its own child; if every slot is currently held by processes that are each, transitively, waiting on a further slot that never frees, the whole tree can wedge permanently (this cannot happen in Codex's async model, where a "waiting" thread does not pin a scheduler slot the whole time, but it can happen here, because a live "child" here is a real OS process that exists for its entire run, whether or not it is itself blocked on a grandchild).
The bounded timeout (default 120s, configurable) turns a potential permanent deadlock into, at worst, a slow, explicit, recoverable failure: the requester gets `{ granted: false, reason: "budget exhausted" }`, and the tool call returns a clear error result instructing the calling model to try again shortly or increase `maxLiveChildren`, rather than hanging forever.
This tradeoff (a strict architectural risk of the synchronous process model, mitigated but not eliminated by a timeout) is called out explicitly as a risk in 6.1.5, not swept under the rug.

**Decision: the coordinator exists whenever `ctx.hasUI` is true OR `maxDepth > 1`; with the shipped default of `2`, this means it exists on essentially every top-level call out of the box.**
The exact condition is `const shouldStartCoordinator = ctx.hasUI || config.maxDepth > 1;`.
With the shipped default (`maxDepth: 2`), this is unconditionally true; only a user who explicitly sets `maxDepth: 1` gets back the narrower "only when there is a UI" behavior that this plan originally proposed as the default.
Any node that is *not* the coordinator owner (i.e. it inherited `PI_SUBAGENT_COORDINATOR_SOCKET` - see naming note below - from its own parent) must reuse that inherited socket path for both approvals and acquire/release, and must never close it in its own `finally` block; only the process that actually created the server closes it. Getting this wrong would let a depth-1 node tear down the shared root coordinator out from under still-running sibling branches, an easy and severe bug to introduce, called out explicitly here so it is a deliberate implementation checklist item, not an afterthought.

**Decision: rename `PI_SUBAGENT_GATE_SOCKET` to `PI_SUBAGENT_COORDINATOR_SOCKET`.**
This env var is purely an internal implementation detail (not documented in the README as a public contract, unlike `PI_SUBAGENT_INHERITED_TOOLS`, which *is* documented for third-party extensions like pi-atlassian-mcp and must not be touched).
Once the socket carries budget/status traffic in addition to approvals, keeping the old "gate" name would be misleading for future maintainers; renaming is cheap in a codebase this size (four files reference it) and is done in the same change that generalizes the protocol, with no deprecated-alias period needed since there are no external consumers.

**Decision: abort cascades by killing the whole process group; verified on macOS, implemented but untested on Windows.**
Today, aborting the parent's turn sends `SIGTERM` (then `SIGKILL` after 5s) to the immediate child `pi` process only (`proc.kill(...)` in `runSingleAgent`).
Whether pi-core itself forwards that signal on to *its own* spawned grandchild processes is undocumented and unverified; the plan does not rely on it either way.
Instead, every `spawn()` call in `runSingleAgent()` is changed to run the child in its own process group on POSIX (`detached: true`), and the kill path is changed to signal the negative pid (`process.kill(-proc.pid, "SIGTERM")`, falling back to `proc.kill("SIGTERM")` if the negative-pid form throws), which reliably terminates the entire subtree of OS processes the child (and, transitively, anything it spawned) created, regardless of pi-core's own internal signal handling.
This is the primary supported and manually-verified target platform for this feature (macOS; Linux is expected to behave the same, since it shares the same POSIX process-group semantics, though it has not been separately exercised).
Windows lacks POSIX process groups; a `taskkill /pid <pid> /t /f` fallback is implemented for `process.platform === "win32"`, but it is explicitly documented, in code comments and in the README, as **untested** - there is no Windows environment available during development of this feature.
This is stated plainly rather than glossed over: Windows users get a best-effort implementation of the abort-cascade fix, not a verified one, until someone with a Windows environment can confirm it.

**Decision: the live widget ships the simple "+N nested" fallback only; full per-agent recursive rendering is explicitly deferred, not part of this phase.**
The `{ type: "status_count", agentSessionId, nestedCount }` message (introduced above) is sent fire-and-forget by any non-owner node whenever the number of subagents it has itself spawned changes, letting the coordinator owner (the true root) append a `+{n} nested` suffix to that direct child's own existing widget row (via `WidgetTracker`) without needing per-grandchild identity, model, or tool detail.
Under the shipped default (`maxDepth: 2`), `status_count` messages can only ever originate from depth-1 processes reporting their own depth-2 children, since depth-2 processes never register the `subagent` tool and so can never spawn anything; the root's `WidgetTracker` already has a row per depth-1 child keyed by that child's own session id, so attributing a `status_count` message to the right row is a direct lookup.
If a user raises `maxDepth` beyond `2`, the same mechanism still works but its granularity naturally coarsens the deeper nesting goes, since counts only bubble up one level at a time; this is accepted as a reasonable limit of the simple design, not solved further here.
This is a firm scope decision for this phase, not an option left open for later: it covers "the operator can tell that deeper delegation is happening and roughly how much of it," which is the operationally important part, while avoiding the full lineage-labeled, per-agent live-row design (richer `WidgetTracker` row model, `{ type: "status", agentSessionId, parentSessionId, rootId, name, model, tool, usage, phase }` messages, labels like `planner > executor-1`) sketched while drafting this plan, which has, by a wide margin, the worst effort-to-value ratio of anything in this document.
That richer design remains a reasonable fast-follow once the budget/depth mechanism itself has run in production for a while, but it is out of scope here and not detailed further.

#### 6.1.2 Schema / config changes

`subagent.json` gains:

```jsonc
{
  "maxDepth": 2,
  "maxLiveChildren": 4,
  "budgetAcquireTimeoutMs": 120000
}
```

`maxDepth: 1` is the documented way to restore the pre-existing hard ban.
No new tool parameters for this feature; it is entirely config-driven and process/env-driven, not something the calling model configures per call (a model should not be able to raise its own recursion budget from inside a task string).

#### 6.1.3 File-by-file changes

- **Modified: `extensions/subagent/config.ts`**
  - `SubagentConfig` gains `maxDepth?: number`, `maxLiveChildren?: number`, `budgetAcquireTimeoutMs?: number`, each validated (positive integers) and defaulted (`2`, `4`, `120000` respectively) when absent/invalid.
- **Modified: `extensions/subagent/index.ts`**
  - Depth read: `const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");`.
  - Guard generalized: `if (depth < loadSubagentConfig().maxDepth) { registerSubagentTool(pi); }` (still inside the `session_start` handler introduced in phase 1, so `maxDepth` changes take effect on the next session start like other config).
- **Modified: `extensions/subagent/gate.ts`**
  - `PI_SUBAGENT_GATE_SOCKET` renamed to `PI_SUBAGENT_COORDINATOR_SOCKET` everywhere it is read/written.
  - `ApprovalRequest` gains `type: "approval"` (explicit discriminant); `requestApproval()`'s outgoing message includes it.
  - No behavioral change to the dangerous-bash classification logic itself.
- **Modified: `extensions/subagent/approval-server.ts`**
  - Message handling generalized to a discriminated union: `type CoordinatorMessage = ({ type: "approval" } & ApprovalRequest) | { type: "acquire"; id: string; agent: string } | { type: "status_count"; agentSessionId: string; nestedCount: number };`.
  - `startApprovalServer(ui, options)` gains `options: { maxLiveChildren: number; acquireTimeoutMs: number; onStatusCount?: (agentSessionId: string, nestedCount: number) => void }`.
  - Internal state: `let liveCount = 0; const pendingAcquires: Array<{ resolve: (granted: boolean) => void; connection: Socket; timer: NodeJS.Timeout }> = [];` (or equivalent), granting FIFO as capacity frees.
  - `connection.on("close", ...)` (already present for approval cleanup) extended to also: decrement `liveCount` if this connection held a granted acquire lease, then attempt to grant the next queued request.
  - `ui.select` callback path (approval messages) unchanged in behavior; when no UI is available (`ui.select` undefined, i.e. a headless process anywhere in the tree), approval requests are answered `{ allow: false }` immediately, preserving today's documented "headless without a UI blocks dangerous bash" behavior even though a socket now exists for other reasons.
  - `status_count` messages are forwarded to `options.onStatusCount` without a reply (fire-and-forget).
- **New: `extensions/subagent/agent-budget.ts`**
  - `acquireChildSlot(socketPath: string, agent: string, timeoutMs: number): Promise<{ granted: true; release: () => void } | { granted: false; reason: string }>` - opens the connection, sends `{type:"acquire", id, agent}`, resolves on the server's reply, and on `granted: true` returns a `release()` closure that calls `socket.end()`; on `granted: false` or a connection error, resolves `{ granted: false, reason }` (never throws, matching this codebase's existing "fail with a clear error result, don't crash the tool call" convention).
- **Modified: `extensions/subagent/subagent-tool.ts`**
  - Coordinator-ownership decision in `execute()`:
    ```ts
    const inherited = process.env.PI_SUBAGENT_COORDINATOR_SOCKET;
    const config = loadSubagentConfig();
    let approvalServer: ApprovalServer | null = null;
    let ownsCoordinator = false;
    let gateSocketPath: string | undefined = inherited;
    if (!inherited && (ctx.hasUI || config.maxDepth > 1)) {
      approvalServer = startApprovalServer(
        { select: ctx.hasUI ? (t, o) => ctx.ui.select(t, o) : undefined },
        { maxLiveChildren: config.maxLiveChildren, acquireTimeoutMs: config.budgetAcquireTimeoutMs },
      );
      gateSocketPath = approvalServer.socketPath;
      ownsCoordinator = true;
    }
    ```
    and in the `finally` block, `if (ownsCoordinator) approvalServer?.close();` (never close an inherited socket).
  - `runSingleAgent()`: before `spawn()`, if `gateSocketPath` is set (true by default, per 6.1.1), call `acquireChildSlot(gateSocketPath, spec.name, budgetAcquireTimeoutMs)`; on `{granted:false}`, return an `errorResult(spec.name, task, "Root agent budget exhausted (max N live subagents); try again once a sibling finishes, or raise maxLiveChildren in ~/.pi/agent/subagent.json", step)` without spawning; on `{granted:true}`, keep the returned `release()` closure and call it in the existing `finally` block (alongside the existing prompt-tempfile cleanup), right after (or as part of) `proc.on("close", ...)`.
  - `spawn()`'s options gain `detached: process.platform !== "win32"`; the `signal`-driven `killProc()` closure is changed to try `process.kill(-proc.pid, "SIGTERM")` (POSIX, verified on macOS) or spawn `taskkill /pid <pid> /t /f` (Windows, implemented but untested) instead of `proc.kill("SIGTERM")`, with a fallback to the old direct-kill call if the process-group kill throws.
  - `spawn()`'s `env` block gains `PI_SUBAGENT_DEPTH: String(depth + 1)`, `PI_SUBAGENT_SESSION_ID: spec.sessionId`, `PI_SUBAGENT_ROOT_ID: process.env.PI_SUBAGENT_ROOT_ID ?? spec.sessionId`, `PI_SUBAGENT_COORDINATOR_SOCKET: gateSocketPath` (renamed from today's `PI_SUBAGENT_GATE_SOCKET`).
  - `formatToolCall()` gains a `case "subagent":` branch for nicer inline rendering of nested delegation calls that show up as ordinary tool calls inside a child's own message stream (a small, low-risk polish item, not required for correctness).
  - `WidgetTracker`: when not the coordinator owner, a `status_count` update is sent via a fire-and-forget socket message (6.1.1) instead of calling `ctx.ui.setWidget` (which is already a no-op there, since headless processes have `ctx.hasUI === false`); when the coordinator owner, `createWidgetTracker()`'s row map is extended to accept a `nestedCount` for a given row and render the `+{n} nested` suffix.

#### 6.1.4 Tests

- **New: `tests/agent-budget.test.mjs`**
  - Start a real `startApprovalServer` with `maxLiveChildren: 2` and no UI callback; issue 3 concurrent `acquireChildSlot()` calls; assert exactly 2 resolve `granted:true` immediately and the 3rd stays pending; call `release()` on one of the first two; assert the 3rd then resolves `granted:true`.
  - Same setup, but let the 3rd request's `acquireTimeoutMs` elapse without any release; assert it resolves `granted:false, reason: "budget exhausted"`.
  - Simulate a crashed client (destroy the socket without calling `release()`) while holding a granted lease; assert the server's live count decrements anyway (via `connection.on("close")`) and a subsequent queued request is granted - this is the regression test for the "leak-proof by construction" claim in 6.1.1.
  - Approval-message behavior is unaffected: a `{type:"approval", ...}` message still round-trips exactly as `tests/gate.test.mjs`'s existing scenarios expect (updated for the new explicit `type` field).
- **Modified: `tests/gate.test.mjs`**
  - Update any fixtures/messages to include `type: "approval"` if the test constructs raw wire messages; otherwise unaffected, since `classify()` itself (the function under test) is untouched by this phase.
- **New: a depth-guard unit test** for `index.ts`'s generalized guard logic - the guard condition is extracted into a small exported `shouldRegisterSubagentTools(depth: number, maxDepth: number): boolean` pure function in `config.ts` specifically so it is unit-testable without spawning a process; assert both the shipped-default behavior (`shouldRegisterSubagentTools(0, 2) === true`, `shouldRegisterSubagentTools(1, 2) === true`, `shouldRegisterSubagentTools(2, 2) === false`) and the `maxDepth: 1` opt-out behavior (`shouldRegisterSubagentTools(0, 1) === true`, `shouldRegisterSubagentTools(1, 1) === false`).
- **New, committed: `tests/e2e-nested-spawn.test.mjs`**, opt-in via an environment variable (`PI_SUBAGENT_E2E=1`), skipped with a clear message otherwise so `npm test` stays fast by default: spawns a real root -> depth-1 -> depth-2 chain using the shipped default `maxDepth: 2`, with `model` explicitly pinned to `github-copilot/gpt-5.6-luna` at every level specifically to keep the real API cost of running this test negligible; asserts the depth-2 process actually ran (its own session file/meta.json exists with `parent`/`rootId` set correctly per 6.2) and that its output made it back through depth-1 into the root's own tool result. This is committed test work for this phase.
- **Windows kill-path**: a unit test covers the platform-selection *logic* (which branch - negative-pid signal vs. `taskkill` - is chosen for a given `process.platform`), since that is deterministic and cheap to test; the actual Windows process-tree termination behavior itself is not verified by this test suite, consistent with 6.1.1's "implemented but untested on Windows" decision.

#### 6.1.5 Edge cases and risks

- **Deadlock risk under the synchronous process model**: explicitly discussed in 6.1.1; mitigated by a bounded acquire timeout, not eliminated. A pathological configuration (`maxLiveChildren` smaller than the typical fan-out depth a user's own agents/skills produce) can cause frequent, user-visible "budget exhausted" errors; this is a tuning problem for the operator, surfaced clearly rather than hidden, and is the direct, intended tradeoff of choosing "fail with a clear message" over "risk a silent hang."
- **Platform coverage is honestly incomplete at ship time**: macOS is the verified target; Linux is expected to behave identically (same POSIX process-group semantics) but has not been separately exercised; Windows has an implemented `taskkill` fallback that is explicitly untested, per 6.1.1. Anyone shipping this on Windows or relying on it in CI on Windows should treat the abort-cascade guarantee as unverified until someone with that environment confirms it.
- **New always-on socket/coordinator increases the extension's attack/complexity surface**: a Unix domain socket with predictable-ish permissions (today's `approval-server.ts` creates it under `os.tmpdir()` with a fresh mkdtemp'd directory, which is a reasonable existing mitigation reused unchanged); no new secrets flow over it, but it is new local IPC that any local process could in principle attempt to connect to during the window it exists, same as today's approval socket already is. Unlike the original draft of this plan, this window of existence is now the common case (every top-level call, by default), not a narrow opt-in case, which is an accepted tradeoff of the `maxDepth: 2` default (6.1.1), but should be reviewed as part of implementation, not assumed benign by default.
- **Backward compatibility, stated honestly**: this feature is **not** inert by default. Any user who upgrades to this release, without touching `subagent.json`, gets: a coordinator socket created on every top-level `subagent` call; depth-1 subagents gaining the ability to spawn their own depth-2 subagents; and a tree-wide `maxLiveChildren: 4` budget enforced everywhere. The only way to restore the pre-existing exact behavior is to explicitly set `maxDepth: 1`. This must be called out prominently in this phase's release notes as a default-behavior change, distinct from (and larger than) the internal-only `PI_SUBAGENT_GATE_SOCKET` -> `PI_SUBAGENT_COORDINATOR_SOCKET` rename, which remains a non-breaking internal detail.

### 6.2 Feature 6: persisted agent graph (`parent`/`rootId` on `.meta.json`)

#### 6.2.1 Design decisions

**Decision: two new optional fields on the existing `.meta.json` schema, populated using the same env-var plumbing feature 5 already introduces.**
`SessionMeta` gains `parent?: string` (the session id of the subagent that spawned this one; absent for a depth-1 session, since its spawner is the human's own top-level pi session, not one of our own tracked subagent sessions) and `rootId?: string` (the top-most subagent session id in this delegation chain; for a depth-1 session this is its own id, making every new meta.json self-anchoring even at the root of its own subtree).
Both are purely additive and optional, so existing meta.json files (which lack them) continue to load unchanged through the existing `JSON.parse(...) as SessionMeta` call in `resolveSpec()`'s resume path - no migration needed, verified by a dedicated backward-compatibility test (6.2.3).
Alternative considered: a separate index file (for example `subagent-sessions/graph.json`) tracking the whole tree centrally.
Rejected for v1 as unnecessary extra state to keep consistent (a second source of truth that could drift from the individual meta.json files, especially under concurrent parallel spawns writing at the same time); per-file fields are simpler, and a tree can always be reconstructed on demand by scanning all meta.json files and grouping by `rootId`, if and when that is actually needed.

**Decision: populate via env vars already introduced for the depth budget, no new spawn-time plumbing beyond what 6.1 already adds.**
`writeSessionMeta()` (which runs in the *spawning* process, writing the *new child's* meta.json before/while spawning it) reads `process.env.PI_SUBAGENT_SESSION_ID` (this process's own id, if it is itself a subagent) as the new child's `parent`, and `process.env.PI_SUBAGENT_ROOT_ID` (propagated unchanged since feature 5 already threads it through every spawn) as the new child's `rootId`; if `PI_SUBAGENT_ROOT_ID` is unset (this process is the true root, not itself a subagent), the new child's `rootId` is its own `spec.sessionId` (it is the root of its own subtree).
No new environment variables are needed beyond the three already specified in 6.1.3 (`PI_SUBAGENT_DEPTH`, `PI_SUBAGENT_SESSION_ID`, `PI_SUBAGENT_ROOT_ID`); once 6.1's env-var plumbing exists, this is a few lines of additional field-population logic with no new IPC.

**Clarification: subagent sessions persist indefinitely by design; they are never cleared when a session ends.**
Subagent sessions (`~/.pi/agent/subagent-sessions/<id>.jsonl` + `.meta.json`) are not tied to the lifetime of the parent/human pi session that spawned them, and nothing in this codebase, before or after this plan, deletes them when that parent session ends.
They persist on disk indefinitely, exactly like ordinary pi sessions under `~/.pi/agent/sessions/` persist indefinitely, which is precisely what makes `resume` useful potentially much later (the README's own example resumes a reviewer agent after implementing its suggested fix, possibly in a later, unrelated main-agent session entirely).
`rootId`/`parent` do not change this; they only make the existing, already-permanent set of files groupable by delegation tree.
Retention/cleanup remains genuinely out of scope for this plan.
A future age-based or tree-based retention sweep (for example, "delete subagent sessions older than N days" or "delete an entire tree by `rootId` on request") becomes straightforward to build once `rootId` exists as a grouping key, and is noted here as a plausible, cheap future follow-up, but it is not committed work, is not scheduled as a phase 4, and would need its own design pass (in particular, retention deleting a session out from under a `resume` call that is about to reference it is a real correctness question a cleanup feature would need to answer, which this plan does not attempt to answer here).

**Decision: no new tool, no new command, in this plan.**
Per the stated constraint ("no new tools unless strongly justified"), this plan does not add a `/subagent-sessions` command or a tree-listing tool.
The `parent`/`rootId` fields are consumed in two small, already-justified ways: enriching the abort-recovery text (`formatAbortedRecovery()` can optionally mention "spawned by <parent agent>" when `parent` is present, giving a human debugging an aborted deep subagent a breadcrumb back up the tree) and as the join key for the widget's `+N nested` attribution in 6.1.

#### 6.2.2 File-by-file changes

- **Modified: `extensions/subagent/subagent-tool.ts`**
  - `SessionMeta` interface gains `parent?: string; rootId?: string;`.
  - `writeSessionMeta(spec, cwd)` populates both fields as described in 6.2.1.
  - `formatAbortedRecovery()`'s caller (in `formatAbortedResult()`) is extended to pass through `parent`/`rootId` when available (read from the same meta.json already implicitly associated with `spec`/`result`, or threaded through `SingleResult` as new optional fields `parent?: string; rootId?: string` populated at the same point `sessionId`/`model` already are, i.e. from `spec`).
  - `AgentSpec` gains `parent?: string; rootId?: string` so this information flows from `writeSessionMeta`'s computation into `SingleResult` without re-reading the meta.json file back.
- **Modified: `extensions/subagent/abort-output.ts`**
  - `formatAbortedRecovery()` gains an optional `parent?: string` parameter; when present, adds a line such as `Parent agent: <parent session id>` to the output, purely additive to the existing format.

#### 6.2.3 Tests

- **New assertions in `tests/subagent-tool`-level testing (or a new small `tests/session-graph.test.mjs` if `writeSessionMeta`/`SessionMeta` logic is factored out enough to unit test in isolation)**:
  - A depth-1 spawn (no `PI_SUBAGENT_ROOT_ID`/`PI_SUBAGENT_SESSION_ID` in the environment) produces a meta.json with `rootId === its own sessionId` and no `parent` field.
  - A depth-2 spawn (simulated by setting `PI_SUBAGENT_SESSION_ID`/`PI_SUBAGENT_ROOT_ID` in the test's environment before calling the meta-writing logic) produces a meta.json with `parent === the simulated PI_SUBAGENT_SESSION_ID` and `rootId === the simulated PI_SUBAGENT_ROOT_ID`.
  - **Backward compatibility**: parsing a hand-written, old-shape meta.json (missing `parent`/`rootId` entirely) through the existing `resolveSpec()` resume path succeeds and produces a spec with `parent: undefined, rootId: undefined`, i.e. no throw, no default-substitution that would misrepresent an old session as having a synthetic root.
- **Modified: `tests/abort-output.test.mjs`**
  - Add a case asserting `formatAbortedRecovery(..., { parent: "abcd1234" })` includes a `Parent agent: abcd1234` line, and that omitting `parent` produces byte-identical output to today (no regression for the depth-1, no-parent case).

#### 6.2.4 Edge cases and risks

- Very low risk in isolation; the only real risk is coupling to feature 5's env-var plumbing being correct (if `PI_SUBAGENT_SESSION_ID`/`PI_SUBAGENT_ROOT_ID` are ever set incorrectly by 6.1's spawn code, this feature will silently persist a wrong tree shape); recommend implementing and testing 6.1's env propagation first, then 6.2 as a thin layer on top, in that literal order within phase 3, even though they ship in the same release.
- As clarified in 6.2.1, meta.json files are never cleaned up automatically, by design; `rootId` makes a future cleanup-by-tree feature straightforward to build later, but this plan does not implement retention/cleanup.

## 7. Cross-cutting testing and rollout strategy

- **Test harness consistency**: all new test files follow the existing convention exactly - `node:test`, `.test.mjs` extension, importing `.ts` sources directly (`node --experimental-strip-types --test tests/*.test.mjs`, per `package.json`'s `test` script), no build step, no new test framework.
- **Config-file tests need a way to point `getAgentDir()` at a temp directory.** `getAgentDir()` (from `@earendil-works/pi-coding-agent`) presumably resolves `~/.pi/agent` or `PI_CODING_AGENT_DIR` (per `docs/environment-variables.md`, `PI_CODING_AGENT_DIR` overrides the config directory).
  New tests for `config.ts` (phase 1) and the meta.json graph fields (phase 3) should set `process.env.PI_CODING_AGENT_DIR` to a per-test temp directory (created with `fs.mkdtempSync`) before importing/calling the module under test, and restore/clean up afterward, to avoid ever touching a developer's real `~/.pi/agent` during `npm test`. This pattern does not exist yet in the current test suite (all four existing test files test pure functions with no filesystem/config dependency) and should be introduced carefully and consistently across all new tests that need it, ideally via one small shared test helper (for example `tests/helpers/temp-agent-dir.mjs`) rather than duplicated boilerplate per file.
- **Real-process tests stay isolated and cheap.** No test should spawn a real `pi` child process by default, to keep `npm test` fast and hermetic; the one exception (6.1.4's end-to-end nested-spawn test) is opt-in via `PI_SUBAGENT_E2E=1` and pins every level of the spawned tree to `github-copilot/gpt-5.6-luna` specifically to keep its real cost negligible when it does run.
- **Rollout**: each phase lands as its own PR/release (matching the "~3 releases" framing), with the README updated in the same PR as the feature (already reflected in the file-by-file lists above). Two releases in particular need a prominent, clearly-labeled behavior-change note rather than a routine changelog entry: Phase 1's removal of `quick_task` (a breaking removal, 4.2), and Phase 3's default `maxDepth: 2` (an active-by-default trust-boundary and IPC change, 6.1.1/6.1.5). `docs/codex-subagent-comparison.md` is a natural candidate to revisit once phase 3 ships, since several of its "Learnings worth stealing" bullets will have been implemented, though updating it is not part of this plan's deliverable.
- **Versioning**: `package.json`'s version (`0.2.0`) should bump per phase (e.g. `0.3.0`, `0.4.0`, `0.5.0`) rather than all at once at the end, so users can adopt incrementally and so a regression in phase 3 does not block phases 1-2 from being usable.

## 8. Decisions log

Every open question raised while drafting this plan has been decided; each decision below is already folded into the section referenced.

1. **Result cap default**: ships on by default at ~1000 approx tokens, Codex-style, with no phased opt-in release. See 5.2.1.
2. **Fork size warning**: included in Phase 2 v1, with fixed small/large calibration reference points (`~2k` / `~8k`) in the warning text itself. See 5.1.1, 5.1.10.
3. **Sanitizer and `CustomMessage`**: drops all `custom`/`custom_message` entries unconditionally; no `display: true` special case. Integrations such as pi-atlassian-mcp can be revisited later against a concrete need. See 5.1.1, 5.1.10.
4. **Fork source scope**: `forkContext` only ever forks from the calling (orchestrating) agent, matching Codex's `fork_turns` semantics exactly; chain-step-to-chain-step forking is permanently out of scope, not deferred. See 5.1.1.
5. **`maxDepth` default**: ships as `2`, not `1`; children get the `subagent` tool, one level of grandchildren is allowed, and the tree-wide `maxLiveChildren: 4` budget is enforced by default. `maxDepth: 1` remains available to restore the old hard ban. The consequences (coordinator active by default, depth-1 subagents can delegate further) are accepted and documented plainly, not glossed over. See 6.1.1, 6.1.5.
6. **`quick_task` removal**: the tool is deleted entirely (not deprecated) in Phase 1, as an explicit breaking change, to keep exactly one delegation primitive. See 4.2.
7. **Widget scope**: ships the simple "+N nested" fallback only in this plan; full per-agent recursive live rendering is a deferred fast-follow, not built now. See 6.1.1.
8. **Platform support for the abort-cascade fix**: verified on macOS; a Windows `taskkill` fallback is implemented but explicitly documented as untested, since no Windows environment was available during development. See 6.1.1, 6.1.5.
9. **End-to-end nested-spawn test**: added, opt-in via `PI_SUBAGENT_E2E=1`, pinned to `github-copilot/gpt-5.6-luna` at every level to keep its real cost negligible. See 6.1.4.
10. **Session cleanup**: stays out of scope. Subagent sessions persist indefinitely by design, independent of the parent session's lifetime; that persistence is what makes `resume` work. An age/tree-based retention sweep is noted as a possible future follow-up once `rootId` exists, not committed work. See 6.2.1.
11. **`resultCapTokens` per-item override**: added, as a three-tier setting - per-item (`TaskItem`/`ChainItem`) beats per-call (top-level params) beats the `subagent.json` default beats the built-in `1000`; `0` at any level disables the cap at that level. This supports capping some agents in a parallel batch while leaving others uncapped. See 5.2.1, 5.2.2.
12. **Recovering from a capped result**: the truncation notice points at the child's session file path first (readable directly with the calling model's own `read` tool, no extra turn needed) and `resume` second (to continue the conversation, not merely see more of it). The cap never disrupts, truncates, or deletes the child's own run, which always completes fully regardless of what is returned to the parent. See 5.2.1.
