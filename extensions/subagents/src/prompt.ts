/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent with its own context window and the selected harness's normal host permissions. When the parent runs inside Herdr, this starts a real interactive Pi, Claude Code, or Codex process in a separate full-size tab for live auditing; direct post-settlement terminal input is unmanaged. Outside Herdr it uses the original headless backend. Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you when it settles, or collect it with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max 4 subagents can run concurrently.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on Pi, Claude Code, or Codex; inside Herdr each child gets a visible full-size tab";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Pick the subagent harness deliberately: pi unless you have a reason to prefer Claude Code or Codex (e.g. the user asked for one, or the task suits that harness).",
  "When delegating any named skill or workflow, inspect that harness's installed SKILL.md and use its documented invocation syntax; do not assume conventions transfer between Pi, Claude Code, and Codex.",
  "For native code-review skills, ask Claude Code to use /review, but start a Codex review prompt with $review-agent; Codex /review is an interactive TUI command, not its installed review skill.",
  "When running inside Herdr, subagent_spawn creates a separate full-size tab for auditing without resizing the parent Pi terminal. Input typed directly into a settled child terminal is outside Pi's manager and is not collected or delivered; use subagent_send or the managed /subagents controls for follow-up turns.",
  "Continue an existing subagent with subagent_send instead of spawning a replacement when the user revises a completed plan, requests follow-up work, or asks to retry after a transient provider/WebSocket overload. Preserve the same transcript and pane. Do not blindly replay side-effecting work after an ambiguous transport failure; tell the child to inspect current state and continue safely.",
  "When delegating planning to Claude, set mode to plan so Fable starts in native read-only plan mode. Iterate on that same agent with subagent_send until the plan is accepted; do not spawn a replacement planner for revisions.",
  "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
  "When a Herdr child is blocked on a routine non-permission TUI question, inspect its pane and answer autonomously from the task context using herdr pane send-keys/send-text; ask the user only for genuinely user-only preferences, missing requirements, credentials, or destructive authorization. Never approve a permission or project-trust prompt for a Pi child launched from an untrusted project; leave it blocked or cancel it and ask the user to establish trust explicitly.",
  "For planning delegations, iterate with the child: answer questions, challenge assumptions, compare alternatives, and request revisions until the plan is implementation-ready rather than accepting the first draft.",
  "When a Herdr child settles, keep its tab open if it is blocked, asking a question, or needs follow-up. Once its result is captured and no follow-up is needed, close the full-size tab with herdr tab close <tab-id> (or close its sole pane); do not leave completed audit terminals open indefinitely.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness:
    'Harness to run the subagent on: "pi", "claude" (Claude Code), or "codex" (Codex CLI). Inside Herdr this starts the real interactive CLI in a separate full-size tab; otherwise it uses the headless backend.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Model hint, interpreted by the chosen harness (pi: "provider/model-id" or model id; claude: model alias like "sonnet"/"opus"; codex: model slug). Omit for the harness default (pi inherits the current model).',
  reasoningEffort:
    "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget). Omit for the harness default (pi inherits the current level).",
  mode: 'Execution mode. Use "plan" for Claude planning agents so Claude starts in native read-only plan mode. "plan" is currently supported only by the Claude harness.',
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
  herdrTabId?: string;
  herdrPaneId?: string;
}) {
  const terminal = options.herdrPaneId
    ? `, Herdr tab ${options.herdrTabId ?? "?"} pane ${options.herdrPaneId}`
    : "";
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}${terminal}).\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_send to continue it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes managed steering and follow-up turns on an existing session. */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send a follow-up message to an existing subagent. This steers a running agent or starts another turn in the same settled native session, preserving its transcript and Herdr terminal. Use this for plan revisions, follow-up work, and safe recovery after transient provider errors instead of spawning a replacement.";

export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: "Existing subagent id",
  message:
    "Follow-up instruction. After an ambiguous provider failure, ask the agent to inspect current state and continue safely rather than blindly replaying side effects.",
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
