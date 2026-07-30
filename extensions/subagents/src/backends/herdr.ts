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
const INTERRUPT_STAGE_TIMEOUT_MS = 750;
const MONITOR_RETRY_ATTEMPTS = 3;
const MONITOR_RETRY_DELAY_MS = 150;
const CODEX_PATH_CACHE_RETRY_MS = 1_000;
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

export function isMissingHerdrTarget(error: unknown) {
  const message = boundedError(error);
  return (
    message.includes('"code":"agent_not_found"') ||
    message.includes('"code":"pane_not_found"')
  );
}

function isAbortedHerdrCommand(error: unknown) {
  return boundedError(error).includes("Herdr command aborted.");
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function retryHerdrMonitoring<A>(
  operation: () => Promise<A>,
  signal?: AbortSignal,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MONITOR_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error("Herdr command aborted.");
    try {
      return await operation();
    } catch (error) {
      if (isMissingHerdrTarget(error) || isAbortedHerdrCommand(error)) {
        throw error;
      }
      lastError = error;
      if (attempt + 1 < MONITOR_RETRY_ATTEMPTS) {
        await delay(MONITOR_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastError;
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

export function normalizedEffortForClaude(effort: ReasoningEffort | undefined) {
  switch (effort) {
    case "off":
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return effort;
    case undefined:
      return undefined;
  }
}

export function normalizedEffortForNativeCodex(
  effort: ReasoningEffort | undefined,
) {
  switch (effort) {
    case "off":
      return "none";
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    case "max":
      return "xhigh";
    case undefined:
      return undefined;
  }
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
      "Agent,Task,Workflow",
    ];
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
  const effort = normalizedEffortForNativeCodex(task.reasoningEffort);
  if (effort) args.push("--config", `model_reasoning_effort=\"${effort}\"`);
  return args;
}

function agentSession(agent: JsonRecord | undefined) {
  const session = record(agent?.agent_session);
  const kind = stringValue(session?.kind);
  const value = stringValue(session?.value);
  return kind && value ? { kind, value } : undefined;
}

export function claudeSessionPath(cwd: string, sessionId: string) {
  let canonicalCwd = cwd;
  try {
    canonicalCwd = fs.realpathSync(cwd);
  } catch {
    // Claude receives the original cwd when it cannot be canonicalized.
  }
  const projectDirectory = canonicalCwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects",
    projectDirectory,
    `${sessionId}.jsonl`,
  );
}

const codexSessionPathCache = new Map<
  string,
  { readonly checkedAt: number; readonly sessionFilePath?: string }
>();

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
    const sessionsRoot = path.join(codexHome, "sessions");
    const cacheKey = `${sessionsRoot}\0${session.value}`;
    const cached = codexSessionPathCache.get(cacheKey);
    if (cached?.sessionFilePath && fs.existsSync(cached.sessionFilePath)) {
      return cached.sessionFilePath;
    }
    if (cached && Date.now() - cached.checkedAt < CODEX_PATH_CACHE_RETRY_MS) {
      return cached.sessionFilePath;
    }
    const sessionFilePath = findFileContaining(sessionsRoot, session.value);
    codexSessionPathCache.set(cacheKey, {
      checkedAt: Date.now(),
      sessionFilePath,
    });
    return sessionFilePath;
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

function promptMatches(
  kind: BackendName,
  expectedPrompt: string | undefined,
  actualPrompt: string,
) {
  if (expectedPrompt === undefined) return false;
  const expected = expectedPrompt.trim();
  const actual = actualPrompt.trim();
  if (actual === expected) return true;

  if (kind === "claude" && expected.startsWith("/")) {
    const separator = expected.search(/\s/);
    const command = separator < 0 ? expected : expected.slice(0, separator);
    const args = separator < 0 ? "" : expected.slice(separator).trim();
    return (
      actual.includes(`<command-name>${command}</command-name>`) &&
      (!args || actual.includes(`<command-args>${args}</command-args>`))
    );
  }
  return false;
}

function assistantRecord(kind: BackendName, entry: JsonRecord) {
  const message = record(entry.message);
  const payload = record(entry.payload);
  let text: string | undefined;
  let terminal = false;

  if (
    kind === "pi" &&
    entry.type === "message" &&
    message?.role === "assistant"
  ) {
    text = textParts(message.content) || undefined;
    terminal = message.stopReason === "stop" || message.stopReason === "length";
  } else if (
    kind === "claude" &&
    entry.type === "assistant" &&
    message?.role === "assistant"
  ) {
    text = textParts(message.content) || undefined;
    terminal =
      message.stop_reason === "end_turn" ||
      message.stop_reason === "stop_sequence";
  } else if (
    kind === "codex" &&
    entry.type === "response_item" &&
    payload?.type === "message" &&
    payload.role === "assistant"
  ) {
    text = textParts(payload.content) || undefined;
    terminal = payload.phase === "final_answer";
  } else if (
    kind === "codex" &&
    entry.type === "event_msg" &&
    payload?.type === "agent_message"
  ) {
    text = stringValue(payload.message)?.trim() || undefined;
    terminal = payload.phase === "final_answer";
  } else if (
    kind === "codex" &&
    entry.type === "event_msg" &&
    payload?.type === "task_complete"
  ) {
    text = stringValue(payload.last_agent_message)?.trim() || undefined;
    terminal = Boolean(text);
  }

  return { text, terminal };
}

export function captureSessionCursor(sessionFilePath: string | undefined) {
  if (!sessionFilePath) return { sessionFilePath, offset: 0 };
  try {
    return { sessionFilePath, offset: fs.statSync(sessionFilePath).size };
  } catch {
    return { sessionFilePath, offset: 0 };
  }
}

export function sessionRunSince(
  kind: BackendName,
  sessionFilePath: string | undefined,
  cursor: ReturnType<typeof captureSessionCursor>,
  expectedPrompt?: string,
) {
  if (!sessionFilePath || !fs.existsSync(sessionFilePath)) {
    return { userSeen: false, promptSeen: false, matchingPromptCount: 0 };
  }
  let contents: string;
  try {
    const bytes = fs.readFileSync(sessionFilePath);
    const offset =
      cursor.sessionFilePath === sessionFilePath
        ? Math.min(cursor.offset, bytes.length)
        : 0;
    contents = bytes.subarray(offset).toString("utf8");
  } catch {
    return { userSeen: false, promptSeen: false, matchingPromptCount: 0 };
  }

  let userSeen = false;
  let promptSeen = false;
  let matchingPromptCount = 0;
  let partialText: string | undefined;
  let finalText: string | undefined;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as JsonRecord;
      const user = userText(entry);
      if (user) {
        userSeen = true;
        const matches = promptMatches(kind, expectedPrompt, user);
        if (matches) matchingPromptCount++;
        if (promptSeen || matches) {
          promptSeen = true;
          partialText = undefined;
          finalText = undefined;
        }
        continue;
      }
      if (!promptSeen) continue;
      const assistant = assistantRecord(kind, entry);
      if (!assistant.text) continue;
      partialText = assistant.text.slice(0, FINAL_OUTPUT_MAX_LENGTH);
      if (assistant.terminal) finalText = partialText;
    } catch {
      // Ignore malformed or partially flushed trailing records.
    }
  }
  return {
    userSeen,
    promptSeen,
    matchingPromptCount,
    partialText,
    finalText,
  };
}

export function definedSessionMetaPatch(
  session: { kind: string; value: string } | undefined,
  sessionFilePath: string | undefined,
) {
  return {
    ...(session?.kind === "id"
      ? { nativeSessionId: session.value }
      : undefined),
    ...(sessionFilePath !== undefined ? { sessionFilePath } : undefined),
  } satisfies Partial<SubagentMeta>;
}

class AsyncLock {
  private tail = Promise.resolve();

  async run<A>(operation: () => Promise<A>) {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
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
    const lifecycleLock = new AsyncLock();

    const state = {
      closed: false,
      activeRun: false,
      runSerial: 0,
      promptObserved: false,
      queuedSteers: [] as Array<{
        readonly text: string;
        readonly requiredOccurrence: number;
      }>,
      activePrompt: task.prompt,
      activeCursor: captureSessionCursor(undefined),
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
    const direction = yield* Effect.try({
      try: () => chooseDirection(parseJsonOutput(layout.stdout)),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
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
              await runHerdr(["pane", "send-keys", paneId!, "down"]);
              await delay(250);
              await runHerdr(["pane", "send-keys", paneId!, "enter"]);
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
        const patch = definedSessionMetaPatch(session, sessionFilePath);
        if (Object.keys(patch).length > 0) {
          state.meta = { ...state.meta, ...patch };
          emit({ _tag: "MetaChanged", meta: patch });
        }
      } catch {
        // Session identity is best-effort; callers retry before settling.
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

    const getAgentStatus = (signal?: AbortSignal) =>
      retryHerdrMonitoring(async () => {
        const response = await runHerdr(["agent", "get", agentName], {
          signal,
          timeoutMs: 3_000,
        });
        return nestedString(
          parseJsonOutput(response.stdout),
          "result",
          "agent",
          "agent_status",
        );
      }, signal);

    const waitForStatus = (
      statuses: ReadonlyArray<"idle" | "working" | "blocked" | "done">,
      signal: AbortSignal,
    ) =>
      retryHerdrMonitoring(async () => {
        const args = ["agent", "wait", agentName];
        for (const status of statuses) args.push("--until", status);
        const response = await runHerdr(args, { signal });
        return nestedString(
          parseJsonOutput(response.stdout),
          "result",
          "agent",
          "agent_status",
        );
      }, signal);

    const ensureTargetPresent = async () => {
      if (!paneId) throw new Error("Herdr subagent pane is closed.");
      try {
        await Promise.all([
          runHerdr(["pane", "get", paneId], { timeoutMs: 3_000 }),
          runHerdr(["agent", "get", agentName], { timeoutMs: 3_000 }),
        ]);
      } catch (error) {
        if (isMissingHerdrTarget(error)) {
          state.closed = true;
          paneId = undefined;
          stopLiveReads();
          Queue.endUnsafe(events);
        }
        throw error;
      }
    };

    const observedPrompt = async (
      prompt: string,
      cursor: ReturnType<typeof captureSessionCursor>,
    ) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        await refreshMeta();
        if (
          sessionRunSince(kind, state.meta.sessionFilePath, cursor, prompt)
            .promptSeen
        ) {
          return true;
        }
        await delay(100);
      }
      return false;
    };

    const updateSteeringQueueUnlocked = async () => {
      if (state.queuedSteers.length === 0) return;
      await refreshMeta();
      const pending = state.queuedSteers.filter(
        (queued) =>
          sessionRunSince(
            kind,
            state.meta.sessionFilePath,
            state.activeCursor,
            queued.text,
          ).matchingPromptCount < queued.requiredOccurrence,
      );
      if (pending.length === state.queuedSteers.length) return;
      state.queuedSteers = pending;
      emit({
        _tag: "QueueChanged",
        queued: pending.map(({ text }) => ({ text, kind: "steer" })),
      });
    };

    const updateSteeringQueue = () =>
      lifecycleLock.run(updateSteeringQueueUnlocked);

    const collectFinalText = async (
      cursor: ReturnType<typeof captureSessionCursor>,
      prompt: string,
    ) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        await refreshMeta();
        await updateSteeringQueue();
        const run = sessionRunSince(
          kind,
          state.meta.sessionFilePath,
          cursor,
          prompt,
        );
        if (run.finalText && state.queuedSteers.length === 0) {
          return run.finalText;
        }
        await delay(Math.min(100 + attempt * 4, 300));
      }
      return "";
    };

    const settleUnlocked = (serial: number, outcome: RunOutcome) => {
      if (state.closed || !state.activeRun || serial !== state.runSerial)
        return false;
      state.activeRun = false;
      state.queuedSteers = [];
      runController = undefined;
      stopLiveReads();
      emit({ _tag: "QueueChanged", queued: [] });
      emit({ _tag: "RunSettled", outcome });
      return true;
    };

    const settle = (serial: number, outcome: RunOutcome) =>
      lifecycleLock.run(async () => settleUnlocked(serial, outcome));

    const confirmNativeStopped = async () => {
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
            String(INTERRUPT_STAGE_TIMEOUT_MS),
          ],
          { timeoutMs: INTERRUPT_STAGE_TIMEOUT_MS + 200 },
        );
        const status = nestedString(
          parseJsonOutput(result.stdout),
          "result",
          "agent",
          "agent_status",
        );
        return status === "idle" || status === "done";
      } catch (error) {
        return isMissingHerdrTarget(error);
      }
    };

    const stopNativeRun = async () => {
      await runHerdr(["agent", "send-keys", agentName, "esc"], {
        timeoutMs: 500,
      }).catch(() => undefined);
      if (await confirmNativeStopped()) return true;
      if (paneId) {
        await runHerdr(["pane", "send-keys", paneId, "ctrl+c"], {
          timeoutMs: 500,
        }).catch(() => undefined);
      }
      return confirmNativeStopped();
    };

    const closeCurrentPane = async () => {
      if (!paneId) return true;
      const closingPaneId = paneId;
      try {
        await runHerdr(["pane", "close", closingPaneId], {
          timeoutMs: 1_000,
        });
        paneId = undefined;
        return true;
      } catch (error) {
        if (isMissingHerdrTarget(error)) {
          paneId = undefined;
          return true;
        }
        return false;
      }
    };

    const waitForRun = async (
      serial: number,
      prompt: string,
      controller: AbortController,
    ) => {
      let cursor = state.activeCursor;
      try {
        await refreshMeta();
        cursor = captureSessionCursor(state.meta.sessionFilePath);
        state.activeCursor = cursor;

        const submitPrompt = () =>
          runHerdr(["agent", "prompt", agentName, prompt], {
            signal: controller.signal,
          });
        const waitUntilSettled = () =>
          waitForStatus(["idle", "done", "blocked"], controller.signal);
        const acceptClaudeWarning = async () => {
          if (kind !== "claude") return false;
          const screen = await readTerminal("visible").catch(() => undefined);
          if (
            !screen?.includes("Bypass Permissions mode") ||
            !screen.includes("Yes, I accept")
          ) {
            return false;
          }
          if (!paneId) return false;
          await runHerdr(["pane", "send-keys", paneId, "down"]);
          await delay(250);
          await runHerdr(["pane", "send-keys", paneId, "enter"]);
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

        if (!(await observedPrompt(prompt, cursor))) {
          // A still-initializing TUI can consume the submitted bytes without
          // creating a user turn. Give startup one more grace period and retry
          // once, then fail instead of returning the startup screen as success.
          await delay(2_000);
          await submitPrompt();
          if (!(await observedPrompt(prompt, cursor))) {
            throw new Error(
              "Herdr submitted the prompt, but the native agent did not record it.",
            );
          }
        }
        if (
          !controller.signal.aborted &&
          state.activeRun &&
          serial === state.runSerial
        ) {
          state.promptObserved = true;
        }

        // `agent wait --until idle` can otherwise match the pre-run idle state
        // before Herdr notices the native TUI has started. First observe either
        // a busy state or an assistant response in the correlated transcript.
        let completedBeforeWait = false;
        let workStarted = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          await refreshMeta();
          const run = sessionRunSince(
            kind,
            state.meta.sessionFilePath,
            cursor,
            prompt,
          );
          const currentStatus = await getAgentStatus(controller.signal);
          if (currentStatus === "working" || currentStatus === "blocked") {
            workStarted = true;
            break;
          }
          if (
            run.finalText &&
            (currentStatus === "idle" || currentStatus === "done")
          ) {
            completedBeforeWait = true;
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
        let status = completedBeforeWait
          ? await getAgentStatus(controller.signal)
          : await waitUntilSettled();
        let blockedSeen = false;

        while (true) {
          if (
            controller.signal.aborted ||
            !state.activeRun ||
            serial !== state.runSerial
          ) {
            return;
          }
          if (status === "working") {
            status = await waitUntilSettled();
            continue;
          }
          if (status === "blocked") {
            blockedSeen = true;
            emit({
              _tag: "BackendError",
              message:
                "Herdr reports that the subagent is waiting for input in its pane.",
            });
            do {
              await delay(100);
              status = await getAgentStatus(controller.signal);
            } while (status === "blocked");
            continue;
          }
          if (status !== "idle" && status !== "done") {
            throw new Error(
              `Herdr agent ended in unexpected status ${status ?? "unknown"}.`,
            );
          }

          const finalText = await collectFinalText(cursor, prompt);
          if (finalText) {
            const settled = await lifecycleLock.run(async () => {
              if (
                controller.signal.aborted ||
                !state.activeRun ||
                serial !== state.runSerial ||
                state.queuedSteers.length > 0
              ) {
                return false;
              }
              emit({
                _tag: "AssistantMessage",
                parts: [{ type: "text", text: finalText }],
              });
              return settleUnlocked(serial, {
                _tag: "Completed",
                finalText,
              });
            });
            if (settled) return;
            status = await getAgentStatus(controller.signal);
            continue;
          }
          status = await getAgentStatus(controller.signal);
          if (status === "working" || status === "blocked") continue;
          if (!blockedSeen || status === "done") {
            throw new Error(
              "Herdr agent became idle without a correlated final response.",
            );
          }

          // Planning and permission TUIs can briefly report idle after a menu
          // response while waiting for parent feedback. Keep the managed run
          // alive until the next work/blocked transition instead of treating
          // this input boundary as completion.
          status = await waitForStatus(
            ["working", "blocked", "done"],
            controller.signal,
          );
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
          !state.activeRun ||
          serial !== state.runSerial
        )
          return;
        const promptWasSeen = await observedPrompt(prompt, cursor).catch(
          () => false,
        );
        const stopped = !promptWasSeen || (await stopNativeRun());
        const shouldClose = !promptWasSeen || !stopped;
        const closed = shouldClose ? await closeCurrentPane() : false;
        if (shouldClose && !closed) {
          emit({
            _tag: "BackendError",
            message:
              "Herdr monitoring failed and the native agent could not be stopped or closed; keeping it tracked as running.",
          });
          return;
        }
        await refreshMeta();
        const partialText =
          sessionRunSince(kind, state.meta.sessionFilePath, cursor, prompt)
            .partialText ?? "";
        await settle(serial, {
          _tag: "Failed",
          errorText: boundedError(error),
          partialText: partialText || undefined,
        });
        if (closed) {
          state.closed = true;
          stopLiveReads();
          Queue.endUnsafe(events);
        }
      }
    };

    const startRun = (prompt: string) => {
      const serial = ++state.runSerial;
      state.activeRun = true;
      state.promptObserved = false;
      state.queuedSteers = [];
      state.activePrompt = prompt;
      state.activeCursor = captureSessionCursor(state.meta.sessionFilePath);
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
              await lifecycleLock.run(async () => {
                if (state.closed) {
                  throw new Error("Subagent session is closed.");
                }
                if (state.activeRun) {
                  throw new Error(
                    "Subagent run changed while preparing the follow-up.",
                  );
                }
                await ensureTargetPresent();
                startRun(text);
              });
              return;
            }

            const serial = state.runSerial;
            const controller = runController;
            if (!controller) throw new Error("Subagent run is stopping.");
            await lifecycleLock.run(async () => {
              if (
                state.closed ||
                !state.activeRun ||
                state.runSerial !== serial ||
                controller.signal.aborted
              ) {
                throw new Error("Subagent run is no longer active.");
              }
              for (
                let attempt = 0;
                !state.promptObserved && attempt < 30;
                attempt++
              ) {
                if (controller.signal.aborted) {
                  throw new Error("Subagent run is stopping.");
                }
                await delay(100);
              }
              if (!state.promptObserved) {
                throw new Error(
                  "Cannot steer before the managed prompt is recorded.",
                );
              }
              for (
                let attempt = 0;
                !state.meta.sessionFilePath && attempt < 30;
                attempt++
              ) {
                await refreshMeta();
                if (!state.meta.sessionFilePath) await delay(100);
              }
              if (!state.meta.sessionFilePath) {
                throw new Error(
                  "Cannot steer before the native transcript is available.",
                );
              }
              const observedOccurrences = sessionRunSince(
                kind,
                state.meta.sessionFilePath,
                state.activeCursor,
                text,
              ).matchingPromptCount;
              const requiredOccurrence =
                Math.max(
                  observedOccurrences,
                  ...state.queuedSteers
                    .filter((queued) => queued.text === text)
                    .map((queued) => queued.requiredOccurrence),
                ) + 1;
              await runHerdr(["agent", "prompt", agentName, text], {
                signal: controller.signal,
              });
              if (
                state.closed ||
                !state.activeRun ||
                state.runSerial !== serial ||
                controller.signal.aborted
              ) {
                throw new Error("Subagent run ended while steering.");
              }
              state.queuedSteers.push({ text, requiredOccurrence });
              emit({ _tag: "UserMessage", text });
              emit({
                _tag: "QueueChanged",
                queued: state.queuedSteers.map((queued) => ({
                  text: queued.text,
                  kind: "steer",
                })),
              });
              await updateSteeringQueueUnlocked();
            });
          },
          catch: (error) => new SendError({ message: boundedError(error) }),
        }),
      interrupt: Effect.promise(async (effectSignal) => {
        if (state.closed || !state.activeRun) return;
        const serial = state.runSerial;
        runController?.abort();

        let interrupted = false;
        try {
          interrupted = await lifecycleLock.run(async () => {
            if (
              state.closed ||
              !state.activeRun ||
              state.runSerial !== serial
            ) {
              return true;
            }
            const stopped = await stopNativeRun();
            const closed = !stopped && (await closeCurrentPane());
            if (!stopped && !closed) {
              emit({
                _tag: "BackendError",
                message:
                  "Herdr could not confirm interruption or close the native agent pane; force-disposal is pending.",
              });
              return false;
            }
            await refreshMeta();
            const partialText =
              sessionRunSince(
                kind,
                state.meta.sessionFilePath,
                state.activeCursor,
                state.activePrompt,
              ).partialText ?? "";
            settleUnlocked(serial, {
              _tag: "Interrupted",
              partialText: partialText || undefined,
            });
            if (closed) {
              state.closed = true;
              stopLiveReads();
              Queue.endUnsafe(events);
            }
            return true;
          });
        } catch (error) {
          emit({
            _tag: "BackendError",
            message: `Herdr interruption failed; force-disposal is pending: ${boundedError(error)}`,
          });
        }

        if (!interrupted && !effectSignal.aborted) {
          await new Promise<void>((resolve) => {
            if (effectSignal.aborted) resolve();
            else {
              effectSignal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }
          });
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
