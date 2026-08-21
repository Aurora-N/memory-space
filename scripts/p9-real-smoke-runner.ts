import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySpaceDaemon } from "../src/index.ts";

type Provider = "claude-code";

function providerArgument(): Provider {
  const index = process.argv.indexOf("--provider");
  const value = index < 0 ? "claude-code" : process.argv[index + 1];
  if (value !== "claude-code") {
    throw new Error("P9 real smoke currently supports --provider claude-code only");
  }
  return value;
}

function bind(project: string, spaceId: string, provider: Provider): void {
  mkdirSync(join(project, ".memory-space"), { recursive: true });
  writeFileSync(
    join(project, ".memory-space", "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        spaceId,
        implicitRecall: { mode: "lexical" },
        implicitRemember: { mode: "conservative" },
        semanticExtraction: {
          mode: "grounded",
          timeoutMs: 30_000,
          model: { backend: "host-agent", provider },
        },
      },
      null,
      2
    )}\n`
  );
}

async function realSmoke(provider: Provider): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "memory-space-p9-real-"));
  const project = join(root, "project");
  const spaceId = "p9-real-smoke";
  const source =
    "上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。";
  mkdirSync(project);
  bind(project, spaceId, provider);
  const daemon = createMemorySpaceDaemon({
    databasePath: join(root, "memory.db"),
    mcpRuntime: { cwd: project },
  });
  try {
    await daemon.memorySpace.createSpace({ id: spaceId, name: "P9 real smoke" });
    await daemon.lifecycleHandler.handle({
      type: "session_start",
      provider,
      externalSessionId: "p9-real-a",
      cwd: project,
    });
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider,
      externalSessionId: "p9-real-a",
      cwd: project,
      content: source,
    });
    const turn = await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider,
      externalSessionId: "p9-real-a",
      cwd: project,
      content: "收到。",
    });
    assert.equal(turn.type, "assistant_turn");
    assert.ok((turn.implicitRemember?.committed.length ?? 0) >= 1);
    const memories = (await daemon.memorySpace.browseMemories({ spaceId })).items;
    assert.ok(memories.some((memory) => /variant/u.test(memory.content) && /a、b、c/u.test(memory.content)));
    assert.ok(memories.every((memory) => memory.tier === "indexed"));
    assert.equal((await daemon.memorySpace.getSession(turn.session.id)).lastCheckpointEventId, undefined);
    await assert.rejects(daemon.memorySpace.getLatestHandoff(spaceId), /not found/u);

    await daemon.lifecycleHandler.handle({
      type: "session_start",
      provider,
      externalSessionId: "p9-real-b",
      cwd: project,
    });
    const recalled = await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider,
      externalSessionId: "p9-real-b",
      cwd: project,
      content: "上传模块的 variant 有什么类型？",
    });
    assert.equal(recalled.type, "user_prompt");
    assert.match(recalled.recall?.context ?? "", /a、b、c/u);
    assert.equal((await daemon.memorySpace.listSessions(spaceId)).length, 2);
    console.log(
      JSON.stringify(
        {
          provider,
          status: "PASS",
          semanticMemoryRows: memories.length,
          indexedOnly: true,
          crossSessionRecall: true,
        },
        null,
        2
      )
    );
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function selfTest(): void {
  assert.equal(providerArgument(), "claude-code");
  console.log(JSON.stringify({ status: "PASS", mode: "self-test" }));
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  await realSmoke(providerArgument());
}
