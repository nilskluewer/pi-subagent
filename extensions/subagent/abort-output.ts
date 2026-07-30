const ABORT_CONTEXT_ITEM_COUNT = 10;
const ABORT_ITEM_MAX_CHARS = 2000;

export interface AbortActivityItem {
  kind: "Message" | "Tool call";
  content: string;
}

function truncateItem(text: string): string {
  if (text.length <= ABORT_ITEM_MAX_CHARS) return text;
  return `${text.slice(0, ABORT_ITEM_MAX_CHARS)}\n… (truncated)`;
}

export function formatAbortedRecovery(
  agent: string,
  sessionId: string | undefined,
  activity: AbortActivityItem[],
  options: { parent?: string } = {},
): string {
  const recentItems = activity.slice(-ABORT_CONTEXT_ITEM_COUNT);
  const recentActivity = recentItems.length > 0
    ? recentItems
        .map((item, index) => `${index + 1}. ${item.kind}: ${truncateItem(item.content)}`)
        .join("\n\n")
    : "(no completed assistant messages or tool calls were captured)";
  const session = sessionId ?? "unavailable";
  const resume = sessionId
    ? `Resume with: {"resume":"${sessionId}","task":"Inspect the current repository state, summarize what was completed before the interruption, and continue the task."}`
    : "This task cannot be resumed because no session id was captured.";

  const lines = [
    "Subagent aborted before completion.",
    `Agent: ${agent}`,
    "Stop reason: aborted",
    `Session: ${session}`,
  ];
  if (options.parent) lines.push(`Parent agent: ${options.parent}`);
  lines.push(
    `Recent activity (last ${recentItems.length} completed messages/tool calls):`,
    recentActivity,
    resume,
  );
  return lines.join("\n\n");
}
