import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import { resolvePiModel } from "./pi.ts";
import type {
  BackendName,
  ReasoningEffort,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";

const COMMAND_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const LIVE_READ_INTERVAL_MS = 500;
const INTERRUPT_TIMEOUT_MS = 5_000;
const FINAL_OUTPUT_MAX_LENGTH = 1024 * 1024;
const CHILD_EXCLUDED_TOOLS = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
].join(",");

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function commandError(
  args: ReadonlyArray<string>,
  code: number | null,
  stderr: string,
) {
  const detail = stderr.trim();
  return new Error(
    `herdr ${args.join(" ")} failed (${code === null ? "terminated" : `code ${code}`})${detail ? `: ${detail}` : ""}`,
  );
}

function runHerdr(
  args: ReadonlyArray<string>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn("herdr", [...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const terminate = (error: Error) => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already have exited.
        }
      }, 500);
      killTimer.unref();
      finish(() => reject(error));
    };
    const onAbort = () => terminate(new Error("Herdr command aborted."));

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeoutMs !== undefined && !settled) {
      timer = setTimeout(
        () =>
          terminate(
            new Error(
              `Herdr command timed out after ${options.timeoutMs} ms: herdr ${args.join(" ")}`,
            ),
          ),
        options.timeoutMs,
      );
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-COMMAND_OUTPUT_MAX_BYTES);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-COMMAND_OUTPUT_MAX_BYTES);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      finish(() => {
        if (options.signal?.aborted) {
          reject(new Error("Herdr command aborted."));
        } else if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(commandError(args, code, stderr));
        }
      });
    });
  });
}

function parseJsonOutput(output: string) {
  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (line) return JSON.parse(line) as JsonRecord;
  }
  throw new Error("Herdr returned no JSON response.");
}

function nestedString(value: unknown, ...keys: string[]) {
  let current: unknown = value;
  for (const key of keys) current = record(current)?.[key];
  return stringValue(current);
}

function herdrAvailable() {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

function chooseDirection(layout: JsonRecord) {
  const panes = record(record(layout.result)?.layout)?.panes;
  const currentId = process.env.HERDR_PANE_ID;
  if (Array.isArray(panes)) {
    const current = panes
      .map(record)
      .find((pane) => pane?.pane_id === currentId);
    const rect = record(current?.rect);
    const width = typeof rect?.width === "number" ? rect.width : undefined;
    const height = typeof rect?.height === "number" ? rect.height : undefined;
    if (width !== undefined && height !== undefined) {
      return width >= 100 && width >= height * 1.6 ? "right" : "down";
    }
  }
  return "right";
}

function normalizedEffortForClaude(effort: ReasoningEffort | undefined) {
  if (effort === "off" || effort === "minimal") return "low";
  return effort;
}

function normalizedEffortForCodex(effort: ReasoningEffort | undefined) {
  if (effort === "off") return "none";
  if (effort === "minimal") return "low";
  return effort;
}

function modelLabel(
  kind: BackendName,
  task: SpawnTask,
  resolvedPiModel: string | undefined,
) {
  if (kind === "pi") return resolvedPiModel ?? "default";
  return task.model ?? "default";
}

export function agentArguments(
  kind: BackendName,
  task: SpawnTask,
  resolvedPiModel: string | undefined,
) {
  if (kind === "pi") {
    const args = [
      "--name",
      `subagent: ${task.title}`,
      "--exclude-tools",
      CHILD_EXCLUDED_TOOLS,
      task.parent.projectTrusted ? "--approve" : "--no-approve",
    ];
    const thinking = task.reasoningEffort ?? task.parent.inheritedThinkingLevel;
    if (resolvedPiModel) args.push("--model", resolvedPiModel);
    if (thinking) args.push("--thinking", thinking);
    return args;
  }

  if (kind === "claude") {
    const args = [
      "--name",
      `subagent: ${task.title}`,
      "--dangerously-skip-permissions",
      "--disallowed-tools",
      "Agent,Task",
    ];
    if (!task.parent.projectTrusted) args.push("--setting-sources", "user");
    if (task.model) args.push("--model", task.model);
    const effort = normalizedEffortForClaude(task.reasoningEffort);
    if (effort) args.push("--effort", effort);
    return args;
  }

  const args = [
    "--dangerously-bypass-approvals-and-sandbox",
    "--disable",
    "multi_agent",
  ];
  if (task.parent.projectTrusted) args.push("--dangerously-bypass-hook-trust");
  if (task.model) args.push("--model", task.model);
  const effort = normalizedEffortForCodex(task.reasoningEffort);
  if (effort) args.push("--config", `model_reasoning_effort=\"${effort}\"`);
  return args;
}

function agentSession(agent: JsonRecord | undefined) {
  const session = record(agent?.agent_session);
  const kind = stringValue(session?.kind);
  const value = stringValue(session?.value);
  return kind && value ? { kind, value } : undefined;
}

function claudeSessionPath(cwd: string, sessionId: string) {
  const projectDirectory = cwd.replace(/[/.]/g, "-");
  return path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects",
    projectDirectory,
    `${sessionId}.jsonl`,
  );
}

function findFileContaining(root: string, needle: string) {
  if (!fs.existsSync(root)) return undefined;
  const pending = [root];
  let visited = 0;
  while (pending.length > 0 && visited < 20_000) {
    const directory = pending.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (
        entry.isFile() &&
        entry.name.includes(needle) &&
        entry.name.endsWith(".jsonl")
      ) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveSessionPath(
  kind: BackendName,
  task: SpawnTask,
  session: { kind: string; value: string } | undefined,
) {
  if (!session) return undefined;
  if (session.kind === "path") return session.value;
  if (kind === "claude") return claudeSessionPath(task.cwd, session.value);
  if (kind === "codex") {
    const codexHome =
      process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    return findFileContaining(path.join(codexHome, "sessions"), session.value);
  }
  return undefined;
}

function textParts(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const item = record(part);
      const type = stringValue(item?.type);
      const text = stringValue(item?.text);
      return text &&
        (type === "text" || type === "output_text" || type === "input_text")
        ? [text]
        : [];
    })
    .join("\n")
    .trim();
}

function userText(entry: JsonRecord) {
  const message = record(entry.message);
  if (message?.role === "user") {
    const text = textParts(message.content);
    if (text) return text;
  }

  const payload = record(entry.payload);
  if (entry.type === "response_item" && payload?.role === "user") {
    const text = textParts(payload.content);
    if (text) return text;
  }
  if (entry.type === "event_msg" && payload?.type === "user_message") {
    const text = stringValue(payload.message);
    if (text?.trim()) return text.trim();
  }
  return undefined;
}

function assistantText(entry: JsonRecord) {
  const message = record(entry.message);
  if (message?.role === "assistant") {
    const text = textParts(message.content);
    if (text) return text;
  }

  const payload = record(entry.payload);
  if (entry.type === "response_item" && payload?.role === "assistant") {
    const text = textParts(payload.content);
    if (text) return text;
  }
  if (entry.type === "event_msg" && payload?.type === "agent_message") {
    const text = stringValue(payload.message);
    if (text?.trim()) return text.trim();
  }
  if (entry.type === "result") {
    const text = stringValue(entry.result);
    if (text?.trim()) return text.trim();
  }
  return undefined;
}

export function sessionRun(
  sessionFilePath: string | undefined,
  prompt: string,
): { promptSeen: boolean; finalText?: string } {
  if (!sessionFilePath || !fs.existsSync(sessionFilePath)) {
    return { promptSeen: false };
  }
  let contents: string;
  try {
    contents = fs.readFileSync(sessionFilePath, "utf8");
  } catch {
    return { promptSeen: false };
  }

  let promptSeen = false;
  let finalText: string | undefined;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as JsonRecord;
      const user = userText(entry);
      if (user?.trim() === prompt.trim()) {
        promptSeen = true;
        finalText = undefined;
        continue;
      }
      if (!promptSeen) continue;
      const assistant = assistantText(entry);
      if (assistant) finalText = assistant.slice(0, FINAL_OUTPUT_MAX_LENGTH);
    } catch {
      // Ignore malformed or partially flushed trailing records.
    }
  }
  return { promptSeen, finalText };
}

function makeHerdrSession(kind: BackendName, task: SpawnTask) {
  return Effect.gen(function* () {
    if (!herdrAvailable()) {
      return yield* new SpawnError({
        message:
          "Herdr subagents require the parent Pi session to run inside a Herdr pane.",
      });
    }
    if (!task.parent.projectTrusted && kind !== "pi") {
      return yield* new SpawnError({
        message: `Interactive ${kind} subagents require a trusted working directory.`,
      });
    }

    let resolvedPiModel: string | undefined;
    if (kind === "pi") {
      const registry = task.parent.modelRegistry;
      if (!registry) {
        return yield* new SpawnError({
          message: "pi backend requires the parent session's model registry.",
        });
      }
      const resolved = yield* Effect.try({
        try: () =>
          resolvePiModel(registry, task.model, task.parent.inheritedModel),
        catch: (error) => new SpawnError({ message: boundedError(error) }),
      });
      resolvedPiModel = resolved
        ? `${resolved.provider}/${resolved.id}`
        : undefined;
    }

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);
    const agentName = `pi_${kind}_${randomBytes(4).toString("hex")}`.slice(
      0,
      32,
    );
    let paneId: string | undefined;
    let runController: AbortController | undefined;
    let liveTimer: ReturnType<typeof setInterval> | undefined;
    let liveReadPending = false;

    const state = {
      closed: false,
      activeRun: false,
      runSerial: 0,
      activePrompt: task.prompt,
      meta: {
        backend: kind,
        modelLabel: modelLabel(kind, task, resolvedPiModel),
        herdrAgentName: agentName,
      } satisfies SubagentMeta as SubagentMeta,
    };

    const layout = yield* Effect.tryPromise({
      try: () => runHerdr(["pane", "layout", "--current"]),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    const direction = chooseDirection(parseJsonOutput(layout.stdout));
    paneId = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const split = await runHerdr([
            "pane",
            "split",
            "--current",
            "--direction",
            direction,
            "--cwd",
            task.cwd,
            "--no-focus",
          ]);
          const acquiredPaneId = nestedString(
            parseJsonOutput(split.stdout),
            "result",
            "pane",
            "pane_id",
          );
          if (!acquiredPaneId) {
            throw new Error("Herdr pane split returned no pane id.");
          }
          return acquiredPaneId;
        },
        catch: (error) => new SpawnError({ message: boundedError(error) }),
      }),
      (acquiredPaneId) =>
        Effect.promise(() =>
          runHerdr(["pane", "close", acquiredPaneId], {
            timeoutMs: 3_000,
          }).then(
            () => undefined,
            () => undefined,
          ),
        ),
    );
    state.meta = { ...state.meta, herdrPaneId: paneId };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.closed = true;
        runController?.abort();
        if (liveTimer) clearInterval(liveTimer);
        liveTimer = undefined;
        Queue.endUnsafe(events);
      }),
    );

    yield* Effect.tryPromise({
      try: async () => {
        await runHerdr(["pane", "rename", paneId!, `${kind}: ${task.title}`]);
        const startArgs = [
          "agent",
          "start",
          agentName,
          "--kind",
          kind,
          "--pane",
          paneId!,
          "--timeout",
          "120000",
          "--",
          ...agentArguments(kind, task, resolvedPiModel),
        ];
        for (let attempt = 0; ; attempt++) {
          try {
            await runHerdr(startArgs);
            break;
          } catch (error) {
            if (
              attempt >= 20 ||
              !boundedError(error).includes("agent_pane_busy")
            ) {
              throw error;
            }
            await delay(100);
          }
        }

        if (kind === "claude") {
          for (let attempt = 0; attempt < 30; attempt++) {
            const screen = await runHerdr([
              "pane",
              "read",
              paneId!,
              "--source",
              "visible",
            ]).then((result) => result.stdout);
            if (
              screen.includes("Bypass Permissions mode") &&
              screen.includes("Yes, I accept")
            ) {
              await runHerdr(["pane", "send-keys", paneId!, "down", "enter"]);
              await runHerdr([
                "agent",
                "wait",
                agentName,
                "--until",
                "idle",
                "--until",
                "done",
                "--timeout",
                "30000",
              ]);
              break;
            }
            await delay(100);
          }
        }

        // agent.start can return while a native TUI is still completing
        // startup work (notably Codex MCP initialization). Prompts sent during
        // that window can be swallowed while startup state changes falsely
        // satisfy agent prompt --wait.
        await delay(kind === "pi" ? 1_000 : 5_000);
      },
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const refreshMeta = async () => {
      try {
        const response = await runHerdr(["agent", "get", agentName], {
          timeoutMs: 3_000,
        });
        const agent = record(
          record(parseJsonOutput(response.stdout).result)?.agent,
        );
        const session = agentSession(agent);
        const sessionFilePath = resolveSessionPath(kind, task, session);
        const patch: Partial<SubagentMeta> = {
          nativeSessionId: session?.kind === "id" ? session.value : undefined,
          sessionFilePath,
        };
        state.meta = { ...state.meta, ...patch };
        emit({ _tag: "MetaChanged", meta: patch });
      } catch {
        // Session identity is best-effort; terminal output remains the fallback.
      }
    };

    const readTerminal = async (
      source: "visible" | "recent-unwrapped",
      lines?: number,
    ) => {
      if (!paneId) return undefined;
      // Address the pane rather than the agent alias so output remains readable
      // after a CLI exits and Herdr clears the live agent name.
      const args = ["pane", "read", paneId, "--source", source];
      if (lines !== undefined) args.push("--lines", String(lines));
      const result = await runHerdr(args, { timeoutMs: 3_000 });
      return result.stdout.trim();
    };

    const stopLiveReads = () => {
      if (liveTimer) clearInterval(liveTimer);
      liveTimer = undefined;
      liveReadPending = false;
    };

    const startLiveReads = () => {
      stopLiveReads();
      liveTimer = setInterval(() => {
        if (state.closed || !state.activeRun || liveReadPending) return;
        liveReadPending = true;
        void readTerminal("visible")
          .then((text) => {
            if (text && state.activeRun) emit({ _tag: "LiveSnapshot", text });
          })
          .catch(() => undefined)
          .finally(() => {
            liveReadPending = false;
          });
      }, LIVE_READ_INTERVAL_MS);
    };

    const observedPrompt = async (prompt: string) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        await refreshMeta();
        if (sessionRun(state.meta.sessionFilePath, prompt).promptSeen)
          return true;
        const terminal = await readTerminal("recent-unwrapped", 300).catch(
          () => undefined,
        );
        if (terminal?.includes(prompt)) return true;
        await delay(100);
      }
      return false;
    };

    const collectFinalText = async (prompt: string) => {
      await refreshMeta();
      for (let attempt = 0; attempt < 12; attempt++) {
        const run = sessionRun(state.meta.sessionFilePath, prompt);
        if (run.finalText) return run.finalText;
        await delay(100);
        await refreshMeta();
      }
      return (
        (await readTerminal("recent-unwrapped", 200).catch(() => undefined)) ??
        ""
      );
    };

    const settle = (serial: number, outcome: RunOutcome) => {
      if (state.closed || !state.activeRun || serial !== state.runSerial)
        return;
      state.activeRun = false;
      runController = undefined;
      stopLiveReads();
      emit({ _tag: "QueueChanged", queued: [] });
      emit({ _tag: "RunSettled", outcome });
    };

    const waitForRun = async (
      serial: number,
      prompt: string,
      controller: AbortController,
    ) => {
      try {
        const submitPrompt = () =>
          runHerdr(["agent", "prompt", agentName, prompt], {
            signal: controller.signal,
          });
        const waitUntilSettled = () =>
          runHerdr(
            [
              "agent",
              "wait",
              agentName,
              "--until",
              "idle",
              "--until",
              "done",
              "--until",
              "blocked",
            ],
            { signal: controller.signal },
          );
        const acceptClaudeWarning = async () => {
          if (kind !== "claude") return false;
          const screen = await readTerminal("visible").catch(() => undefined);
          if (
            !screen?.includes("Bypass Permissions mode") ||
            !screen.includes("Yes, I accept")
          ) {
            return false;
          }
          await runHerdr(["pane", "send-keys", paneId!, "down", "enter"]);
          await delay(500);
          return true;
        };

        try {
          await submitPrompt();
        } catch (error) {
          const warningAccepted = await acceptClaudeWarning();
          const promptStalled = boundedError(error).includes(
            "agent_prompt_stalled",
          );
          if (!warningAccepted && !promptStalled) throw error;

          if (warningAccepted) {
            await delay(2_000);
            await submitPrompt();
          } else if (kind === "claude" && paneId) {
            // Claude renders long/bracketed-paste input as `[Pasted text #N]`.
            // Herdr can paste it successfully but fail to submit the final
            // Enter, reporting agent_prompt_stalled while the text is waiting.
            await runHerdr(["pane", "send-keys", paneId, "enter"]);
          } else {
            await delay(2_000);
            await submitPrompt();
          }
        }
        if (await acceptClaudeWarning()) await submitPrompt();

        if (!(await observedPrompt(prompt))) {
          // A still-initializing TUI can consume the submitted bytes without
          // creating a user turn. Give startup one more grace period and retry
          // once, then fail instead of returning the startup screen as success.
          await delay(2_000);
          await submitPrompt();
          if (!(await observedPrompt(prompt))) {
            throw new Error(
              "Herdr submitted the prompt, but the native agent did not record it.",
            );
          }
        }

        // `agent wait --until idle` can otherwise match the pre-run idle state
        // before Herdr notices the native TUI has started. First observe either
        // a busy state or an assistant response in the correlated transcript.
        let completedBeforeWait = false;
        let workStarted = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          await refreshMeta();
          if (sessionRun(state.meta.sessionFilePath, prompt).finalText) {
            completedBeforeWait = true;
            break;
          }
          const current = await runHerdr(["agent", "get", agentName], {
            timeoutMs: 3_000,
          });
          const currentStatus = nestedString(
            parseJsonOutput(current.stdout),
            "result",
            "agent",
            "agent_status",
          );
          if (currentStatus === "working" || currentStatus === "blocked") {
            workStarted = true;
            break;
          }
          await delay(100);
        }
        if (!completedBeforeWait && !workStarted) {
          throw new Error(
            "Herdr recorded the prompt, but never observed the native agent start work.",
          );
        }

        // Do not use `agent prompt --wait`: Herdr applies a finite command
        // timeout, so long reviews can be reported as failed while the native
        // agent keeps working in its pane. Submission and completion are two
        // independently abortable operations instead.
        let response: CommandResult = completedBeforeWait
          ? await runHerdr(["agent", "get", agentName], { timeoutMs: 3_000 })
          : await waitUntilSettled();
        let status = nestedString(
          parseJsonOutput(response.stdout),
          "result",
          "agent",
          "agent_status",
        );
        if (status === "blocked") {
          emit({
            _tag: "BackendError",
            message:
              "Herdr reports that the subagent is waiting for input in its pane.",
          });
          response = await runHerdr(
            ["agent", "wait", agentName, "--until", "idle", "--until", "done"],
            { signal: controller.signal },
          );
          status = nestedString(
            parseJsonOutput(response.stdout),
            "result",
            "agent",
            "agent_status",
          );
        }
        if (
          controller.signal.aborted ||
          !state.activeRun ||
          serial !== state.runSerial
        )
          return;
        const correlatedFinal = sessionRun(
          state.meta.sessionFilePath,
          prompt,
        ).finalText;
        if (status !== "idle" && !(status === "done" && correlatedFinal)) {
          throw new Error(
            `Herdr agent ended in unexpected status ${status ?? "unknown"}.`,
          );
        }
        const finalText = await collectFinalText(prompt);
        if (finalText) {
          emit({
            _tag: "AssistantMessage",
            parts: [{ type: "text", text: finalText }],
          });
        }
        settle(serial, { _tag: "Completed", finalText });
      } catch (error) {
        if (
          controller.signal.aborted ||
          !state.activeRun ||
          serial !== state.runSerial
        )
          return;
        const promptWasSeen = await observedPrompt(prompt).catch(() => false);
        const partialText = await collectFinalText(prompt).catch(() => "");
        settle(serial, {
          _tag: "Failed",
          errorText: boundedError(error),
          partialText: partialText || undefined,
        });

        // A first-turn submission failure has no useful live session to keep.
        // Close it immediately so the failed manager entry cannot leave an
        // idle, unmanaged pane behind.
        if (!promptWasSeen && paneId) {
          const failedPaneId = paneId;
          paneId = undefined;
          await runHerdr(["pane", "close", failedPaneId], {
            timeoutMs: 3_000,
          }).catch(() => undefined);
          state.closed = true;
          stopLiveReads();
          Queue.endUnsafe(events);
        }
      }
    };

    const startRun = (prompt: string) => {
      const serial = ++state.runSerial;
      state.activeRun = true;
      state.activePrompt = prompt;
      runController = new AbortController();
      emit({ _tag: "UserMessage", text: prompt });
      emit({ _tag: "RunStarted" });
      startLiveReads();
      void waitForRun(serial, prompt, runController);
    };

    emit({ _tag: "MetaChanged", meta: state.meta });
    yield* Effect.promise(refreshMeta);
    startRun(task.prompt);

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.tryPromise({
          try: async () => {
            if (state.closed) throw new Error("Subagent session is closed.");
            if (!state.activeRun) {
              startRun(text);
              return;
            }
            await runHerdr(["agent", "prompt", agentName, text]);
            emit({ _tag: "UserMessage", text });
            emit({ _tag: "QueueChanged", queued: [{ text, kind: "steer" }] });
          },
          catch: (error) => new SendError({ message: boundedError(error) }),
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed || !state.activeRun) return;
        const serial = state.runSerial;
        runController?.abort();

        const confirmStopped = async () => {
          try {
            const result = await runHerdr(
              [
                "agent",
                "wait",
                agentName,
                "--until",
                "idle",
                "--until",
                "done",
                "--timeout",
                String(INTERRUPT_TIMEOUT_MS),
              ],
              { timeoutMs: INTERRUPT_TIMEOUT_MS + 1_000 },
            );
            const status = nestedString(
              parseJsonOutput(result.stdout),
              "result",
              "agent",
              "agent_status",
            );
            return status === "idle" || status === "done";
          } catch {
            return false;
          }
        };

        await runHerdr(["agent", "send-keys", agentName, "esc"], {
          timeoutMs: 3_000,
        }).catch(() => undefined);
        let stopped = await confirmStopped();
        if (!stopped && paneId) {
          await runHerdr(["pane", "send-keys", paneId, "ctrl+c"], {
            timeoutMs: 3_000,
          }).catch(() => undefined);
          stopped = await confirmStopped();
        }

        const partialText = await collectFinalText(state.activePrompt).catch(
          () => "",
        );
        settle(serial, {
          _tag: "Interrupted",
          partialText: partialText || undefined,
        });

        if (!stopped && paneId) {
          const unresponsivePaneId = paneId;
          paneId = undefined;
          await runHerdr(["pane", "close", unresponsivePaneId], {
            timeoutMs: 3_000,
          }).catch(() => undefined);
          state.closed = true;
          stopLiveReads();
          Queue.endUnsafe(events);
        }
      }),
    } satisfies SubagentSession;
  });
}

export function createHerdrBackend(kind: BackendName): SubagentBackend {
  return {
    name: kind,
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.sync(herdrAvailable),
    spawn: (task) => makeHerdrSession(kind, task),
  };
}
