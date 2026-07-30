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
    { message: { role: "user", content: "repeat prompt" } },
    { message: { role: "assistant", content: "old answer" } },
  ];
  writeFileSync(
    transcript,
    `${oldRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const cursor = captureSessionCursor(transcript);

  try {
    assert.equal(
      sessionRunSince(transcript, cursor, "repeat prompt").userSeen,
      false,
    );
    const newRecords = [
      { message: { role: "user", content: "repeat prompt" } },
      { message: { role: "assistant", content: "new answer" } },
    ];
    appendFileSync(
      transcript,
      `${newRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    assert.deepEqual(sessionRunSince(transcript, cursor, "repeat prompt"), {
      userSeen: true,
      promptSeen: true,
      finalText: "new answer",
    });

    const transformedCursor = captureSessionCursor(transcript);
    appendFileSync(
      transcript,
      `${JSON.stringify({ message: { role: "user", content: "generated review prompt" } })}\n`,
    );
    assert.deepEqual(
      sessionRunSince(transcript, transformedCursor, "/review"),
      {
        userSeen: true,
        promptSeen: false,
        finalText: undefined,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
