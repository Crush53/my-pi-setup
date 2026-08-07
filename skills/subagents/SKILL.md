---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. When the parent runs inside Herdr, each child is a real interactive agent in a separate full-size tab for live auditing without resizing the parent Pi terminal. Use `subagent_send` or `/subagents` for managed follow-up; input typed directly into a settled child terminal is not collected by Pi. Outside Herdr, children use headless backends. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Harness Skills

When a user asks any child harness to use a named skill or workflow, inspect that harness's installed `SKILL.md` first and use its documented invocation syntax. Do not assume skill names or invocation conventions transfer between Pi, Claude Code, and Codex.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Best default:** Use when the user does not request another harness. It inherits the parent model and thinking level when `model` or `reasoning_effort` is omitted. Inside Herdr it launches an interactive Pi pane; otherwise it uses an in-process Pi session.

Do not use models from the Anthropic provider even if one appears in the model list.

Pi can use any model shown by `pi --list-models`. Prefer `provider/model-id`; a bare model id only works when unambiguous. Common picks in this environment:

| Model                            | Recommended effort |
| -------------------------------- | ------------------ |
| inherited parent model (default) | inherited          |
| `openai-codex/gpt-5.6-sol`       | `high`             |
| `openai-codex/gpt-5.6-terra`     | `high`             |
| `opencode/claude-fable-5`        | `medium`           |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Claude Code Harness

**Harness:** `claude`
**Prompt nicknames:** “claude”, “Claude Code”, “claude agent”, “claude subagent”, "cc"
**Best default:** use the latest fable model on high reasoning. Do not default to anything else, if the user does not specify, use fable.

| Model hint | Model               | Recommended effort |
| ---------- | ------------------- | ------------------ |
| `fable`    | latest Claude Fable | `high`             |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The extension maps these to Claude thinking-token budgets: 0, 1,024, 4,096, 10,000, 16,000, 32,000, and 63,999 tokens respectively.

For planning work, pass `mode: "plan"` to `subagent_spawn`. This starts Claude in native read-only plan mode. Keep revisions in the same session with `subagent_send`; do not spawn a replacement planner after the first draft.

Requires Claude Code to be installed and authenticated.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Best default:** `gpt-5.6-sol` with `high` effort for coding work. Do not use anything other than sol unless the user specifically asks for it.

| Model           | Recommended effort |
| --------------- | ------------------ |
| `gpt-5.6-sol`   | `high`             |
| `gpt-5.6-terra` | `high`             |
| `gpt-5.6-luna`  | `high`             |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model. In the native Herdr CLI, `off` maps to `none`, `minimal` maps to `low`, and `max` maps to the highest broadly supported effort.

Requires the Codex CLI to be installed and authenticated.

## Code Reviews

Use each harness's native review skill with its documented invocation syntax:

- **Claude Code:** explicitly ask Claude to use `/review`; Claude resolves this to `Skill(review)`. If that skill redirects working-branch reviews to `/code-review`, follow the redirect.
- **Codex:** start the task prompt with `$review-agent`. This invokes `~/.codex/skills/.system/review-agent/SKILL.md`. Do not use `/review` as a Codex skill invocation; `/review` is an interactive TUI command, not the installed review skill.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, and optional `working_dir`, `model`, `reasoning_effort`, and `mode`. At most four subagents run concurrently. Inside Herdr, the spawn result includes the child tab and pane IDs so the user can audit the native agent UI without shrinking the parent.

- `subagent_send({ id, message })`: steer a running child or continue a settled child in the same session. Use it for plan revisions and follow-up work rather than spawning a replacement.
- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting. If a child fails on a transient WebSocket/provider-overload error, keep its terminal and use `subagent_send` after a backoff to ask it to inspect current state and continue safely. Do not blindly replay a side-effecting prompt or spawn a replacement session.

## Interactive Questions and Planning

A native child can enter Herdr's `blocked` state for permission prompts, planning questions, or numbered/custom-choice dialogs. `blocked` is not completion.

1. Keep the manager entry and Herdr pane open.
2. Read the latest pane snapshot to capture the exact question and options.
3. The parent agent should answer routine non-permission questions autonomously from the task, repository, and conversation context. Do not bounce routine planning or implementation decisions back to the user merely because a child asked them.
4. Never approve a permission or project-trust prompt for a Pi child launched from an untrusted project. Leave it blocked or cancel it, and ask the user to establish trust explicitly. Otherwise ask the user only when the answer requires genuinely user-only information: a personal preference, missing requirement, credential, or authorization for a destructive or irreversible action.
5. Relay menu navigation with paced `herdr pane send-keys` calls: send one navigation key per command, pause briefly, read the pane to verify the selector reached the intended option, and only then send Enter. Batched navigation plus Enter can accept the default before the TUI renders movement. Relay a custom answer with `herdr pane send-text <pane-id> <text>` followed by `herdr pane send-keys <pane-id> enter`.
6. Wait for the child to return to `working`, and repeat if it becomes `blocked` with another question.
7. Cancel only when explicitly requested or when the child cannot make progress.

Do not guess option numbers or close a pane merely because it is waiting for input. Multi-step Claude planning sessions commonly require several blocked/working cycles.

For planning tasks, launch Claude with `mode: "plan"` and use the child as an iterative collaborator rather than accepting its first draft. Answer its questions, challenge unclear assumptions, ask it to compare alternatives, and request revisions with `subagent_send` on the same id until the plan is coherent, complete, and implementation-ready. Only then accept the result and close the tab.

## Terminal Lifecycle

A settled result is not automatically disposable. If a child is blocked, asks a question, or needs follow-up, keep its Herdr tab open and respond through `subagent_send` or the managed `/subagents` controls. Once the result is captured, fully complete, and no follow-up is needed, close its full-size Herdr tab with `herdr tab close <tab-id>` (or close its sole pane). Do not leave completed audit tabs open indefinitely.
