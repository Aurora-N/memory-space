import assert from "node:assert/strict";
import test from "node:test";
import { CompositeMemoryExtractor } from "../src/adapters/declarative-rule-extractor.ts";
import { RuleBasedExtractor } from "../src/adapters/rule-based-extractor.ts";
import { ScriptedSemanticExtractionModel } from "../src/adapters/semantic-models/fake.ts";
import {
  parseSemanticExtractionResponse,
  semanticExtractionLimits,
} from "../src/application/semantic-extraction-policy.ts";
import type { SemanticExtractionConfiguration } from "../src/binding/project-config.ts";
import { SpaceBindingInvalidError } from "../src/integration/errors.ts";
import { ProjectSemanticExtractionConfigurationResolver } from "../src/integration/project-semantic-extraction-config.ts";
import type { Session, SessionEvent } from "../src/domain/types.ts";
import {
  buildSemanticModelEvents,
  SemanticExtractionError,
  SemanticMemoryExtractor,
  type SemanticExtractionDiagnostic,
} from "../src/integration/semantic-memory-extractor.ts";
import type { ExtractionContext } from "../src/ports/extractor.ts";
import type {
  SemanticExtractionModel,
  SemanticModelResolution,
  SemanticModelResolver,
} from "../src/ports/semantic-extraction-model.ts";

const session: Session = {
  id: "session-p9",
  spaceId: "space-p9",
  provider: "fake",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function message(
  id: string,
  sequence: number,
  role: "user" | "assistant",
  content: string
): SessionEvent {
  return {
    id,
    sessionId: session.id,
    type: "message",
    payload: { role, content },
    sequence,
    createdAt: `2026-08-20T00:00:0${sequence}.000Z`,
  };
}

const grounded: SemanticExtractionConfiguration = {
  configuredMode: "grounded",
  effectiveMode: "grounded",
  source: "explicit",
  timeoutMs: 8_000,
  model: {
    backend: "external",
    adapter: "openai-compatible",
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
  },
};

function extractor(
  model: SemanticExtractionModel,
  diagnostics: SemanticExtractionDiagnostic[] = []
): SemanticMemoryExtractor {
  const resolver: SemanticModelResolver<NonNullable<SemanticExtractionConfiguration["model"]>> = {
    async resolve(): Promise<SemanticModelResolution> {
      return {
        available: true,
        model,
        backend: "external",
        adapter: "openai-compatible",
      };
    },
  };
  return new SemanticMemoryExtractor({
    configurationResolver: {
      async resolve() {
        return grounded;
      },
    },
    modelResolver: resolver,
    diagnostics: {
      record(diagnostic) {
        diagnostics.push(diagnostic);
      },
    },
  });
}

function context(
  events: SessionEvent[],
  trigger: ExtractionContext["trigger"] = "implicit_remember"
): ExtractionContext {
  return {
    session,
    trigger,
    operationId: `p9-${trigger}`,
    sourceEvents: events,
  };
}

test("strict semantic schema rejects unknown fields and invalid bounds", () => {
  const valid = {
    schemaVersion: 1,
    candidates: [
      {
        family: "knowledge",
        type: "fact",
        content: "variant 一共有 a、b、c 三种",
        assertion: "direct",
        durability: "durable",
        evidence: [{ eventId: "u1", quote: "variant 一共有 a、b、c 三种" }],
      },
    ],
  };
  assert.ok(parseSemanticExtractionResponse(valid));
  assert.equal(parseSemanticExtractionResponse({ ...valid, extra: true }), undefined);
  assert.equal(
    parseSemanticExtractionResponse({
      ...valid,
      candidates: [{ ...valid.candidates[0], key: "upload.variant.types" }],
    }),
    undefined
  );
  assert.equal(
    parseSemanticExtractionResponse({
      ...valid,
      candidates: Array.from(
        { length: semanticExtractionLimits.maxCandidates + 1 },
        () => valid.candidates[0]
      ),
    }),
    undefined
  );
  assert.equal(parseSemanticExtractionResponse({ ...valid, schemaVersion: 2 }), undefined);
});

test("mandatory natural variant fact becomes one grounded unkeyed Indexed candidate", async () => {
  const userText =
    "上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。";
  const events = [message("u1", 1, "user", userText), message("a1", 2, "assistant", "收到。")];
  const model = new ScriptedSemanticExtractionModel(() => ({
    schemaVersion: 1,
    candidates: [
      {
        family: "knowledge",
        type: "fact",
        content: userText,
        assertion: "direct",
        durability: "durable",
        evidence: [{ eventId: "u1", quote: userText }],
      },
    ],
  }));

  const candidates = await extractor(model).extract(events, context(events));
  assert.deepEqual(candidates, [
    {
      family: "knowledge",
      type: "fact",
      content: userText,
      confidence: 0.9,
      importance: 0.5,
      recommendedTier: "indexed",
      sourceEventIds: ["u1"],
      operation: "create",
      replayIdentity:
        "u1\0上传组件是通过 variant 来判断是否使用新版样式的,现在 variant 一共有 a、b、c 三种。",
    },
  ]);
  assert.equal(model.calls.length, 1);
  assert.ok(model.calls[0]?.instruction.includes("exact substring"));
});

test("grounding rejects fake ids, unsupported quotes, expanded claims, and assistant-only evidence", async () => {
  const user = message("u1", 1, "user", "variant 有 a、b、c 三种");
  const assistant = message("a1", 2, "assistant", "数据库使用 PostgreSQL");
  const proposals = [
    {
      family: "knowledge",
      type: "fact",
      content: "variant 有 a、b、c 三种",
      assertion: "direct",
      durability: "durable",
      evidence: [{ eventId: "fake", quote: "variant 有 a、b、c 三种" }],
    },
    {
      family: "knowledge",
      type: "fact",
      content: "variant 有 a、b、c 三种",
      assertion: "direct",
      durability: "durable",
      evidence: [{ eventId: "u1", quote: "variant 有 a、b、c、d 四种" }],
    },
    {
      family: "knowledge",
      type: "fact",
      content: "variant 有 a、b、c、d 四种",
      assertion: "direct",
      durability: "durable",
      evidence: [{ eventId: "u1", quote: "variant 有 a、b、c 三种" }],
    },
    {
      family: "knowledge",
      type: "fact",
      content: "数据库使用 PostgreSQL",
      assertion: "direct",
      durability: "durable",
      evidence: [{ eventId: "a1", quote: "数据库使用 PostgreSQL" }],
    },
  ];
  const diagnostics: SemanticExtractionDiagnostic[] = [];
  const model = new ScriptedSemanticExtractionModel(() => ({
    schemaVersion: 1,
    candidates: proposals,
  }));
  const candidates = await extractor(model, diagnostics).extract(
    [user, assistant],
    context([user, assistant])
  );
  assert.deepEqual(candidates, []);
  assert.deepEqual(
    diagnostics[0]?.rejected.map((item) => item.reason),
    [
      "unsupported_evidence",
      "unsupported_evidence",
      "unsupported_evidence",
      "assistant_only_evidence",
    ]
  );
});

test("grounding requires raw persisted substrings without newline or whitespace normalization", async () => {
  const source = "variant\r\n有 a、b、c 三种。";
  const user = message("u1", 1, "user", source);
  const diagnostics: SemanticExtractionDiagnostic[] = [];
  const model = new ScriptedSemanticExtractionModel(() => ({
    schemaVersion: 1,
    candidates: [
      {
        family: "knowledge",
        type: "fact",
        content: "variant\n有 a、b、c 三种。",
        assertion: "direct",
        durability: "durable",
        evidence: [{ eventId: "u1", quote: "variant\n有 a、b、c 三种。" }],
      },
      {
        family: "knowledge",
        type: "fact",
        content: source,
        assertion: "direct",
        durability: "durable",
        evidence: [{ eventId: "u1", quote: ` ${source} ` }],
      },
    ],
  }));
  assert.deepEqual(await extractor(model, diagnostics).extract([user], context([user])), []);
  assert.deepEqual(
    diagnostics[0]?.rejected.map((item) => item.reason),
    ["unsupported_evidence", "unsupported_evidence"]
  );
});

test("semantic policy rejects speculation, interaction-local narration, and credential values", async () => {
  const cases = [
    ["我猜 variant 可能还有 d。", "speculative_evidence"],
    ["我现在检查一下 variant。", "interaction_local_evidence"],
    ["我们的数据库密码是 fixture-secret。", "sensitive_evidence"],
  ] as const;
  for (const [content, reason] of cases) {
    const user = message("u1", 1, "user", content);
    const diagnostics: SemanticExtractionDiagnostic[] = [];
    const model = new ScriptedSemanticExtractionModel(() => ({
      schemaVersion: 1,
      candidates: [
        {
          family: "knowledge",
          type: "fact",
          content,
          assertion: reason === "speculative_evidence" ? "uncertain" : "direct",
          durability: reason === "interaction_local_evidence" ? "interaction_local" : "durable",
          evidence: [{ eventId: "u1", quote: content }],
        },
      ],
    }));
    assert.deepEqual(await extractor(model, diagnostics).extract([user], context([user])), []);
    assert.equal(diagnostics[0]?.rejected[0]?.reason, reason);
    assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-secret/u);
  }
});

test("semantic input remains bounded and retains latest user evidence", () => {
  const latestUser = message("u2", 2, "user", `prefix-${"😀".repeat(8_000)}-variant`);
  const events = [
    message("u1", 1, "user", "older"),
    latestUser,
    message("a1", 3, "assistant", "a".repeat(20_000)),
  ];
  const bounded = buildSemanticModelEvents(events);
  assert.ok(
    bounded.reduce((total, event) => total + event.content.length, 0) <=
      semanticExtractionLimits.maxInputChars
  );
  assert.ok(bounded.some((event) => event.id === latestUser.id));
  for (const event of bounded) {
    const last = event.content.charCodeAt(event.content.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff));
  }
});

test("semantic input truncation is linear-safe for large ASCII, Chinese, and surrogate boundaries", () => {
  const original = `未修改-${"界".repeat(100_000)}😀tail`;
  const ascii = buildSemanticModelEvents([message("u1", 1, "user", "a".repeat(200_000))], 101);
  const chinese = buildSemanticModelEvents([message("u2", 2, "user", original)], 103);
  const splitSurrogate = buildSemanticModelEvents(
    [message("u3", 3, "user", `${"x".repeat(100)}😀tail`)],
    5
  );
  assert.equal(ascii[0]?.content.length, 101);
  assert.equal(chinese[0]?.content.length, 103);
  assert.equal(splitSurrogate[0]?.content, "tail");
  assert.equal(message("u2", 2, "user", original).payload.content, original);
  for (const events of [ascii, chinese, splitSurrogate]) {
    assert.ok(events.reduce((sum, event) => sum + event.content.length, 0) <= 103);
    const first = events[0]?.content.charCodeAt(0) ?? 0;
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff));
  }
});

test("semantic extraction never treats a derived event view as grounding authority", async () => {
  const full = message("u1", 1, "user", "数据库使用 PostgreSQL。");
  const derived = message("u1", 1, "user", "PostgreSQL");
  const model = new ScriptedSemanticExtractionModel(() => ({
    schemaVersion: 1,
    candidates: [
      {
        family: "knowledge",
        type: "fact",
        content: "PostgreSQL",
        assertion: "direct",
        durability: "durable",
        evidence: [{ eventId: "u1", quote: "PostgreSQL" }],
      },
    ],
  }));
  const missingAuthority = { ...context([full]), sourceEvents: undefined };
  assert.deepEqual(await extractor(model).extract([derived], missingAuthority), []);
  await assert.rejects(
    extractor(model).extract([derived], { ...missingAuthority, trigger: "checkpoint" }),
    (error: unknown) =>
      error instanceof SemanticExtractionError &&
      error.code === "authoritative_source_events_missing"
  );
});

test("semantic failure is optional for implicit extraction and fatal for configured checkpoint", async () => {
  const user = message("u1", 1, "user", "CROSS_AGENT_TEST_20260817 = lavender-731");
  const semantic = extractor({
    async extract() {
      throw new SemanticExtractionError("timeout");
    },
  });
  const composite = new CompositeMemoryExtractor([new RuleBasedExtractor(), semantic]);
  const implicit = await composite.extract([user], context([user]));
  assert.equal(implicit.length, 1);
  assert.equal(implicit[0]?.key, "CROSS_AGENT_TEST_20260817");
  await assert.rejects(
    composite.extract([user], context([user], "checkpoint")),
    (error: unknown) => error instanceof SemanticExtractionError && error.code === "timeout"
  );
});

test("persisted malformed project binding disables semantic extraction without cwd fallback", async () => {
  const resolver = new ProjectSemanticExtractionConfigurationResolver(async () => {
    throw new SpaceBindingInvalidError("/project/.memory-space/config.json");
  });
  const resolved = await resolver.resolve({
    ...context([]),
    projectBinding: {
      sessionId: session.id,
      spaceId: session.spaceId,
      source: "config",
      configPath: "/project/.memory-space/config.json",
    },
  });
  assert.deepEqual(resolved, {
    effectiveMode: "off",
    source: "default",
    timeoutMs: 8_000,
  });
});
