import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySpace,
  NoopCache,
  NoopExtractor,
  SqliteMemoryStore,
  createDefaultMemorySpace,
  type HandoffSnapshot,
  type Memory,
  type MemoryCandidate,
  type MemoryExtractor,
  type MemoryHistoryRecord,
  type SessionEvent
} from "../../src/index.ts";
import type { B3PolicyCheck, B3PolicyEvaluationReport } from "./core-handoff-comparison.ts";
import {
  hasEffectiveExplicitPromotion,
  promotionProvenanceFromOperation
} from "../../src/application/core-admission-policy.ts";

type CandidateInput = Omit<MemoryCandidate, "sourceEventIds">;

function candidate(input: Partial<CandidateInput> & Pick<CandidateInput, "type" | "content">): CandidateInput {
  return {
    family: input.family ?? "state",
    type: input.type,
    ...(input.key === undefined ? {} : { key: input.key }),
    content: input.content,
    ...(input.data === undefined ? {} : { data: input.data }),
    confidence: input.confidence ?? 1,
    importance: input.importance ?? 0.5,
    recommendedTier: input.recommendedTier ?? "core",
    ...(input.promoteReason === undefined
      ? { promoteReason: "Required across Sessions" }
      : input.promoteReason === ""
        ? {}
        : { promoteReason: input.promoteReason }),
    operation: input.operation ?? "create",
    ...(input.targetMemoryId === undefined ? {} : { targetMemoryId: input.targetMemoryId })
  };
}

class QueueExtractor implements MemoryExtractor {
  readonly #queue: CandidateInput[][] = [];

  enqueue(candidates: CandidateInput[]): void {
    this.#queue.push(candidates);
  }

  async extract(events: SessionEvent[]): Promise<MemoryCandidate[]> {
    const candidates = this.#queue.shift() ?? [];
    const sourceEventIds = [events.at(-1)!.id];
    return candidates.map((value) => ({ ...value, sourceEventIds }));
  }
}

class PolicyHarness {
  readonly extractor = new QueueExtractor();
  readonly memorySpace = createDefaultMemorySpace({ extractor: this.extractor });
  spaceId = "";
  sessionId = "";
  #sequence = 0;

  async open(label: string): Promise<this> {
    const space = await this.memorySpace.createSpace({ name: `B3 ${label}` });
    const session = await this.memorySpace.createSession({
      spaceId: space.id,
      agentId: "b3-eval-agent"
    });
    this.spaceId = space.id;
    this.sessionId = session.id;
    return this;
  }

  async checkpoint(candidates: CandidateInput[], label = "policy evidence"): Promise<HandoffSnapshot> {
    this.#sequence += 1;
    this.extractor.enqueue(candidates);
    const event = await this.memorySpace.appendEvent({
      sessionId: this.sessionId,
      type: "message",
      payload: { content: label }
    });
    await this.memorySpace.checkpoint({
      sessionId: this.sessionId,
      toEventId: event.id,
      idempotencyKey: `b3-${this.#sequence}`
    });
    return this.memorySpace.getLatestHandoff(this.spaceId);
  }

  async keyed(key: string): Promise<Memory> {
    const memory = await this.memorySpace.store.findActiveMemoryByKey(this.spaceId, key);
    if (!memory) throw new Error(`Expected active Memory ${key}`);
    return memory;
  }

  async close(): Promise<void> {
    await this.memorySpace.close();
  }
}

function check(id: string, passed: boolean, detail: string): B3PolicyCheck {
  return { id, status: passed ? "pass" : "fail", detail };
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function operation(history: readonly MemoryHistoryRecord[], expected: string): boolean {
  return history.some((entry) => entry.operation === expected);
}

async function singleCandidate(
  id: string,
  input: CandidateInput,
  verify: (memory: Memory, handoff: HandoffSnapshot) => boolean
): Promise<B3PolicyCheck> {
  const harness = await new PolicyHarness().open(id);
  try {
    const handoff = await harness.checkpoint([input], id);
    const memories = await harness.memorySpace.store.listMemories({ spaceId: harness.spaceId });
    return check(id, memories.length === 1 && verify(memories[0]!, handoff), `${id} policy outcome`);
  } finally {
    await harness.close();
  }
}

interface SeededUpgradeResult {
  openPreserved: boolean;
  bootstrapPreserved: boolean;
  checkpointPreservedTier: boolean;
  checkpointExcludedHandoff: boolean;
  oldHandoffImmutable: boolean;
  legacyFailedClosed: boolean;
  trustedDemotionRemovedDisclosure: boolean;
}

async function seededUpgradeEvaluation(): Promise<SeededUpgradeResult> {
  const directory = await mkdtemp(join(tmpdir(), "memory-space-b3-upgrade-"));
  const databasePath = join(directory, "memory.db");
  const createdAt = "2026-08-17T00:00:00.000Z";
  const memoryId = "legacy-cleanup-memory";
  const handoffId = "legacy-handoff";
  try {
    const seedStore = new SqliteMemoryStore(databasePath);
    const seed = new MemorySpace({ store: seedStore, extractor: new NoopExtractor(), cache: new NoopCache() });
    const space = await seed.createSpace({ id: "legacy-space", name: "Legacy B2" });
    const session = await seed.createSession({ id: "legacy-session", spaceId: space.id });
    const event = await seed.appendEvent({
      id: "legacy-event",
      sessionId: session.id,
      type: "message",
      payload: { content: "legacy seed" },
      createdAt
    });
    const memory: Memory = {
      id: memoryId,
      spaceId: space.id,
      family: "state",
      type: "task",
      key: "task.temporary-debug-cleanup",
      content: "Remove the temporary debug log after this run.",
      data: { nextStep: "Remove the temporary debug log after this run." },
      tier: "core",
      status: "active",
      importance: 0.5,
      confidence: 1,
      version: 2,
      sourceSessionId: session.id,
      createdAt,
      updatedAt: createdAt
    };
    await seedStore.insertMemory(memory);
    await seedStore.addMemoryHistory({
      memoryId,
      operation: "create",
      after: { ...memory, tier: "indexed", version: 1 },
      sourceEventIds: [event.id],
      createdAt
    });
    await seedStore.addMemoryHistory({
      memoryId,
      operation: "promote",
      before: { ...memory, tier: "indexed", version: 1 },
      after: memory,
      reason: "legacy ambiguous promotion",
      sourceEventIds: [],
      createdAt
    });
    await seedStore.insertCheckpoint({
      id: "legacy-checkpoint",
      spaceId: space.id,
      sessionId: session.id,
      toEventId: event.id,
      idempotencyKey: "legacy-checkpoint",
      status: "completed",
      handoffSnapshotId: handoffId,
      createdAt,
      completedAt: createdAt
    });
    await seedStore.insertHandoff({
      id: handoffId,
      spaceId: space.id,
      sessionId: session.id,
      checkpointId: "legacy-checkpoint",
      completed: [],
      activeTasks: [memory.content],
      decisions: [],
      blockers: [],
      openQuestions: [],
      nextSteps: [memory.content],
      createdAt
    });
    await seed.close();

    const current = createDefaultMemorySpace({ databasePath, extractor: new NoopExtractor() });
    const beforeMemory = await current.getMemory(memoryId);
    const beforeHistory = await current.getMemoryHistory(memoryId);
    const beforeHandoff = await current.getLatestHandoff(space.id);
    const bootstrap = await current.bootstrap(space.id);
    const afterBootstrapMemory = await current.getMemory(memoryId);
    const afterBootstrapHistory = await current.getMemoryHistory(memoryId);
    const nextEvent = await current.appendEvent({
      sessionId: session.id,
      type: "message",
      payload: { content: "No matching Memory evidence." }
    });
    await current.checkpoint({
      sessionId: session.id,
      toEventId: nextEvent.id,
      idempotencyKey: "first-b3-checkpoint"
    });
    const afterCheckpointMemory = await current.getMemory(memoryId);
    const afterCheckpointHistory = await current.getMemoryHistory(memoryId);
    const newHandoff = await current.getLatestHandoff(space.id);
    const storedOldHandoff = await current.getHandoff(handoffId);
    const demoted = await current.demote(memoryId, { reason: "trusted cleanup completion" });
    const finalEvent = await current.appendEvent({
      sessionId: session.id,
      type: "message",
      payload: { content: "After demotion." }
    });
    await current.checkpoint({
      sessionId: session.id,
      toEventId: finalEvent.id,
      idempotencyKey: "post-demotion-checkpoint"
    });
    const finalHandoff = await current.getLatestHandoff(space.id);
    const finalBootstrap = await current.bootstrap(space.id);
    await current.close();

    const historyUnchanged = JSON.stringify(beforeHistory) === JSON.stringify(afterBootstrapHistory);
    return {
      openPreserved: beforeMemory.tier === "core" && beforeMemory.version === 2
        && beforeHistory.map((item) => item.operation).join(",") === "create,promote"
        && beforeHandoff.id === handoffId,
      bootstrapPreserved: bootstrap.coreMemories.some((item) => item.id === memoryId)
        && afterBootstrapMemory.tier === "core" && afterBootstrapMemory.version === 2
        && historyUnchanged,
      checkpointPreservedTier: afterCheckpointMemory.tier === "core"
        && afterCheckpointMemory.version === 2
        && JSON.stringify(afterCheckpointHistory) === JSON.stringify(beforeHistory),
      checkpointExcludedHandoff: !includes(newHandoff.activeTasks, memory.content)
        && !includes(newHandoff.nextSteps, memory.content),
      oldHandoffImmutable: JSON.stringify(storedOldHandoff) === JSON.stringify(beforeHandoff),
      legacyFailedClosed: !includes(newHandoff.activeTasks, memory.content),
      trustedDemotionRemovedDisclosure: demoted.tier === "indexed"
        && !includes(finalHandoff.activeTasks, memory.content)
        && !finalBootstrap.coreMemories.some((item) => item.id === memoryId)
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface SeededWorkingStateInput {
  id: "H1" | "H2" | "H3" | "H4";
  type: "blocker" | "question";
  content: string;
  promotionOperation: "promote" | "promote:explicit-agent" | "promote:explicit-user";
  expectedIncluded: boolean;
}

async function seededWorkingStateProvenanceCase(
  input: SeededWorkingStateInput
): Promise<B3PolicyCheck> {
  const directory = await mkdtemp(join(tmpdir(), `memory-space-b3-${input.id.toLowerCase()}-`));
  const databasePath = join(directory, "memory.db");
  const createdAt = "2026-08-17T00:00:00.000Z";
  const memoryId = `${input.id.toLowerCase()}-${input.type}`;
  const handoffId = `${input.id.toLowerCase()}-legacy-handoff`;
  const decisionContent = `Unrelated durable decision for ${input.id}.`;
  const expectedProvenance = input.promotionOperation === "promote:explicit-agent"
    ? "EXPLICIT_AGENT"
    : input.promotionOperation === "promote:explicit-user"
      ? "EXPLICIT_USER"
      : "AMBIGUOUS_LEGACY";
  try {
    const seedStore = new SqliteMemoryStore(databasePath);
    const seed = new MemorySpace({
      store: seedStore,
      extractor: new NoopExtractor(),
      cache: new NoopCache()
    });
    const space = await seed.createSpace({ id: `${input.id.toLowerCase()}-space`, name: input.id });
    const session = await seed.createSession({
      id: `${input.id.toLowerCase()}-session`,
      spaceId: space.id
    });
    const event = await seed.appendEvent({
      id: `${input.id.toLowerCase()}-event`,
      sessionId: session.id,
      type: "message",
      payload: { content: `${input.id} legacy seed` },
      createdAt
    });
    const memory: Memory = {
      id: memoryId,
      spaceId: space.id,
      family: "state",
      type: input.type,
      key: `operation.${input.type}.${input.id.toLowerCase()}`,
      content: input.content,
      data: { nextSteps: [`${input.id} forbidden next-step injection`] },
      tier: "core",
      status: "active",
      importance: 0.5,
      confidence: 1,
      version: 2,
      sourceSessionId: session.id,
      createdAt,
      updatedAt: createdAt
    };
    const indexed = { ...memory, tier: "indexed" as const, version: 1 };
    const decision: Memory = {
      id: `${input.id.toLowerCase()}-decision`,
      spaceId: space.id,
      family: "knowledge",
      type: "decision",
      key: `decision.${input.id.toLowerCase()}`,
      content: decisionContent,
      tier: "core",
      status: "active",
      importance: 0.5,
      confidence: 1,
      version: 1,
      sourceSessionId: session.id,
      createdAt,
      updatedAt: createdAt
    };
    await seedStore.insertMemory(memory);
    await seedStore.insertMemory(decision);
    await seedStore.addMemoryHistory({
      memoryId,
      operation: "create",
      after: indexed,
      sourceEventIds: [event.id],
      createdAt
    });
    await seedStore.addMemoryHistory({
      memoryId,
      operation: input.promotionOperation,
      before: indexed,
      after: memory,
      sourceEventIds: [],
      createdAt
    });
    await seedStore.insertCheckpoint({
      id: `${input.id.toLowerCase()}-legacy-checkpoint`,
      spaceId: space.id,
      sessionId: session.id,
      toEventId: event.id,
      idempotencyKey: `${input.id.toLowerCase()}-legacy-checkpoint`,
      status: "completed",
      handoffSnapshotId: handoffId,
      createdAt,
      completedAt: createdAt
    });
    await seedStore.insertHandoff({
      id: handoffId,
      spaceId: space.id,
      sessionId: session.id,
      checkpointId: `${input.id.toLowerCase()}-legacy-checkpoint`,
      completed: [],
      activeTasks: [],
      decisions: [decisionContent],
      blockers: input.type === "blocker" ? [input.content] : [],
      openQuestions: input.type === "question" ? [input.content] : [],
      nextSteps: [],
      createdAt
    });
    await seed.close();

    const current = createDefaultMemorySpace({ databasePath, extractor: new NoopExtractor() });
    const beforeMemory = await current.getMemory(memoryId);
    const beforeHistory = await current.getMemoryHistory(memoryId);
    const beforeHandoff = await current.getLatestHandoff(space.id);
    const bootstrap = await current.bootstrap(space.id);
    const afterBootstrapMemory = await current.getMemory(memoryId);
    const afterBootstrapHistory = await current.getMemoryHistory(memoryId);
    const preCheckpointHandoff = await current.getLatestHandoff(space.id);
    const nextEvent = await current.appendEvent({
      sessionId: session.id,
      type: "message",
      payload: { content: `${input.id} no matching Memory evidence` }
    });
    await current.checkpoint({
      sessionId: session.id,
      toEventId: nextEvent.id,
      idempotencyKey: `${input.id.toLowerCase()}-b3-checkpoint`
    });
    const afterCheckpointMemory = await current.getMemory(memoryId);
    const afterCheckpointHistory = await current.getMemoryHistory(memoryId);
    const newHandoff = await current.getLatestHandoff(space.id);
    const storedOldHandoff = await current.getHandoff(handoffId);
    await current.close();

    const namedValues = input.type === "blocker"
      ? newHandoff.blockers
      : newHandoff.openQuestions;
    const otherValues = input.type === "blocker"
      ? newHandoff.openQuestions
      : newHandoff.blockers;
    const expectedCount = input.expectedIncluded ? 1 : 0;
    const statePreserved = JSON.stringify(afterBootstrapMemory) === JSON.stringify(beforeMemory)
      && JSON.stringify(afterCheckpointMemory) === JSON.stringify(beforeMemory)
      && afterCheckpointMemory.tier === "core"
      && afterCheckpointMemory.version === 2
      && bootstrap.coreMemories.some((item) => item.id === memoryId);
    const historyPreserved = JSON.stringify(afterBootstrapHistory) === JSON.stringify(beforeHistory)
      && JSON.stringify(afterCheckpointHistory) === JSON.stringify(beforeHistory);
    const oldHandoffPreserved = JSON.stringify(preCheckpointHandoff) === JSON.stringify(beforeHandoff)
      && JSON.stringify(storedOldHandoff) === JSON.stringify(beforeHandoff);
    const projectionCorrect = namedValues.filter((value) => value === input.content).length
      === expectedCount;
    const unrelatedFieldsPreserved = newHandoff.id !== handoffId
      && JSON.stringify(newHandoff.decisions) === JSON.stringify([decisionContent])
      && newHandoff.activeTasks.length === 0
      && newHandoff.completed.length === 0
      && otherValues.length === 0
      && newHandoff.nextSteps.length === 0;
    const provenanceCorrect = promotionProvenanceFromOperation(input.promotionOperation)
      === expectedProvenance
      && hasEffectiveExplicitPromotion(memory, beforeHistory) === input.expectedIncluded;

    return check(
      input.id,
      statePreserved
        && historyPreserved
        && oldHandoffPreserved
        && projectionCorrect
        && unrelatedFieldsPreserved
        && provenanceCorrect,
      `${input.type} ${expectedProvenance} projection=${input.expectedIncluded ? "included" : "excluded"}; no-clobber preserved.`
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function seededWorkingStateProvenanceEvaluation(): Promise<B3PolicyCheck[]> {
  const inputs: SeededWorkingStateInput[] = [
    {
      id: "H1",
      type: "blocker",
      content: "This blocker applies only during the current tool call.",
      promotionOperation: "promote",
      expectedIncluded: false
    },
    {
      id: "H2",
      type: "blocker",
      content: "这个阻塞只影响当前这一轮运行。",
      promotionOperation: "promote:explicit-agent",
      expectedIncluded: true
    },
    {
      id: "H3",
      type: "question",
      content: "Which region should be used during this run?",
      promotionOperation: "promote",
      expectedIncluded: false
    },
    {
      id: "H4",
      type: "question",
      content: "本次测试应使用哪个区域？",
      promotionOperation: "promote:explicit-user",
      expectedIncluded: true
    }
  ];
  const results: B3PolicyCheck[] = [];
  for (const input of inputs) results.push(await seededWorkingStateProvenanceCase(input));
  return results;
}

export async function runB3PolicyEvaluation(): Promise<B3PolicyEvaluationReport> {
  const cases: B3PolicyCheck[] = [];
  cases.push(await singleCandidate("C1", candidate({
    type: "goal", key: "project.goal.primary", content: "Ship the durable memory release."
  }), (memory, handoff) => memory.tier === "core" && handoff.goal === memory.content));
  cases.push(await singleCandidate("C2", candidate({
    family: "knowledge", type: "decision", key: "project.database", content: "Use PostgreSQL."
  }), (memory, handoff) => memory.tier === "core" && includes(handoff.decisions, memory.content)));
  cases.push(await singleCandidate("C3", candidate({
    family: "knowledge", type: "constraint", key: "project.constraint.offline", content: "Evaluation must stay offline."
  }), (memory, handoff) => memory.tier === "core"
    && !includes(handoff.decisions, memory.content) && !includes(handoff.activeTasks, memory.content)));
  cases.push(await singleCandidate("C4", candidate({
    family: "knowledge", type: "fact", content: "A low-value durable implementation detail."
  }), (memory, handoff) => memory.tier === "indexed"
    && !includes(handoff.decisions, memory.content) && !includes(handoff.nextSteps, memory.content)));
  cases.push(await singleCandidate("C5", candidate({
    type: "task", key: "task.temporary-debug-cleanup",
    content: "Remove the temporary debug log after this run."
  }), (memory, handoff) => memory.tier === "indexed"
    && !includes(handoff.activeTasks, memory.content) && !includes(handoff.nextSteps, memory.content)));
  cases.push(await singleCandidate("C6", candidate({
    type: "task", key: "task.release-rollout", content: "Complete the cross-Session canary rollout.",
    data: { nextSteps: ["Verify canary health.", "Promote the release."] }
  }), (memory, handoff) => memory.tier === "core"
    && includes(handoff.activeTasks, memory.content)
    && includes(handoff.nextSteps, memory.content)
    && includes(handoff.nextSteps, "Verify canary health.")));

  const resolvedHarness = await new PolicyHarness().open("C7-C12");
  let resolvedCase = false;
  let demotionCase = false;
  try {
    await resolvedHarness.checkpoint([candidate({
      type: "task", key: "task.resolved", content: "Complete the durable migration."
    })]);
    const task = await resolvedHarness.keyed("task.resolved");
    await resolvedHarness.memorySpace.setMemoryStatus(task.id, "resolved", { reason: "done" });
    const handoff = await resolvedHarness.checkpoint([], "post resolution");
    const updated = await resolvedHarness.memorySpace.getMemory(task.id);
    resolvedCase = updated.tier === "indexed" && updated.status === "resolved"
      && includes(handoff.completed, task.content)
      && !includes(handoff.activeTasks, task.content)
      && !includes(handoff.nextSteps, task.content);
    const bootstrap = await resolvedHarness.memorySpace.bootstrap(resolvedHarness.spaceId);
    demotionCase = !bootstrap.coreMemories.some((item) => item.id === task.id);
  } finally {
    await resolvedHarness.close();
  }
  cases.push(check("C7", resolvedCase, "Resolved former-Core task is completed only."));
  cases.push(await singleCandidate("C8", candidate({
    type: "blocker", key: "project.blocker.release", content: "The release is blocked on production credentials."
  }), (memory, handoff) => memory.tier === "core" && includes(handoff.blockers, memory.content)));
  cases.push(await singleCandidate("C9", candidate({
    type: "blocker", key: "operation.blocker.command", content: "This command is blocked during this run."
  }), (memory, handoff) => memory.tier === "indexed" && !includes(handoff.blockers, memory.content)));

  const progressHarness = await new PolicyHarness().open("C10");
  let progressCase = false;
  try {
    const handoff = await progressHarness.checkpoint([
      candidate({ type: "progress", key: "project.progress.current", content: "Migration is 80% complete.", data: { nextStep: "Do not inject progress." } }),
      candidate({ type: "progress", key: "operation.progress.current", content: "This test is complete for this run." }),
      candidate({ type: "progress", content: "The project rollout is underway." })
    ]);
    const all = await progressHarness.memorySpace.store.listMemories({ spaceId: progressHarness.spaceId });
    progressCase = all.find((item) => item.key === "project.progress.current")?.tier === "core"
      && all.find((item) => item.key === "operation.progress.current")?.tier === "indexed"
      && all.find((item) => item.content === "The project rollout is underway.")?.tier === "core"
      && !includes(handoff.completed, "Migration is 80% complete.")
      && !includes(handoff.nextSteps, "Do not inject progress.");
  } finally {
    await progressHarness.close();
  }
  cases.push(check("C10", progressCase, "Progress admission and Handoff source policy."));

  const agentHarness = await new PolicyHarness().open("C11-C16");
  let agentPromotion = false;
  let automaticBounded = false;
  try {
    const remembered = await agentHarness.memorySpace.remember({
      spaceId: agentHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.explicit-agent",
      content: "Remove the generated file after this command.",
      data: { nextStep: "Remove the generated file after this command." }
    });
    automaticBounded = remembered.tier === "indexed";
    const promoted = await agentHarness.memorySpace.promote(remembered.id, {
      actor: "agent",
      reason: "Continue this task across Sessions"
    });
    const handoff = await agentHarness.checkpoint([], "explicit agent continuation");
    const history = await agentHarness.memorySpace.getMemoryHistory(remembered.id);
    agentPromotion = promoted.tier === "core"
      && operation(history, "promote:explicit-agent")
      && includes(handoff.activeTasks, remembered.content)
      && includes(handoff.nextSteps, remembered.content);
  } finally {
    await agentHarness.close();
  }
  cases.push(check("C11", agentPromotion, "Explicit agent promotion keeps validation and capacity gates."));
  cases.push(check("C12", resolvedCase && demotionCase, "Resolution/demotion removes active disclosure."));

  const injectionHarness = await new PolicyHarness().open("C13");
  let injectionCase = false;
  try {
    const taskContent = "Prepare the cross-Session release.";
    const taskNext = "Verify the release candidate.";
    const indexedTask = await injectionHarness.memorySpace.remember({
      spaceId: injectionHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.indexed-injection",
      content: "An Indexed task must not enter Handoff.",
      data: { nextStep: "indexed task injection" }
    });
    const forbidden = [
      "decision injection",
      "constraint injection",
      "fact injection",
      "progress injection",
      "goal injection",
      "blocker injection",
      "question injection",
      "convention injection",
      "rule injection",
      "instruction injection",
      "roadmap injection"
    ];
    const handoff = await injectionHarness.checkpoint([
      candidate({ type: "task", key: "task.release", content: taskContent, data: { nextSteps: [taskNext, "", 7] } }),
      candidate({ family: "knowledge", type: "decision", key: "decision.release", content: "Use canary rollout.", data: { nextStep: forbidden[0] } }),
      candidate({ family: "knowledge", type: "constraint", key: "constraint.release", content: "Keep rollback enabled.", data: { nextSteps: [forbidden[1]] } }),
      candidate({ family: "knowledge", type: "fact", key: "fact.release", content: "Release window is Monday.", data: { nextStep: forbidden[2] } }),
      candidate({ type: "progress", key: "progress.release", content: "Release validation started.", data: { nextStep: forbidden[3] } }),
      candidate({ type: "goal", key: "goal.release", content: "Ship the release.", data: { nextStep: forbidden[4] } }),
      candidate({ type: "blocker", key: "blocker.release", content: "Release credentials are unavailable.", data: { nextStep: forbidden[5] } }),
      candidate({ type: "question", key: "question.release", content: "Which release window is approved?", data: { nextStep: forbidden[6] } }),
      candidate({ family: "knowledge", type: "convention", key: "convention.release", content: "Use semantic versions.", data: { nextStep: forbidden[7] } }),
      candidate({ family: "knowledge", type: "rule", key: "rule.release", content: "Rollback must remain enabled.", data: { nextStep: forbidden[8] } }),
      candidate({ family: "procedure", type: "instruction", key: "instruction.release", content: "Verify the signature before promotion.", data: { nextStep: forbidden[9] } }),
      candidate({ type: "roadmap", key: "roadmap.release", content: "Canary then regional rollout.", data: { nextStep: forbidden[10] } })
    ]);
    injectionCase = includes(handoff.activeTasks, taskContent)
      && includes(handoff.nextSteps, taskContent)
      && includes(handoff.nextSteps, taskNext)
      && indexedTask.tier === "indexed"
      && !includes(handoff.activeTasks, indexedTask.content)
      && !includes(handoff.nextSteps, "indexed task injection")
      && forbidden.every((value) => !includes(handoff.nextSteps, value));
  } finally {
    await injectionHarness.close();
  }
  cases.push(check("C13", injectionCase, "Only an eligible active Core task contributes nextSteps."));

  const seeded = await seededUpgradeEvaluation();
  cases.push(check("C14", Object.values(seeded).every(Boolean), "Seeded B2 upgrade is no-clobber and prospective."));
  cases.push(check("C15", automaticBounded, "Automatic bounded-local task remains Indexed."));
  cases.push(check("C16", agentPromotion, "EXPLICIT_AGENT overrides bounded-local automatic admission."));
  cases.push(check("C17", seeded.legacyFailedClosed, "Generic legacy promote fails closed."));

  const userHarness = await new PolicyHarness().open("C18");
  let userPromotion = false;
  try {
    const remembered = await userHarness.memorySpace.remember({
      spaceId: userHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.explicit-user",
      content: "Clean the sandbox after this test."
    });
    await userHarness.memorySpace.promote(remembered.id, { actor: "user" });
    const handoff = await userHarness.checkpoint([], "trusted user continuation");
    const history = await userHarness.memorySpace.getMemoryHistory(remembered.id);
    userPromotion = operation(history, "promote:explicit-user")
      && includes(handoff.activeTasks, remembered.content);
  } finally {
    await userHarness.close();
  }
  cases.push(check("C18", userPromotion, "EXPLICIT_USER promotion is durable and Handoff-eligible."));

  const changedHarness = await new PolicyHarness().open("C19");
  let changedDemotion = false;
  try {
    await changedHarness.checkpoint([candidate({
      type: "task", key: "task.prospective.changed", content: "Coordinate the multi-week migration."
    })]);
    await changedHarness.checkpoint([candidate({
      type: "task", key: "task.prospective.changed", content: "Remove the temp file after this run.", operation: "update"
    })]);
    changedDemotion = (await changedHarness.keyed("task.prospective.changed")).tier === "indexed";
  } finally {
    await changedHarness.close();
  }
  cases.push(check("C19", changedDemotion, "Changed bounded-local evidence demotes existing Core."));

  const equivalentHarness = await new PolicyHarness().open("C20");
  let equivalentDemotion = false;
  try {
    const bounded = candidate({
      type: "task", key: "task.prospective.equivalent", content: "Remove the temp file after this run."
    });
    await equivalentHarness.checkpoint([bounded]);
    await equivalentHarness.checkpoint([{ ...bounded, operation: "update" }]);
    equivalentDemotion = (await equivalentHarness.keyed("task.prospective.equivalent")).tier === "indexed";
  } finally {
    await equivalentHarness.close();
  }
  cases.push(check("C20", equivalentDemotion, "Equivalent evidence re-runs bounded-local admission."));

  const automaticHarness = await new PolicyHarness().open("automatic-provenance");
  let automaticProvenance = false;
  try {
    const remembered = await automaticHarness.memorySpace.remember({
      spaceId: automaticHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.automatic-promotion",
      content: "Coordinate the release verification."
    });
    await automaticHarness.checkpoint([candidate({
      type: "task",
      key: "task.automatic-promotion",
      content: remembered.content,
      operation: "update"
    })]);
    const history = await automaticHarness.memorySpace.getMemoryHistory(remembered.id);
    automaticProvenance = (await automaticHarness.keyed("task.automatic-promotion")).tier === "core"
      && operation(history, "promote:automatic")
      && !operation(history, "promote:explicit-agent")
      && !operation(history, "promote:explicit-user");
  } finally {
    await automaticHarness.close();
  }

  const preserveHarness = await new PolicyHarness().open("C21");
  let indexedReasonsPreserve = false;
  try {
    await preserveHarness.checkpoint([
      candidate({ type: "task", key: "task.no-recommendation", content: "Coordinate release rollout." }),
      candidate({ type: "task", key: "task.no-reason", content: "Coordinate database migration." })
    ]);
    await preserveHarness.checkpoint([
      candidate({ type: "task", key: "task.no-recommendation", content: "Coordinate release rollout.", operation: "update", recommendedTier: "indexed" }),
      candidate({ type: "task", key: "task.no-reason", content: "Coordinate database migration.", operation: "update", promoteReason: "" })
    ]);
    indexedReasonsPreserve = (await preserveHarness.keyed("task.no-recommendation")).tier === "core"
      && (await preserveHarness.keyed("task.no-reason")).tier === "core";
  } finally {
    await preserveHarness.close();
  }
  const conflictHarness = await new PolicyHarness().open("C21-conflict");
  let schemaConflictPreserved = false;
  try {
    await conflictHarness.checkpoint([candidate({
      type: "task", key: "task.schema", content: "Coordinate the release."
    })]);
    try {
      await conflictHarness.checkpoint([candidate({
        family: "episode", type: "episode", key: "task.schema", content: "One observed run.", operation: "update"
      })]);
    } catch (error) {
      const current = await conflictHarness.keyed("task.schema");
      schemaConflictPreserved = String(error).includes("MEMORY_KEY_SCHEMA_CONFLICT")
        || (String(error).includes("already bound") && current.type === "task" && current.tier === "core");
    }
  } finally {
    await conflictHarness.close();
  }
  const typeIneligibleHarness = await new PolicyHarness().open("C21-type-ineligible");
  let typeIneligiblePreserved = false;
  try {
    await typeIneligibleHarness.checkpoint([candidate({
      type: "progress", content: "Project-wide release validation is active."
    })]);
    const [existing] = await typeIneligibleHarness.memorySpace.store.listMemories({
      spaceId: typeIneligibleHarness.spaceId,
      tiers: ["core"]
    });
    await typeIneligibleHarness.checkpoint([candidate({
      family: "episode",
      type: "episode",
      content: "One durable observation replaces the unkeyed state.",
      operation: "update",
      targetMemoryId: existing!.id
    })]);
    const updated = await typeIneligibleHarness.memorySpace.getMemory(existing!.id);
    typeIneligiblePreserved = updated.type === "episode" && updated.tier === "core";
  } finally {
    await typeIneligibleHarness.close();
  }
  cases.push(check("C21", indexedReasonsPreserve && schemaConflictPreserved && typeIneligiblePreserved, "Non-bounded Indexed reasons preserve Core or reject schema conflict."));

  const overrideHarness = await new PolicyHarness().open("C22");
  let overridePrecedence = false;
  try {
    const content = "Remove the generated asset after this command.";
    const remembered = await overrideHarness.memorySpace.remember({
      spaceId: overrideHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.override",
      content
    });
    await overrideHarness.memorySpace.promote(remembered.id, {
      actor: "agent",
      reason: "Continue across Sessions"
    });
    await overrideHarness.checkpoint([candidate({
      type: "task", key: "task.override", content, operation: "update"
    })]);
    const equivalent = await overrideHarness.keyed("task.override");
    await overrideHarness.checkpoint([candidate({
      type: "task", key: "task.override", content: "Delete the generated report after this test.", operation: "update"
    })]);
    const changed = await overrideHarness.keyed("task.override");
    overridePrecedence = equivalent.tier === "core" && changed.tier === "indexed";
  } finally {
    await overrideHarness.close();
  }

  const userEquivalentHarness = await new PolicyHarness().open("C22-user-equivalent");
  let userEquivalentPreserved = false;
  try {
    const content = "Remove the generated archive after this command.";
    const remembered = await userEquivalentHarness.memorySpace.remember({
      spaceId: userEquivalentHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.user-equivalent",
      content
    });
    await userEquivalentHarness.memorySpace.promote(remembered.id, { actor: "user" });
    const handoff = await userEquivalentHarness.checkpoint([candidate({
      type: "task", key: "task.user-equivalent", content, operation: "update"
    })]);
    userEquivalentPreserved = (await userEquivalentHarness.keyed("task.user-equivalent")).tier === "core"
      && includes(handoff.activeTasks, content);
  } finally {
    await userEquivalentHarness.close();
  }

  const demotionHarness = await new PolicyHarness().open("C22-demotion");
  let demotionInvalidated = false;
  try {
    const content = "Remove the generated trace after this run.";
    const remembered = await demotionHarness.memorySpace.remember({
      spaceId: demotionHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.demoted-override",
      content
    });
    await demotionHarness.memorySpace.promote(remembered.id, {
      actor: "agent",
      reason: "Continue across Sessions"
    });
    await demotionHarness.memorySpace.demote(remembered.id, { reason: "Stop continuation" });
    const handoff = await demotionHarness.checkpoint([candidate({
      type: "task", key: "task.demoted-override", content, operation: "update"
    })]);
    demotionInvalidated = (await demotionHarness.keyed("task.demoted-override")).tier === "indexed"
      && !includes(handoff.activeTasks, content);
  } finally {
    await demotionHarness.close();
  }

  const statusHarness = await new PolicyHarness().open("C22-status");
  let statusInvalidated = false;
  try {
    const remembered = await statusHarness.memorySpace.remember({
      spaceId: statusHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.inactive-override",
      content: "Delete the response dump after this turn."
    });
    await statusHarness.memorySpace.promote(remembered.id, {
      actor: "agent",
      reason: "Continue across Sessions"
    });
    await statusHarness.memorySpace.setMemoryStatus(remembered.id, "resolved", { reason: "done" });
    const handoff = await statusHarness.checkpoint([], "post status transition");
    const updated = await statusHarness.memorySpace.getMemory(remembered.id);
    statusInvalidated = updated.tier === "indexed" && updated.status === "resolved"
      && !includes(handoff.activeTasks, remembered.content);
  } finally {
    await statusHarness.close();
  }

  const supersedeHarness = await new PolicyHarness().open("C22-supersession");
  let supersessionInvalidated = false;
  try {
    const content = "Remove the command log after this command.";
    const remembered = await supersedeHarness.memorySpace.remember({
      spaceId: supersedeHarness.spaceId,
      family: "state",
      type: "task",
      key: "task.superseded-override",
      content
    });
    await supersedeHarness.memorySpace.promote(remembered.id, {
      actor: "agent",
      reason: "Continue across Sessions"
    });
    const handoff = await supersedeHarness.checkpoint([candidate({
      type: "task",
      key: "task.superseded-override",
      content: "Delete the replacement command log after this run.",
      operation: "supersede"
    })]);
    const oldMemory = await supersedeHarness.memorySpace.getMemory(remembered.id);
    const replacement = await supersedeHarness.keyed("task.superseded-override");
    supersessionInvalidated = oldMemory.status === "superseded" && oldMemory.tier === "indexed"
      && replacement.tier === "indexed"
      && !includes(handoff.activeTasks, replacement.content);
  } finally {
    await supersedeHarness.close();
  }

  const allOverrideBoundaries = overridePrecedence
    && userEquivalentPreserved
    && demotionInvalidated
    && statusInvalidated
    && supersessionInvalidated;
  cases.push(check("C22", allOverrideBoundaries, "Explicit intent survives equivalent evidence and is invalidated by changed state, demotion, non-active status, or supersession."));

  const workingStateProvenance = await seededWorkingStateProvenanceEvaluation();
  return {
    version: 1,
    cases,
    promotionProvenance: [
      check("automatic-provenance", automaticProvenance, "Automatic promotion has a distinct untrusted operation identity."),
      check("explicit-agent-provenance", agentPromotion, "Agent promotion records EXPLICIT_AGENT."),
      check("explicit-user-provenance", userPromotion, "User promotion records EXPLICIT_USER."),
      check("ambiguous-legacy-provenance", seeded.legacyFailedClosed, "Legacy generic promote is AMBIGUOUS_LEGACY.")
    ],
    prospectiveTransitions: [
      check("changed-bounded-local", changedDemotion, "Changed state uses the new admission decision."),
      check("equivalent-bounded-local", equivalentDemotion, "Deduplicate path re-runs admission."),
      check("indexed-reason-preservation", indexedReasonsPreserve && typeIneligiblePreserved, "Non-bounded Indexed reasons preserve Core."),
      check("explicit-equivalent-precedence", overridePrecedence && userEquivalentPreserved, "Effective agent/user intent survives equivalent evidence."),
      check("explicit-intent-invalidation", demotionInvalidated && statusInvalidated && supersessionInvalidated, "Demotion, non-active status, and supersession invalidate explicit intent.")
    ],
    seededUpgrade: [
      check("upgrade-open-no-clobber", seeded.openPreserved && seeded.bootstrapPreserved, "Open/bootstrap preserve legacy rows and latest Handoff."),
      check("upgrade-new-handoff-policy", seeded.checkpointPreservedTier && seeded.checkpointExcludedHandoff, "First B3 checkpoint applies Handoff policy without tier reconciliation."),
      check("upgrade-old-handoff-immutable", seeded.oldHandoffImmutable, "Stored B2 Handoff remains immutable."),
      check("upgrade-trusted-transition", seeded.trustedDemotionRemovedDisclosure, "Trusted demotion removes active disclosure.")
    ],
    workingStateProvenance
  };
}
