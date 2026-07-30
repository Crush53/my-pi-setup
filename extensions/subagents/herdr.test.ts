import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpawnTask } from "./src/domain.ts";
import { agentArguments, sessionRun } from "./src/backends/herdr.ts";

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

test("interactive harness arguments preserve trust and orchestration boundaries", () => {
  const untrustedClaude = agentArguments("claude", task(false), undefined);
  assert.deepEqual(
    untrustedClaude.slice(
      untrustedClaude.indexOf("--setting-sources"),
      untrustedClaude.indexOf("--setting-sources") + 2,
    ),
    ["--setting-sources", "user"],
  );

  const trustedCodex = agentArguments("codex", task(true), undefined);
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
});

test("session result is correlated with the current prompt instead of a prior turn", () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-session-test-"));
  const transcript = join(directory, "session.jsonl");
  const records = [
    { message: { role: "user", content: "old prompt" } },
    { message: { role: "assistant", content: "old answer" } },
    { message: { role: "user", content: "current prompt" } },
    { message: { role: "assistant", content: "current answer" } },
  ];
  writeFileSync(
    transcript,
    `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );

  try {
    assert.deepEqual(sessionRun(transcript, "current prompt"), {
      promptSeen: true,
      finalText: "current answer",
    });
    assert.equal(sessionRun(transcript, "missing prompt").promptSeen, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
