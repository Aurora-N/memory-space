import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  CheckpointPolicy,
  ClaudeAdapter,
  CodexAdapter,
  createDefaultMemorySpace,
  createMemoryMcpServer,
  LifecycleHandler,
  MemorySpace,
  MemoryMcpGateway,
  NoopCache,
  ProviderSessionResolver,
  SqliteMemoryStore,
  SpaceResolver,
  type HandoffSnapshot,
  type Memory,
  type MemorySearchInput
} from "../../src/index.ts";
import { loadQualityFixtures } from "./fixtures.ts";
import { LogicalMemoryIndex } from "./identity.ts";
import {
  aggregateNegativeRetrieval,
  aggregateRetrieval,
  countedRatio,
  duplicateRate,
  eligibleRetrievalKs,
  extractionMetric,
  pollutionRate,
  retrievalAtK,
  setCompleteness,
  staleRate
} from "./metrics.ts";
import type {
  CorrectnessCheck,
  GroundTruthMemory,
  MemoryQualityReport,
  QualityFailureExample,
  QualityFixtureBundle,
  QualityScenarioResult,
  RetrievalQueryFixture,
  RetrievalQueryResult
} from "./types.ts";
import { createEvaluationExtractor } from "../support/extraction-rules.ts";

const exactMcpTools = [
  "memory_bootstrap",
  "memory_checkpoint",
  "memory_context",
  "memory_promote",
  "memory_remember",
  "memory_search"
] as const;

interface ScenarioOutput<T> {
  value: T;
  scenario: QualityScenarioResult;
  failures: QualityFailureExample[];
}

interface ExtractionOutput {
  metric: ReturnType<typeof extractionMetric>;
}

interface RetrievalOutput {
  queryResults: RetrievalQueryResult[];
}

interface LongHorizonOutput {
  summary: MemoryQualityReport["summary"];
  queryResults: RetrievalQueryResult[];
  correctness: CorrectnessCheck[];
}

/**
 * Retrieval reports must preserve the exact production order while remaining
 * reproducible. Stable eval-only runtime identities make the production id
 * tie-break deterministic without sorting by fixture logical key after search.
 */
class QualityRetrievalStore extends SqliteMemoryStore {
  #nextMemoryId = 0;

  override async insertMemory(memory: Memory): Promise<void> {
    this.#nextMemoryId += 1;
    memory.id = `00000000-0000-4000-8000-${String(this.#nextMemoryId).padStart(12, "0")}`;
    await super.insertMemory(memory);
  }
}

function createQualityRetrievalMemorySpace(databasePath: string): MemorySpace {
  return new MemorySpace({
    store: new QualityRetrievalStore(databasePath),
    extractor: createEvaluationExtractor(),
    cache: new NoopCache()
  });
}

function matchMemory(memory: Memory, expected: GroundTruthMemory): boolean {
  return memory.family === expected.family
    && memory.type === expected.type
    && memory.content === expected.content
    && (expected.key === undefined || memory.key === expected.key);
}

function stableMemoryLabel(memory: Memory): string {
  return `${memory.family}/${memory.type}:${memory.key ?? memory.content}`;
}

function stableUnknown(memory: Memory): string {
  return `unmapped:${stableMemoryLabel(memory)}`;
}

async function allMemories(memorySpace: MemorySpace, spaceId: string): Promise<Memory[]> {
  return (await memorySpace.search({
    spaceId,
    query: "",
    statuses: ["active", "resolved", "superseded", "archived"],
    limit: 100
  })).map((result) => result.memory);
}

function findExpected(memories: readonly Memory[], expected: GroundTruthMemory): Memory | undefined {
  return memories.find((memory) => matchMemory(memory, expected));
}

function registerTruth(
  truthByKey: Map<string, GroundTruthMemory>,
  truth: GroundTruthMemory
): void {
  truthByKey.set(truth.logicalKey, truth);
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function fail(
  scenario: string,
  metric: string,
  expected: unknown,
  observed: unknown,
  explanation: string
): QualityFailureExample {
  return { scenario, metric, expected, observed, explanation };
}

async function runExtractionScenario(
  root: string,
  fixtures: QualityFixtureBundle
): Promise<ScenarioOutput<ExtractionOutput>> {
  const fixture = fixtures.extraction;
  const memorySpace = createDefaultMemorySpace({ databasePath: join(root, "extraction.db") });
  const failures: QualityFailureExample[] = [];
  try {
    const space = await memorySpace.createSpace({ id: "quality-extraction", name: fixture.id });
    const session = await memorySpace.createSession({
      id: "quality-extraction-session",
      spaceId: space.id,
      agentId: "quality-eval"
    });
    const event = await memorySpace.appendEvent({
      id: "quality-extraction-event",
      sessionId: session.id,
      type: "message",
      payload: { text: fixture.events.join("\n") }
    });
    await memorySpace.checkpoint({
      sessionId: session.id,
      toEventId: event.id,
      idempotencyKey: fixture.id
    });

    const predictions = await allMemories(memorySpace, space.id);
    const matchedIds = new Set<string>();
    const matchedKeys: string[] = [];
    const missingKeys: string[] = [];
    for (const expected of fixture.expectedMemories) {
      const memory = findExpected(predictions, expected);
      if (memory) {
        matchedIds.add(memory.id);
        matchedKeys.push(expected.logicalKey);
      } else {
        missingKeys.push(expected.logicalKey);
        failures.push(fail(
          fixture.id,
          "extraction-recall",
          expected.logicalKey,
          "not extracted",
          expected.rationale
        ));
      }
    }
    const unexpected = predictions
      .filter((memory) => !matchedIds.has(memory.id))
      .map(stableMemoryLabel)
      .sort();
    for (const observed of unexpected) {
      failures.push(fail(
        fixture.id,
        "extraction-precision",
        "no durable Memory for negative/transient evidence",
        observed,
        "Checkpoint extraction produced a Memory not present in fixture ground truth."
      ));
    }
    const metric = extractionMetric(
      matchedIds.size,
      unexpected.length,
      fixture.expectedMemories.length - matchedIds.size
    );
    return {
      value: { metric },
      scenario: {
        id: fixture.id,
        kind: "extraction",
        observations: {
          checkpointDerivedOnly: true,
          expectedKeys: fixture.expectedMemories.map((memory) => memory.logicalKey).sort(),
          matchedKeys: matchedKeys.sort(),
          missingKeys: missingKeys.sort(),
          unexpectedPredictions: unexpected,
          negativeEvidenceCount: fixture.negativeEvidence.length
        }
      },
      failures
    };
  } finally {
    await memorySpace.close();
  }
}

export async function evaluateRetrievalQueries(
  memorySpace: Pick<MemorySpace, "search">,
  spaceId: string,
  index: LogicalMemoryIndex,
  queries: readonly RetrievalQueryFixture[],
  ks: readonly number[]
): Promise<RetrievalQueryResult[]> {
  const results: RetrievalQueryResult[] = [];
  for (const query of queries) {
    const filters: Pick<
      MemorySearchInput,
      "families" | "types" | "tiers" | "statuses"
    > = {
      families: query.families,
      types: query.types,
      tiers: query.tiers,
      statuses: query.statuses
    };
    const eligibleCorpus = await memorySpace.search({
      spaceId,
      query: "",
      ...filters,
      limit: 100
    });
    const returned = await memorySpace.search({
      spaceId,
      query: query.query,
      ...filters,
      limit: 100
    });
    const returnedKeys = returned.map((item) =>
      index.logicalKey(item.memory.id) ?? stableUnknown(item.memory)
    );
    const classification = query.relevantMemoryKeys.length > 0 ? "positive" : "negative";
    const eligibleKs = classification === "positive"
      ? eligibleRetrievalKs(ks, eligibleCorpus.length)
      : [];
    results.push({
      id: query.id,
      query: query.query,
      classification,
      expected: [...query.relevantMemoryKeys].sort(),
      returned: returnedKeys,
      returnedCount: returnedKeys.length,
      eligibleCorpusSize: eligibleCorpus.length,
      atK: eligibleKs.map((k) => retrievalAtK(query.relevantMemoryKeys, returnedKeys, k)),
      note: query.note
    });
  }
  return results;
}

function retrievalFailures(
  scenario: string,
  results: readonly RetrievalQueryResult[]
): QualityFailureExample[] {
  const failures: QualityFailureExample[] = [];
  for (const result of results) {
    if (result.classification === "negative") {
      if (result.returnedCount > 0) {
        failures.push(fail(
          `${scenario}:${result.id}`,
          "negative-query-false-positive",
          "no active result",
          result.returned,
          result.note
        ));
      }
      continue;
    }
    const metric = result.atK.find((item) => item.k === 3) ?? result.atK[0];
    if (!metric) {
      failures.push(fail(
        `${scenario}:${result.id}`,
        "retrieval-eligible-corpus",
        "at least one meaningful K",
        { eligibleCorpusSize: result.eligibleCorpusSize },
        result.note
      ));
      continue;
    }
    const observed = result.returned.slice(0, metric.k);
    const missing = result.expected.filter((key) => !observed.includes(key));
    if (missing.length > 0) {
      failures.push(fail(
        `${scenario}:${result.id}`,
        `Recall@${metric.k}`,
        result.expected,
        observed,
        result.note
      ));
    }
  }
  return failures;
}

async function runRetrievalScenario(
  root: string,
  fixtures: QualityFixtureBundle
): Promise<ScenarioOutput<RetrievalOutput>> {
  const fixture = fixtures.retrieval;
  const memorySpace = createQualityRetrievalMemorySpace(join(root, "retrieval.db"));
  try {
    const space = await memorySpace.createSpace({ id: "quality-retrieval", name: fixture.id });
    const session = await memorySpace.createSession({
      id: "quality-retrieval-session",
      spaceId: space.id,
      agentId: "quality-eval"
    });
    const index = new LogicalMemoryIndex();
    for (const groundTruth of fixture.memories) {
      const memory = await memorySpace.remember({
        spaceId: space.id,
        sourceSessionId: session.id,
        family: groundTruth.family,
        type: groundTruth.type,
        key: groundTruth.key,
        content: groundTruth.content
      });
      index.register(groundTruth.logicalKey, memory);
    }
    const queryResults = await evaluateRetrievalQueries(
      memorySpace,
      space.id,
      index,
      fixture.queries,
      fixture.ks
    );
    return {
      value: { queryResults },
      scenario: {
        id: fixture.id,
        kind: "retrieval",
        observations: {
          corpusSize: fixture.memories.length,
          rankingOrder: "preserved exactly as returned by MemorySpace.search",
          queries: queryResults
        }
      },
      failures: retrievalFailures(fixture.id, queryResults)
    };
  } finally {
    await memorySpace.close();
  }
}

function handoffFacts(snapshot: HandoffSnapshot): string[] {
  return sorted([
    ...(snapshot.goal ? [`goal:${snapshot.goal}`] : []),
    ...snapshot.completed.map((value) => `completed:${value}`),
    ...snapshot.activeTasks.map((value) => `activeTasks:${value}`),
    ...snapshot.decisions.map((value) => `decisions:${value}`),
    ...snapshot.blockers.map((value) => `blockers:${value}`),
    ...snapshot.openQuestions.map((value) => `openQuestions:${value}`),
    ...snapshot.nextSteps.map((value) => `nextSteps:${value}`)
  ]);
}

function expectedHandoffFacts(fixture: QualityFixtureBundle["handoff"]): string[] {
  const expected = fixture.expected;
  return sorted([
    ...(expected.goal ? [`goal:${expected.goal}`] : []),
    ...expected.completed.map((value) => `completed:${value}`),
    ...expected.activeTasks.map((value) => `activeTasks:${value}`),
    ...expected.decisions.map((value) => `decisions:${value}`),
    ...expected.blockers.map((value) => `blockers:${value}`),
    ...expected.openQuestions.map((value) => `openQuestions:${value}`),
    ...expected.nextSteps.map((value) => `nextSteps:${value}`)
  ]);
}

async function runLongHorizonScenario(
  root: string,
  fixtures: QualityFixtureBundle,
  ks: readonly number[]
): Promise<ScenarioOutput<LongHorizonOutput>> {
  const fixture = fixtures.longHorizon;
  const memorySpace = createQualityRetrievalMemorySpace(join(root, "long-horizon.db"));
  const index = new LogicalMemoryIndex();
  const truthByKey = new Map<string, GroundTruthMemory>();
  const failures: QualityFailureExample[] = [];
  let finalSessionId = "";
  try {
    const space = await memorySpace.createSpace({ id: fixture.spaceId, name: fixture.id });
    for (const step of fixture.steps) {
      const session = await memorySpace.createSession({
        id: `quality-${step.id.toLowerCase()}`,
        spaceId: space.id,
        agentId: `quality-agent-${step.id.toLowerCase()}`
      });
      finalSessionId = session.id;

      for (const change of step.statusChanges ?? []) {
        const runtimeId = index.runtimeId(change.logicalKey);
        if (!runtimeId) {
          failures.push(fail(
            `${fixture.id}:${step.id}`,
            "status-transition",
            change.logicalKey,
            "logical Memory not found",
            change.reason
          ));
          continue;
        }
        await memorySpace.setMemoryStatus(runtimeId, change.status, { reason: change.reason });
      }

      for (const explicit of step.explicitMemories ?? []) {
        registerTruth(truthByKey, explicit);
        let memory = await memorySpace.remember({
          spaceId: space.id,
          sourceSessionId: session.id,
          family: explicit.family,
          type: explicit.type,
          key: explicit.key,
          content: explicit.content,
          data: explicit.data
        });
        if (explicit.promote) {
          memory = await memorySpace.promote(memory.id, {
            actor: "user",
            reason: "Quality fixture marks this as canonical project context."
          });
        }
        index.register(explicit.logicalKey, memory);
      }

      if ((step.events?.length ?? 0) > 0) {
        const event = await memorySpace.appendEvent({
          id: `quality-${step.id.toLowerCase()}-event`,
          sessionId: session.id,
          type: "message",
          payload: { text: step.events!.join("\n") }
        });
        await memorySpace.checkpoint({
          sessionId: session.id,
          toEventId: event.id,
          idempotencyKey: `quality-${step.id.toLowerCase()}`
        });
        const memories = await allMemories(memorySpace, space.id);
        for (const expected of step.expectedExtracted ?? []) {
          registerTruth(truthByKey, expected);
          const memory = findExpected(memories, expected);
          if (memory) {
            index.register(expected.logicalKey, memory);
          } else {
            failures.push(fail(
              `${fixture.id}:${step.id}`,
              "long-horizon-extraction",
              expected.logicalKey,
              "not extracted",
              expected.rationale
            ));
          }
        }
      }
    }

    const memories = await allMemories(memorySpace, space.id);
    const active = memories.filter((memory) => memory.status === "active");
    const activeIds = new Set(active.map((memory) => memory.id));
    const activeKeys = active.map((memory) => index.logicalKey(memory.id) ?? stableUnknown(memory));
    const activeCore = active.filter((memory) => memory.tier === "core");
    const activeCoreKeys = activeCore.map(
      (memory) => index.logicalKey(memory.id) ?? stableUnknown(memory)
    );
    const pollutedKeys = sorted(activeCoreKeys.filter((logicalKey) =>
      truthByKey.get(logicalKey)?.shouldBeCore !== true
    ));
    const corePollution = pollutionRate(activeCoreKeys, pollutedKeys);
    for (const logicalKey of pollutedKeys) {
      failures.push(fail(
        fixture.id,
        "core-pollution",
        "not active Core",
        logicalKey,
        truthByKey.get(logicalKey)?.rationale ?? "No Core ground truth exists."
      ));
    }

    const bootstrap = await memorySpace.bootstrap(space.id);
    const coveredCritical = fixture.criticalBootstrapKeys.filter((logicalKey) => {
      const groundTruth = truthByKey.get(logicalKey);
      return groundTruth !== undefined && bootstrap.context.includes(groundTruth.content);
    });
    const missingCriticalKeys = fixture.criticalBootstrapKeys
      .filter((logicalKey) => !coveredCritical.includes(logicalKey))
      .sort();
    for (const logicalKey of missingCriticalKeys) {
      failures.push(fail(
        fixture.id,
        "bootstrap-critical-coverage",
        logicalKey,
        "missing",
        truthByKey.get(logicalKey)?.rationale ?? "Critical fixture key was not registered."
      ));
    }

    const handoff = await memorySpace.getLatestHandoff(space.id);
    const expectedFacts = expectedHandoffFacts(fixtures.handoff);
    const observedFacts = handoffFacts(handoff);
    const handoffScore = setCompleteness(expectedFacts, observedFacts);
    for (const missingFact of handoffScore.missing) {
      failures.push(fail(
        fixture.id,
        "handoff-completeness",
        missingFact,
        "missing",
        "Latest committed Handoff omitted a fixture-declared continuation fact."
      ));
    }

    const staleKeys = new Set<string>();
    for (const expected of fixtures.supersession.expectedInactive) {
      const runtimeId = index.runtimeId(expected.logicalKey);
      if (runtimeId && activeIds.has(runtimeId)) staleKeys.add(expected.logicalKey);
    }
    for (const slot of fixtures.supersession.currentSlots) {
      for (const memory of active) {
        if (slot.staleContents.some((content) => memory.content.includes(content))) {
          staleKeys.add(index.logicalKey(memory.id) ?? stableUnknown(memory));
        }
      }
    }
    const stale = staleRate(activeKeys, [...staleKeys]);
    for (const logicalKey of sorted(staleKeys)) {
      failures.push(fail(
        fixture.id,
        "stale-memory",
        "inactive or superseded",
        logicalKey,
        "Fixture marks this Memory as no longer current."
      ));
    }

    let duplicateMembers = 0;
    let avoidableDuplicates = 0;
    const duplicateGroups = fixture.duplicateGroups.map((group) => {
      const memberIds = new Set(group.memberKeys
        .map((logicalKey) => index.runtimeId(logicalKey))
        .filter((id): id is string => id !== undefined && activeIds.has(id)));
      const activeMembers = sorted([...memberIds].map((id) =>
        index.logicalKey(id) ?? `unmapped-runtime-member`
      ));
      const avoidable = Math.max(0, memberIds.size - group.expectedCanonicalCount);
      duplicateMembers += memberIds.size;
      avoidableDuplicates += avoidable;
      if (avoidable > 0) {
        failures.push(fail(
          fixture.id,
          "duplicate-memory",
          { group: group.id, canonicalCount: group.expectedCanonicalCount },
          activeMembers,
          group.note
        ));
      }
      return {
        id: group.id,
        activeMembers,
        avoidableDuplicates: avoidable,
        note: group.note
      };
    });
    const duplicate = duplicateRate(avoidableDuplicates, duplicateMembers);

    const contradictionChecks: MemoryQualityReport["summary"]["contradiction"]["checks"] = [];
    for (const slot of fixtures.supersession.currentSlots) {
      const currentId = index.runtimeId(slot.currentLogicalKey);
      const currentTruth = truthByKey.get(slot.currentLogicalKey);
      const currentActive = currentId !== undefined && activeIds.has(currentId);
      const staleActive = active.some((memory) =>
        slot.staleContents.some((content) => memory.content.includes(content))
      );
      contradictionChecks.push(
        { id: `${slot.id}.current-active`, kind: "hard", passed: currentActive },
        { id: `${slot.id}.stale-not-active`, kind: "hard", passed: !staleActive },
        {
          id: `${slot.id}.bootstrap-current`,
          kind: "hard",
          passed: currentTruth !== undefined && bootstrap.context.includes(currentTruth.content)
        },
        {
          id: `${slot.id}.bootstrap-no-stale`,
          kind: "hard",
          passed: slot.staleContents.every((content) => !bootstrap.context.includes(content))
        }
      );
      const search = await memorySpace.search({
        spaceId: space.id,
        query: slot.searchQuery,
        statuses: ["active"],
        limit: 10
      });
      contradictionChecks.push({
        id: `${slot.id}.search-current-first`,
        kind: "quality",
        passed: currentId !== undefined && search[0]?.memory.id === currentId
      });
    }
    for (const check of contradictionChecks.filter((item) => !item.passed)) {
      failures.push(fail(
        fixture.id,
        `contradiction-${check.kind}`,
        check.id,
        "failed",
        check.kind === "hard"
          ? "A frozen keyed-current-state invariant failed."
          : "Current lexical ranking did not prefer the intended current state."
      ));
    }

    const queryResults = await evaluateRetrievalQueries(
      memorySpace,
      space.id,
      index,
      fixture.finalQueries,
      ks
    );
    failures.push(...retrievalFailures(fixture.id, queryResults));

    const finalSession = await memorySpace.getSession(finalSessionId);
    const inactiveExcluded = fixtures.supersession.expectedInactive.every((expected) => {
      const runtimeId = index.runtimeId(expected.logicalKey);
      return runtimeId === undefined
        || !bootstrap.coreMemories.some((memory) => memory.id === runtimeId);
    });
    const correctness: CorrectnessCheck[] = [
      {
        id: "long-horizon.latest-handoff-boundary",
        status: handoff.sessionId === finalSession.id
          && finalSession.latestHandoffSnapshotId === handoff.id ? "pass" : "fail",
        detail: "Latest Handoff belongs to the final committed S20 Session boundary."
      },
      {
        id: "long-horizon.inactive-excluded-from-bootstrap",
        status: inactiveExcluded ? "pass" : "fail",
        detail: "Resolved fixture Memory is absent from active Core; completed-task Handoff history remains allowed."
      },
      ...contradictionChecks.filter((check) => check.kind === "hard").map((check) => ({
        id: `long-horizon.${check.id}`,
        status: check.passed ? "pass" as const : "fail" as const,
        detail: "Keyed current state and stale-state exclusion remain correct."
      }))
    ];

    const summary: MemoryQualityReport["summary"] = {
      extraction: extractionMetric(0, 0, 0),
      retrieval: [],
      negativeRetrieval: aggregateNegativeRetrieval([]),
      corePollution: { ...corePollution, pollutedKeys },
      bootstrap: {
        criticalCoverage: countedRatio(
          coveredCritical.length,
          fixture.criticalBootstrapKeys.length,
          1
        ),
        missingCriticalKeys,
        unexpectedDefaultKeys: pollutedKeys,
        coreItemCount: bootstrap.coreMemories.length,
        handoffFactCount: observedFacts.length,
        chars: bootstrap.context.length,
        bytes: Buffer.byteLength(bootstrap.context, "utf8")
      },
      handoff: {
        numerator: handoffScore.numerator,
        denominator: handoffScore.denominator,
        value: handoffScore.value,
        missingFacts: handoffScore.missing,
        unexpectedFacts: handoffScore.unexpected
      },
      staleMemory: {
        ...stale,
        staleKeys: sorted(staleKeys)
      },
      duplicateMemory: {
        ...duplicate,
        groups: duplicateGroups
      },
      contradiction: {
        ...countedRatio(
          contradictionChecks.filter((check) => check.passed).length,
          contradictionChecks.length,
          1
        ),
        checks: contradictionChecks
      },
      longHorizonSessions: fixture.steps.length
    };
    return {
      value: { summary, queryResults, correctness },
      scenario: {
        id: fixture.id,
        kind: "long-horizon",
        observations: {
          sessionCount: fixture.steps.length,
          activeMemoryKeys: sorted(activeKeys),
          activeCoreKeys: sorted(activeCoreKeys),
          finalQueries: queryResults
        }
      },
      failures
    };
  } finally {
    await memorySpace.close();
  }
}

function bindProject(project: string, spaceId: string): void {
  const directory = join(project, ".memory-space");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ version: 1, spaceId }));
}

async function runProviderProof(
  root: string
): Promise<ScenarioOutput<{ correctness: CorrectnessCheck[] }>> {
  const project = join(root, "provider-proof-project");
  mkdirSync(project, { recursive: true });
  const memorySpace = createDefaultMemorySpace({ databasePath: join(root, "provider-proof.db") });
  const correctness: CorrectnessCheck[] = [];
  const failures: QualityFailureExample[] = [];
  let client: Client | undefined;
  let server: ReturnType<typeof createMemoryMcpServer> | undefined;
  try {
    const spaceA = await memorySpace.createSpace({ id: "quality-provider-a", name: "Provider A" });
    const spaceB = await memorySpace.createSpace({ id: "quality-provider-b", name: "Provider B" });
    bindProject(project, spaceA.id);
    const lifecycle = new LifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver: new ProviderSessionResolver(memorySpace),
      checkpointPolicy: new CheckpointPolicy(memorySpace)
    });
    const codex = new CodexAdapter();
    const claude = new ClaudeAdapter();
    const codexSessionId = "quality-codex-session";
    const claudeSessionId = "quality-claude-session";
    const codexStart = codex.normalizeEvent({
      hook_event_name: "SessionStart",
      session_id: codexSessionId,
      cwd: project,
      source: "startup"
    });
    if (!codexStart) throw new Error("Codex quality SessionStart did not normalize");
    const started = await lifecycle.handle(codexStart);
    if (started.type !== "session_start") throw new Error("Codex quality SessionStart failed");
    const codexPrompt = codex.normalizeEvent({
      hook_event_name: "UserPromptSubmit",
      session_id: codexSessionId,
      cwd: project,
      turn_id: "quality-turn-1",
      prompt: "Decision: Provider-neutral quality evidence survives handoff."
    });
    if (!codexPrompt) throw new Error("Codex quality prompt did not normalize");
    await lifecycle.handle(codexPrompt);
    const codexEnd = codex.normalizeEvent({
      hook_event_name: "SessionEnd",
      session_id: codexSessionId,
      cwd: project,
      reason: "other"
    });
    if (!codexEnd) throw new Error("Codex quality SessionEnd did not normalize");
    await lifecycle.handle(codexEnd);

    const sourceMemory = (await memorySpace.search({
      spaceId: spaceA.id,
      query: "provider-neutral quality evidence",
      limit: 10
    }))[0]?.memory;
    const claudeStart = claude.normalizeEvent({
      hook_event_name: "SessionStart",
      session_id: claudeSessionId,
      transcript_path: join(project, ".claude", "quality.jsonl"),
      cwd: project,
      source: "startup"
    });
    if (!claudeStart) throw new Error("Claude quality SessionStart did not normalize");
    const target = await lifecycle.handle(claudeStart);
    if (target.type !== "session_start") throw new Error("Claude quality SessionStart failed");
    correctness.push({
      id: "provider.codex-to-claude-bootstrap",
      status: target.bootstrap.context.includes("Provider-neutral quality evidence survives handoff.")
        ? "pass" : "fail",
      detail: "Codex-created checkpoint evidence appears in a distinct Claude Session bootstrap."
    });

    const gateway = new MemoryMcpGateway({ memorySpace });
    const recalled = await gateway.search({
      sessionId: target.session.id,
      query: "provider-neutral quality evidence",
      limit: 10
    });
    const recalledMemory = sourceMemory
      ? await memorySpace.getMemory(sourceMemory.id)
      : undefined;
    correctness.push({
      id: "provider.provenance-preserved",
      status: sourceMemory !== undefined
        && recalled.results.some((result) => result.id === sourceMemory.id)
        && recalledMemory?.sourceSessionId === started.session.id ? "pass" : "fail",
      detail: "Cross-provider recall preserves the source Codex Session provenance."
    });

    const spaceBSession = await memorySpace.createSession({
      id: "quality-space-b-session",
      spaceId: spaceB.id
    });
    const isolated = await gateway.search({
      sessionId: spaceBSession.id,
      query: "provider-neutral quality evidence",
      limit: 10
    });
    correctness.push({
      id: "provider.cross-space-isolation",
      status: isolated.results.length === 0 ? "pass" : "fail",
      detail: "Space B cannot retrieve Space A provider evidence."
    });

    const inactive = await memorySpace.remember({
      spaceId: spaceA.id,
      sourceSessionId: started.session.id,
      family: "knowledge",
      type: "decision",
      key: "quality.inactive",
      content: "Inactive quality sentinel must not bootstrap."
    });
    await memorySpace.promote(inactive.id, { actor: "user" });
    await memorySpace.setMemoryStatus(inactive.id, "archived");
    correctness.push({
      id: "provider.inactive-bootstrap-exclusion",
      status: !(await memorySpace.bootstrap(spaceA.id)).context.includes(inactive.content)
        ? "pass" : "fail",
      detail: "Archived former-Core Memory remains absent from bootstrap."
    });

    server = createMemoryMcpServer({ memorySpace });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "memory-space-quality-eval", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    correctness.push({
      id: "provider.exact-six-mcp",
      status: JSON.stringify(tools) === JSON.stringify([...exactMcpTools].sort())
        ? "pass" : "fail",
      detail: "Quality eval observes the unchanged exact shared six-tool MCP surface."
    });

    return {
      value: { correctness },
      scenario: {
        id: "codex-to-claude-provider-neutral-quality-proof",
        kind: "provider-proof",
        observations: {
          sourceProvider: "codex",
          targetProvider: "claude-code",
          sameSpace: true,
          exactMcpToolCount: tools.length
        }
      },
      failures
    };
  } finally {
    await Promise.allSettled([client?.close(), server?.close()]);
    await memorySpace.close();
  }
}

function stableFailures(failures: QualityFailureExample[]): QualityFailureExample[] {
  return failures.sort((left, right) => left.scenario.localeCompare(right.scenario)
    || left.metric.localeCompare(right.metric)
    || JSON.stringify(left.expected).localeCompare(JSON.stringify(right.expected)));
}

export async function runMemoryQualityEval(
  providedFixtures?: QualityFixtureBundle
): Promise<MemoryQualityReport> {
  const fixtures = providedFixtures ?? await loadQualityFixtures();
  const root = mkdtempSync(join(tmpdir(), "memory-space-quality-eval-"));
  try {
    const extraction = await runExtractionScenario(root, fixtures);
    const retrieval = await runRetrievalScenario(root, fixtures);
    const longHorizon = await runLongHorizonScenario(
      root,
      fixtures,
      fixtures.retrieval.ks
    );
    const provider = await runProviderProof(root);
    const queryResults = [
      ...retrieval.value.queryResults,
      ...longHorizon.value.queryResults
    ];
    const correctnessChecks = [
      ...longHorizon.value.correctness,
      ...provider.value.correctness
    ];
    const summary: MemoryQualityReport["summary"] = {
      ...longHorizon.value.summary,
      extraction: extraction.value.metric,
      retrieval: aggregateRetrieval(queryResults, fixtures.retrieval.ks),
      negativeRetrieval: aggregateNegativeRetrieval(queryResults)
    };
    return {
      version: 1,
      summary,
      correctness: {
        overall: correctnessChecks.every((check) => check.status === "pass") ? "pass" : "fail",
        checks: correctnessChecks
      },
      scenarios: [
        extraction.scenario,
        retrieval.scenario,
        longHorizon.scenario,
        provider.scenario
      ],
      failures: stableFailures([
        ...extraction.failures,
        ...retrieval.failures,
        ...longHorizon.failures,
        ...provider.failures
      ])
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
