import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CheckpointPolicy,
  createDefaultMemorySpace,
  exactPromptControl,
  extractExactKeyCandidates,
  ImplicitRecallService,
  LifecycleHandler,
  NoopExtractor,
  promptMemoryDirective,
  ProviderSessionResolver,
  renderImplicitRecallContext,
  SpaceResolver,
  type Memory,
  type Session
} from "../src/index.ts";

function bind(
  directory: string,
  spaceId: string,
  implicitRecall: unknown = { mode: "exact" }
): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(join(bindingDirectory, "config.json"), JSON.stringify({
    version: 1,
    spaceId,
    implicitRecall
  }));
}

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "memory-secret-id",
    spaceId: "space-1",
    family: "knowledge",
    type: "fact-secret-type",
    key: "secret.key",
    content: "safe content",
    tier: "indexed",
    status: "active",
    importance: 0.5,
    confidence: 1,
    sourceSessionId: "source-secret-session",
    version: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

test("exact candidate extraction applies distinctiveness before its bound", () => {
  assert.deepEqual(extractExactKeyCandidates([
    "the what value variant project ordinary prose should not count",
    "CROSS_AGENT_TEST_20260817 project.database feature-42 api/v2/orders ABC"
  ].join(" "), 5), [
    "CROSS_AGENT_TEST_20260817",
    "project.database",
    "feature-42",
    "api/v2/orders",
    "ABC"
  ]);
  assert.deepEqual(extractExactKeyCandidates("abc lower ordinary 123 xyz_1 ABC", 2), [
    "123", "xyz_1"
  ]);
  const maximumKey = `${"A".repeat(127)}1`;
  assert.deepEqual(extractExactKeyCandidates(`${maximumKey}X`), []);
  assert.deepEqual(extractExactKeyCandidates("_ABC_123"), []);
});

test("exact recall never prefix- or suffix-matches an invalid complete token", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  try {
    const space = await memorySpace.createSpace({ id: "space-token-boundary", name: "Tokens" });
    const source = await memorySpace.createSession({ spaceId: space.id });
    const target = await memorySpace.createSession({ spaceId: space.id });
    const maximumKey = `${"A".repeat(127)}1`;
    await memorySpace.remember({
      spaceId: space.id,
      sourceSessionId: source.id,
      family: "knowledge",
      type: "fact",
      key: maximumKey,
      content: "must not disclose from an overlong prefix"
    });
    await memorySpace.remember({
      spaceId: space.id,
      sourceSessionId: source.id,
      family: "knowledge",
      type: "fact",
      key: "ABC_123",
      content: "must not disclose from an invalid leading character"
    });
    const service = new ImplicitRecallService(memorySpace);
    for (const prompt of [`${maximumKey}X`, "_ABC_123"]) {
      const result = await service.recall({ sessionId: target.id, prompt, mode: "exact" });
      assert.equal(result.context, undefined);
      assert.deepEqual(result.debugItems, []);
    }
  } finally {
    await memorySpace.close();
  }
});

test("lexical mode runs bounded exact lookups and full-prompt Memory search concurrently", async () => {
  let active = 0;
  let maximumActive = 0;
  const exactKeys: string[] = [];
  const lexicalQueries: string[] = [];
  const now = new Date(0).toISOString();
  const session: Session = {
    id: "concurrent-session",
    spaceId: "concurrent-space",
    createdAt: now,
    updatedAt: now
  };
  const service = new ImplicitRecallService({
    async getSession() { return session; },
    async findActiveIndexedMemoryByNormalizedKey(_spaceId, key) {
      exactKeys.push(key);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, key === "ABC_1" ? 8 : 3));
      active -= 1;
      return memory({ id: `exact-${key}`, key, content: `exact ${key}` });
    },
    async search(input) {
      lexicalQueries.push(input.query);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return [{
        memory: memory({ id: "lexical-result", key: "lexical.result", content: "lexical" }),
        score: 1
      }];
    }
  });
  const prompt = "Compare ABC_1 DEF_2 with current repository evidence";
  const result = await service.recall({ sessionId: session.id, prompt, mode: "lexical" });
  assert.deepEqual(exactKeys, ["ABC_1", "DEF_2"]);
  assert.deepEqual(lexicalQueries, [prompt]);
  assert.deepEqual(result.debugItems.map((item) => item.key), [
    "ABC_1",
    "DEF_2",
    "lexical.result"
  ]);
  assert.equal(maximumActive, 3);
});

test("exact mode does not run the lexical full-prompt search", async () => {
  const now = new Date(0).toISOString();
  const session: Session = {
    id: "exact-only-session",
    spaceId: "exact-only-space",
    createdAt: now,
    updatedAt: now
  };
  let lexicalSearches = 0;
  const service = new ImplicitRecallService({
    async getSession() { return session; },
    async findActiveIndexedMemoryByNormalizedKey(_spaceId, key) {
      return memory({ id: "exact-only-memory", key, content: "exact-only content" });
    },
    async search() {
      lexicalSearches += 1;
      return [];
    }
  });
  const result = await service.recall({
    sessionId: session.id,
    prompt: "PROJECT.VERSION_2026",
    mode: "exact"
  });
  assert.equal(lexicalSearches, 0);
  assert.equal(result.debugItems[0]?.key, "PROJECT.VERSION_2026");
});

test("exact recall is independent of lexical top-20 truncation", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  try {
    const space = await memorySpace.createSpace({ id: "space-exact-rank", name: "Exact rank" });
    const source = await memorySpace.createSession({ spaceId: space.id });
    const target = await memorySpace.createSession({ spaceId: space.id });
    const key = "service.feature.module.version.build.id";
    const exact = await memorySpace.remember({
      spaceId: space.id,
      sourceSessionId: source.id,
      family: "knowledge",
      type: "fact",
      key,
      content: "canonical exact key memory"
    });
    for (let index = 0; index < 21; index += 1) {
      await memorySpace.remember({
        spaceId: space.id,
        sourceSessionId: source.id,
        family: "knowledge",
        type: "fact",
        key: `distractor.${String(index).padStart(2, "0")}`,
        content: `${key} distractor content ${index}`
      });
    }

    const legacyTopTwenty = await memorySpace.search({
      spaceId: space.id,
      query: key,
      tiers: ["indexed"],
      statuses: ["active"],
      limit: 20
    });
    assert.equal(legacyTopTwenty.some(({ memory }) => memory.id === exact.id), false);

    const result = await new ImplicitRecallService(memorySpace).recall({
      sessionId: target.id,
      prompt: key,
      mode: "exact"
    });
    assert.equal(result.debugItems[0]?.key, key);
    assert.match(result.context ?? "", /canonical exact key memory/u);
    assert.doesNotMatch(result.context ?? "", /distractor content/u);
  } finally {
    await memorySpace.close();
  }
});

test("application exact-key lookup normalizes equality and enforces Space, active, and Indexed eligibility", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  try {
    const space = await memorySpace.createSpace({ id: "space-exact-eligibility", name: "Eligibility" });
    const other = await memorySpace.createSpace({ id: "space-exact-other", name: "Other" });
    const normalized = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "fact",
      key: "PROJECT.VERSION_2026",
      content: "normalized exact hit"
    });
    const core = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "fact",
      key: "CORE.VERSION_2026",
      content: "core is bootstrap only"
    });
    await memorySpace.promote(core.id, { actor: "user" });
    const archived = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "fact",
      key: "ARCHIVED.VERSION_2026",
      content: "archived must not return"
    });
    await memorySpace.setMemoryStatus(archived.id, "archived");
    const resolved = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "fact",
      key: "RESOLVED.VERSION_2026",
      content: "resolved must not return"
    });
    await memorySpace.setMemoryStatus(resolved.id, "resolved");
    await memorySpace.remember({
      spaceId: other.id,
      family: "knowledge",
      type: "fact",
      key: "OTHER.VERSION_2026",
      content: "other Space must not return"
    });

    assert.equal(
      (await memorySpace.findActiveIndexedMemoryByNormalizedKey(
        space.id,
        "project.version_2026"
      ))?.id,
      normalized.id
    );
    for (const key of [
      "core.version_2026",
      "archived.version_2026",
      "resolved.version_2026",
      "other.version_2026"
    ]) {
      assert.equal(
        await memorySpace.findActiveIndexedMemoryByNormalizedKey(space.id, key),
        undefined,
        key
      );
    }
  } finally {
    await memorySpace.close();
  }
});

test("prompt Memory directive is narrow and deterministic", () => {
  for (const prompt of [
    "不要使用之前的记忆回答",
    "不要参考之前的 Memory",
    "这次不要使用 Memory Space",
    "Do not use previous memory",
    "Answer without prior memory"
  ]) assert.equal(promptMemoryDirective(prompt), "disable_for_prompt");
  for (const prompt of [
    "你还记得之前的方案吗？",
    "memory-space 怎么实现？",
    "之前记忆里记录了什么？"
  ]) assert.equal(promptMemoryDirective(prompt), "allow");
});

test("implicit recall enforces active Indexed eligibility and exact/lexical modes", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  try {
    const space = await memorySpace.createSpace({ id: "space-main", name: "Main" });
    const other = await memorySpace.createSpace({ id: "space-other", name: "Other" });
    const session = await memorySpace.createSession({ spaceId: space.id, provider: "codex" });
    const source = await memorySpace.createSession({ spaceId: space.id, provider: "seed" });
    const exact = await memorySpace.remember({
      spaceId: space.id,
      sourceSessionId: source.id,
      family: "knowledge",
      type: "fact",
      key: "CROSS_AGENT_TEST_20260817",
      content: "CROSS_AGENT_TEST_20260817 = lavender-731"
    });
    const lexical = await memorySpace.remember({
      spaceId: space.id,
      sourceSessionId: source.id,
      family: "knowledge",
      type: "fact",
      key: "upload.variant.types",
      content: "上传模块使用 variant 区分新版样式，variant 的类型包括 a、b、c。"
    });
    const inactive = await memorySpace.remember({
      spaceId: space.id,
      sourceSessionId: source.id,
      family: "knowledge",
      type: "fact",
      key: "INACTIVE_20260817",
      content: "must not appear"
    });
    await memorySpace.setMemoryStatus(inactive.id, "archived");
    const core = await memorySpace.remember({
      spaceId: space.id,
      sourceSessionId: source.id,
      family: "knowledge",
      type: "fact",
      key: "CORE_ONLY_20260817",
      content: "core must not be re-injected"
    });
    await memorySpace.promote(core.id, { actor: "user" });
    const otherSource = await memorySpace.createSession({ spaceId: other.id, provider: "seed" });
    await memorySpace.remember({
      spaceId: other.id,
      sourceSessionId: otherSource.id,
      family: "knowledge",
      type: "fact",
      key: "OTHER_SPACE_20260817",
      content: "other Space must not appear"
    });
    const service = new ImplicitRecallService(memorySpace);

    const bare = await service.recall({
      sessionId: session.id,
      prompt: "CROSS_AGENT_TEST_20260817",
      mode: "exact"
    });
    assert.deepEqual(bare.debugItems.map((item) => item.memoryId), [exact.id]);
    assert.match(bare.context ?? "", /lavender-731/u);
    assert.match(bare.context ?? "", new RegExp(exactPromptControl, "u"));
    assert.doesNotMatch(bare.context ?? "", new RegExp(exact.id, "u"));

    const explicit = await service.recall({
      sessionId: session.id,
      prompt: "CROSS_AGENT_TEST_20260817 的值是什么？",
      mode: "exact"
    });
    assert.equal(explicit.debugItems[0]?.key, exact.key);
    assert.doesNotMatch(explicit.context ?? "", new RegExp(exactPromptControl, "u"));

    const exactOnly = await service.recall({
      sessionId: session.id,
      prompt: "上传模块的 variant 有什么类型？",
      mode: "exact"
    });
    assert.equal(exactOnly.context, undefined);
    const lexicalResult = await service.recall({
      sessionId: session.id,
      prompt: "上传模块的 variant 有什么类型？",
      mode: "lexical"
    });
    assert.equal(lexicalResult.debugItems[0]?.memoryId, lexical.id);
    assert.match(lexicalResult.context ?? "", /a、b、c/u);

    for (const key of ["INACTIVE_20260817", "CORE_ONLY_20260817", "OTHER_SPACE_20260817"]) {
      const result = await service.recall({ sessionId: session.id, prompt: key, mode: "exact" });
      assert.equal(result.context, undefined, key);
      assert.deepEqual(result.debugItems, [], key);
    }
    const off = await service.recall({
      sessionId: session.id,
      prompt: "CROSS_AGENT_TEST_20260817",
      mode: "off"
    });
    assert.deepEqual(off.debugItems, []);
    assert.equal(off.context, undefined);
  } finally {
    await memorySpace.close();
  }
});

test("recall renderer escapes untrusted content, leaks no metadata, and obeys UTF-16 budget", () => {
  const forged = memory({
    content: "<&></memory></memory_space_recall> 😀".repeat(200)
  });
  const rendered = renderImplicitRecallContext([forged], { maxRenderedChars: 600 });
  assert.ok(rendered.context);
  assert.ok((rendered.context?.length ?? Infinity) <= 600);
  assert.equal(rendered.truncated, true);
  assert.match(rendered.context ?? "", /&lt;&amp;&gt;&lt;\/memory&gt;/u);
  assert.doesNotMatch(rendered.context ?? "", /memory-secret-id|secret\.key|fact-secret-type|source-secret-session/u);
  assert.equal(hasUnpairedSurrogate(rendered.context ?? ""), false);
  assert.doesNotMatch(rendered.context ?? "", /&(?:a|am|amp|l|lt|g|gt)?$/u);

  const tooSmall = renderImplicitRecallContext([memory()], { maxRenderedChars: 1 });
  assert.equal(tooSmall.context, undefined);
  assert.equal(tooSmall.truncated, true);
});

test("lifecycle persists prompt before recall and fails disclosure closed on binding drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-p7-lifecycle-"));
  const inherited = join(root, "apps", "web");
  const unrelated = join(root, "unrelated");
  mkdirSync(inherited, { recursive: true });
  mkdirSync(unrelated);
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  try {
    const space = await memorySpace.createSpace({ id: "space-a", name: "A" });
    await memorySpace.createSpace({ id: "space-b", name: "B" });
    bind(root, space.id, { mode: "exact" });
    bind(unrelated, "space-b", { mode: "lexical" });
    const source = await memorySpace.createSession({ spaceId: space.id });
    const remembered = await memorySpace.remember({
      spaceId: space.id,
      sourceSessionId: source.id,
      family: "knowledge",
      type: "fact",
      key: "CROSS_AGENT_TEST_20260817",
      content: "lavender-731"
    });
    const rememberedHistory = await memorySpace.getMemoryHistory(remembered.id);
    const diagnostics: unknown[] = [];
    const handler = new LifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver: new ProviderSessionResolver(memorySpace),
      checkpointPolicy: new CheckpointPolicy(memorySpace),
      implicitRecall: new ImplicitRecallService(memorySpace),
      onWarning(diagnostic) { diagnostics.push(diagnostic); }
    });
    const started = await handler.handle({
      type: "session_start",
      provider: "codex",
      externalSessionId: "p7-session",
      cwd: root
    });
    if (started.type !== "session_start") throw new Error("Expected session_start");
    const matching = await handler.handle({
      type: "user_prompt",
      provider: "codex",
      externalSessionId: "p7-session",
      cwd: root,
      content: "CROSS_AGENT_TEST_20260817"
    });
    if (matching.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.match(matching.recall?.context ?? "", /lavender-731/u);

    const inheritedResult = await handler.handle({
      type: "user_prompt",
      provider: "codex",
      externalSessionId: "p7-session",
      cwd: inherited,
      content: "CROSS_AGENT_TEST_20260817"
    });
    if (inheritedResult.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.match(inheritedResult.recall?.context ?? "", /lavender-731/u);

    const drifted = await handler.handle({
      type: "user_prompt",
      provider: "codex",
      externalSessionId: "p7-session",
      cwd: unrelated,
      content: "CROSS_AGENT_TEST_20260817"
    });
    if (drifted.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.equal(drifted.session.id, started.session.id);
    assert.equal(drifted.session.spaceId, space.id);
    assert.equal(drifted.recall?.effectiveMode, "off");
    assert.equal(drifted.recall?.context, undefined);
    assert.equal((await memorySpace.listEvents(started.session.id)).length, 3);
    assert.equal(diagnostics.length, 1);

    bind(root, space.id, { mode: "off" });
    const disabled = await handler.handle({
      type: "user_prompt",
      provider: "codex",
      externalSessionId: "p7-session",
      cwd: root,
      content: "CROSS_AGENT_TEST_20260817"
    });
    if (disabled.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.equal(disabled.recall?.effectiveMode, "off");
    assert.equal(disabled.recall?.context, undefined);

    bind(root, space.id, { mode: "invalid" });
    const invalid = await handler.handle({
      type: "user_prompt",
      provider: "codex",
      externalSessionId: "p7-session",
      cwd: root,
      content: "CROSS_AGENT_TEST_20260817"
    });
    if (invalid.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.equal(invalid.recall?.effectiveMode, "off");
    assert.equal(invalid.recall?.context, undefined);

    bind(root, space.id, { mode: "exact" });
    const optedOut = await handler.handle({
      type: "user_prompt",
      provider: "codex",
      externalSessionId: "p7-session",
      cwd: root,
      content: "不要使用之前的记忆回答 CROSS_AGENT_TEST_20260817"
    });
    if (optedOut.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.equal(optedOut.recall?.bypassed, true);
    assert.doesNotMatch(optedOut.recall?.context ?? "", /lavender-731/u);
    assert.match(optedOut.recall?.context ?? "", /disabled Memory Space reads/u);

    const failingHandler = new LifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver: new ProviderSessionResolver(memorySpace),
      checkpointPolicy: new CheckpointPolicy(memorySpace),
      implicitRecall: { async recall() { throw new Error("recall unavailable"); } },
      onWarning(diagnostic) { diagnostics.push(diagnostic); }
    });
    const beforeFailure = (await memorySpace.listEvents(started.session.id)).length;
    const failedRecall = await failingHandler.handle({
      type: "user_prompt",
      provider: "codex",
      externalSessionId: "p7-session",
      cwd: root,
      content: "CROSS_AGENT_TEST_20260817"
    });
    if (failedRecall.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.equal(failedRecall.recall?.effectiveMode, "off");
    assert.equal(failedRecall.recall?.context, undefined);
    assert.equal((await memorySpace.listEvents(started.session.id)).length, beforeFailure + 1);
    assert.deepEqual(await memorySpace.getMemory(remembered.id), remembered);
    assert.deepEqual(await memorySpace.getMemoryHistory(remembered.id), rememberedHistory);
  } finally {
    await memorySpace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant turns never invoke prompt recall", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-p7-assistant-"));
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  try {
    const space = await memorySpace.createSpace({ id: "space-assistant", name: "Assistant" });
    bind(root, space.id);
    let recallCalls = 0;
    const handler = new LifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver: new ProviderSessionResolver(memorySpace),
      checkpointPolicy: new CheckpointPolicy(memorySpace),
      implicitRecall: {
        async recall() {
          recallCalls += 1;
          throw new Error("assistant turn must not call recall");
        }
      }
    });
    const started = await handler.handle({
      type: "session_start",
      provider: "codex",
      externalSessionId: "assistant-session",
      cwd: root
    });
    if (started.type !== "session_start") throw new Error("Expected session_start");
    const assistant = await handler.handle({
      type: "assistant_turn",
      provider: "codex",
      externalSessionId: "assistant-session",
      cwd: root,
      content: "final response"
    });
    assert.equal(assistant.type, "assistant_turn");
    assert.equal(recallCalls, 0);
    assert.equal((await memorySpace.listEvents(started.session.id)).length, 1);
  } finally {
    await memorySpace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Space without a matching project binding persists prompt but disables recall", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-p7-explicit-"));
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  try {
    const space = await memorySpace.createSpace({ id: "space-explicit", name: "Explicit" });
    const handler = new LifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver: new ProviderSessionResolver(memorySpace),
      checkpointPolicy: new CheckpointPolicy(memorySpace),
      implicitRecall: new ImplicitRecallService(memorySpace)
    });
    const started = await handler.handle({
      type: "session_start",
      provider: "codex",
      externalSessionId: "explicit-session",
      cwd: root
    }, { explicitSpaceId: space.id });
    if (started.type !== "session_start") throw new Error("Expected session_start");
    const prompted = await handler.handle({
      type: "user_prompt",
      provider: "codex",
      externalSessionId: "explicit-session",
      cwd: root,
      content: "CROSS_AGENT_TEST_20260817"
    }, { explicitSpaceId: space.id });
    if (prompted.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.equal(prompted.recall?.effectiveMode, "off");
    assert.equal(prompted.recall?.context, undefined);
    assert.equal((await memorySpace.listEvents(started.session.id)).length, 1);
  } finally {
    await memorySpace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
