import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveChildProjectTrust } from "./index.ts";
import {
  agentArguments,
  captureSessionCursor,
  claudeSessionPath,
  definedSessionMetaPatch,
  isMissingHerdrTarget,
  normalizedEffortForClaude,
  normalizedEffortForNativeCodex,
  retryHerdrMonitoring,
  sessionRunSince,
} from "./src/backends/herdr.ts";
import type { SpawnTask } from "./src/domain.ts";
import { shouldUseHerdrBackend } from "./src/runtime.ts";

function task(projectTrusted: boolean): SpawnTask {
  return {
    prompt: "current prompt",
    title: "test",
    cwd: "/tmp/project",
    parent: {
      parentCwd: "/tmp/project",
      projectTrusted,
    },
  };
}

test("the global Pi agent directory requires a trusted parent", () => {
  const childCwd = join(getAgentDir(), "extensions", "subagents");
  assert.equal(
    resolveChildProjectTrust({
      parentCwd: "/tmp/untrusted-parent",
      childCwd,
      parentTrusted: false,
    }),
    false,
  );
  assert.equal(
    resolveChildProjectTrust({
      parentCwd: "/tmp/trusted-parent",
      childCwd,
      parentTrusted: true,
    }),
    true,
  );
});

test("interactive harness arguments preserve orchestration and effort boundaries", () => {
  const claude = agentArguments("claude", task(true), undefined);
  assert.equal(
    claude[claude.indexOf("--disallowed-tools") + 1],
    "Agent,Task,Workflow",
  );

  const trustedCodex = agentArguments(
    "codex",
    { ...task(true), reasoningEffort: "max" },
    undefined,
  );
  const untrustedCodex = agentArguments("codex", task(false), undefined);
  assert.ok(trustedCodex.includes("--dangerously-bypass-hook-trust"));
  assert.ok(!untrustedCodex.includes("--dangerously-bypass-hook-trust"));
  for (const args of [trustedCodex, untrustedCodex]) {
    const disable = args.indexOf("--disable");
    assert.deepEqual(args.slice(disable, disable + 2), [
      "--disable",
      "multi_agent",
    ]);
  }
  assert.ok(trustedCodex.includes('model_reasoning_effort="xhigh"'));
  const efforts = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const;
  assert.deepEqual(efforts.map(normalizedEffortForClaude), [
    "low",
    "low",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(efforts.map(normalizedEffortForNativeCodex), [
    "none",
    "low",
    "low",
    "medium",
    "high",
    "xhigh",
    "xhigh",
  ]);
});

test("Claude transcript paths use its canonical non-alphanumeric encoding", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude_path.test_"));
  try {
    const encoded = realpathSync(directory).replace(/[^a-zA-Z0-9]/g, "-");
    assert.ok(claudeSessionPath(directory, "session-id").includes(encoded));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session cursors isolate repeated and transformed prompts to the new turn", () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-session-test-"));
  const transcript = join(directory, "session.jsonl");
  const oldRecords = [
    { type: "message", message: { role: "user", content: "repeat prompt" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: "old answer",
        stopReason: "stop",
      },
    },
  ];
  writeFileSync(
    transcript,
    `${oldRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const cursor = captureSessionCursor(transcript);

  try {
    assert.equal(
      sessionRunSince("pi", transcript, cursor, "repeat prompt").userSeen,
      false,
    );
    const newRecords = [
      { type: "message", message: { role: "user", content: "repeat prompt" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "new answer",
          stopReason: "stop",
        },
      },
    ];
    appendFileSync(
      transcript,
      `${newRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    assert.deepEqual(
      sessionRunSince("pi", transcript, cursor, "repeat prompt"),
      {
        userSeen: true,
        promptSeen: true,
        matchingPromptCount: 1,
        partialText: "new answer",
        finalText: "new answer",
      },
    );

    appendFileSync(
      transcript,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "repeat prompt" } })}\n`,
    );
    const repeated = sessionRunSince("pi", transcript, cursor, "repeat prompt");
    assert.equal(repeated.matchingPromptCount, 2);
    assert.equal(repeated.finalText, undefined);

    const transformedCursor = captureSessionCursor(transcript);
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args></command-args>" } })}\n`,
    );
    assert.deepEqual(
      sessionRunSince("claude", transcript, transformedCursor, "/review"),
      {
        userSeen: true,
        promptSeen: true,
        matchingPromptCount: 1,
        partialText: undefined,
        finalText: undefined,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native transcripts require harness-specific terminal answers", () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-terminal-test-"));
  try {
    const claude = join(directory, "claude.jsonl");
    writeFileSync(
      claude,
      [
        { type: "user", message: { role: "user", content: "managed" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "interim" }],
            stop_reason: "tool_use",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const claudeRun = sessionRunSince(
      "claude",
      claude,
      { sessionFilePath: claude, offset: 0 },
      "managed",
    );
    assert.equal(claudeRun.partialText, "interim");
    assert.equal(claudeRun.finalText, undefined);
    appendFileSync(
      claude,
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "final" }], stop_reason: "end_turn" } })}\n`,
    );
    assert.equal(
      sessionRunSince(
        "claude",
        claude,
        { sessionFilePath: claude, offset: 0 },
        "managed",
      ).finalText,
      "final",
    );

    const codex = join(directory, "codex.jsonl");
    writeFileSync(
      codex,
      [
        {
          type: "event_msg",
          payload: { type: "user_message", message: "startup activity" },
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "startup commentary",
            phase: "commentary",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    assert.deepEqual(
      sessionRunSince(
        "codex",
        codex,
        { sessionFilePath: codex, offset: 0 },
        "$review-agent inspect",
      ),
      {
        userSeen: true,
        promptSeen: false,
        matchingPromptCount: 0,
        partialText: undefined,
        finalText: undefined,
      },
    );
    appendFileSync(
      codex,
      [
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "$review-agent inspect",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "working note",
            phase: "commentary",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    let codexRun = sessionRunSince(
      "codex",
      codex,
      { sessionFilePath: codex, offset: 0 },
      "$review-agent inspect",
    );
    assert.equal(codexRun.partialText, "working note");
    assert.equal(codexRun.finalText, undefined);
    appendFileSync(
      codex,
      `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "review complete", phase: "final_answer" } })}\n`,
    );
    codexRun = sessionRunSince(
      "codex",
      codex,
      { sessionFilePath: codex, offset: 0 },
      "$review-agent inspect",
    );
    assert.equal(codexRun.finalText, "review complete");
    appendFileSync(
      codex,
      [
        {
          type: "event_msg",
          payload: { type: "user_message", message: "steer again" },
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "second-turn commentary",
            phase: "commentary",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    codexRun = sessionRunSince(
      "codex",
      codex,
      { sessionFilePath: codex, offset: 0 },
      "$review-agent inspect",
    );
    assert.equal(codexRun.partialText, "second-turn commentary");
    assert.equal(codexRun.finalText, undefined);

    const pi = join(directory, "pi.jsonl");
    writeFileSync(
      pi,
      [
        { type: "message", message: { role: "user", content: "managed" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "calling a tool" }],
            stopReason: "toolUse",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    assert.equal(
      sessionRunSince("pi", pi, { sessionFilePath: pi, offset: 0 }, "managed")
        .finalText,
      undefined,
    );
    appendFileSync(
      pi,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "pi complete" }], stopReason: "stop" } })}\n`,
    );
    assert.equal(
      sessionRunSince("pi", pi, { sessionFilePath: pi, offset: 0 }, "managed")
        .finalText,
      "pi complete",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session metadata refreshes never erase known values", () => {
  assert.deepEqual(definedSessionMetaPatch(undefined, undefined), {});
  assert.deepEqual(
    definedSessionMetaPatch({ kind: "id", value: "native-id" }, undefined),
    { nativeSessionId: "native-id" },
  );
  assert.deepEqual(
    definedSessionMetaPatch(
      { kind: "path", value: "/session.jsonl" },
      "/session.jsonl",
    ),
    { sessionFilePath: "/session.jsonl" },
  );
});

test("missing Herdr agents and panes are recognized as closed", () => {
  assert.equal(
    isMissingHerdrTarget(new Error('{"error":{"code":"agent_not_found"}}')),
    true,
  );
  assert.equal(
    isMissingHerdrTarget(new Error('{"error":{"code":"pane_not_found"}}')),
    true,
  );
  assert.equal(isMissingHerdrTarget(new Error("temporary failure")), false);
});

test("monitoring retries transient failures but not missing agents", async () => {
  let attempts = 0;
  const result = await retryHerdrMonitoring(async () => {
    attempts++;
    if (attempts < 3) throw new Error("temporary command failure");
    return "healthy";
  });
  assert.equal(result, "healthy");
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    retryHerdrMonitoring(async () => {
      attempts++;
      throw new Error('{"error":{"code":"agent_not_found"}}');
    }),
    /agent_not_found/,
  );
  assert.equal(attempts, 1);
});

test("node test workers do not inherit the Herdr interactive backend", () => {
  assert.equal(
    shouldUseHerdrBackend({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }),
    true,
  );
  assert.equal(
    shouldUseHerdrBackend({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      NODE_TEST_CONTEXT: "child-v8",
    }),
    false,
  );
});
