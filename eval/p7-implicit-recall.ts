import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckpointPolicy,
  ClaudeCodeLifecycleIntegration,
  CodexLifecycleIntegration,
  createDefaultMemorySpace,
  ImplicitRecallService,
  LifecycleHandler,
  NoopExtractor,
  ProviderSessionResolver,
  SpaceResolver,
  type ImplicitRecallMode,
  type LifecycleContext,
  type LifecycleResult,
  type LifecycleWarning,
  type MemoryStatus,
  type MemoryTier
} from "../src/index.ts";

export type P7Provider = "codex" | "claude-code";
export type P7Classification =
  | "exact-key"
  | "lexical-positive"
  | "negative"
  | "opt-out"
  | "stale-conflict";

export interface P7MemoryFixture {
  content: string;
  tier: MemoryTier;
  status: MemoryStatus;
  space: "primary" | "other";
}

export interface P7ImplicitRecallScenario {
  scenarioId: string;
  sourceProvider: P7Provider;
  targetProvider: P7Provider;
  mode: ImplicitRecallMode;
  prompt: string;
  classification: P7Classification;
  relevantMemoryKeys: string[];
  bootstrapExcludedKeys: string[];
  expectedInjectedKeys: string[];
  expectedFirstKey?: string;
  expectedAbstention: boolean;
  explicitToolAllowed: false;
}

export interface P7ImplicitRecallFixture {
  version: 1;
  memoryCatalog: Record<string, P7MemoryFixture>;
  scenarios: P7ImplicitRecallScenario[];
}

export interface P7ScenarioResult {
  scenarioId: string;
  sourceProvider: P7Provider;
  targetProvider: P7Provider;
  classification: P7Classification;
  effectiveMode: ImplicitRecallMode;
  bypassed: boolean;
  bootstrapExcluded: boolean;
  injectedKeys: string[];
  firstKey?: string;
  abstained: boolean;
  providerHookEvent?: string;
  contentAssertionsPassed: boolean;
  metadataLeakage: boolean;
  coreReinjected: boolean;
  withinBudget: boolean;
  passed: boolean;
}

export interface P7ImplicitRecallReport {
  version: 1;
  fixtureVersion: 1;
  metrics: {
    bareIdentifierHitRate: number;
    exactKeyHitRate: number;
    implicitRecallPrecisionAt1: number;
    negativeAbstentionRate: number;
    coreReinjectionRate: number;
    metadataLeakageRate: number;
    optOutComplianceRate: number;
    budgetComplianceRate: number;
    crossProviderMatrix: { passed: number; total: number };
  };
  scenarios: P7ScenarioResult[];
  hardCorrectness: "pass" | "fail";
}

export interface P7LifecycleDecision {
  effectiveMode: ImplicitRecallMode;
  bypassed: boolean;
}

class RecordingLifecycleHandler extends LifecycleHandler {
  lastResult?: LifecycleResult | LifecycleWarning;

  override async handleFailOpen(
    value: unknown,
    context: LifecycleContext = {}
  ): Promise<LifecycleResult | LifecycleWarning> {
    const result = await super.handleFailOpen(value, context);
    this.lastResult = result;
    return result;
  }
}

export function expectedP7LifecycleDecision(
  scenario: Pick<P7ImplicitRecallScenario, "classification" | "mode">
): P7LifecycleDecision {
  return scenario.classification === "opt-out"
    ? { effectiveMode: "off", bypassed: true }
    : { effectiveMode: scenario.mode, bypassed: false };
}

export function p7LifecycleDecisionMatches(
  scenario: Pick<P7ImplicitRecallScenario, "classification" | "mode">,
  observed: P7LifecycleDecision
): boolean {
  const expected = expectedP7LifecycleDecision(scenario);
  return observed.effectiveMode === expected.effectiveMode
    && observed.bypassed === expected.bypassed;
}

const fixtureUrl = new URL("./fixtures/p7-implicit-recall.json", import.meta.url);
const providers = new Set<P7Provider>(["codex", "claude-code"]);
const modes = new Set<ImplicitRecallMode>(["off", "exact", "lexical"]);
const classifications = new Set<P7Classification>([
  "exact-key", "lexical-positive", "negative", "opt-out", "stale-conflict"
]);

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value, "", `${label} must not be empty`);
  return value as string;
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

export function validateP7Fixture(value: unknown): P7ImplicitRecallFixture {
  const root = object(value, "fixture");
  assert.equal(root.version, 1, "fixture.version must be 1");
  const rawCatalog = object(root.memoryCatalog, "fixture.memoryCatalog");
  const memoryCatalog: Record<string, P7MemoryFixture> = {};
  for (const [key, raw] of Object.entries(rawCatalog)) {
    const item = object(raw, `memoryCatalog.${key}`);
    const tier = string(item.tier, `memoryCatalog.${key}.tier`) as MemoryTier;
    const status = string(item.status, `memoryCatalog.${key}.status`) as MemoryStatus;
    const space = string(item.space, `memoryCatalog.${key}.space`);
    assert.ok(tier === "core" || tier === "indexed");
    assert.ok(["active", "resolved", "superseded", "archived"].includes(status));
    assert.ok(space === "primary" || space === "other");
    memoryCatalog[key] = {
      content: string(item.content, `memoryCatalog.${key}.content`),
      tier,
      status,
      space
    };
  }
  assert.ok(Array.isArray(root.scenarios), "fixture.scenarios must be an array");
  assert.ok(root.scenarios.length > 0, "fixture.scenarios must not be empty");
  const ids = new Set<string>();
  const scenarios = root.scenarios.map((raw, index): P7ImplicitRecallScenario => {
    const item = object(raw, `scenarios[${index}]`);
    const scenarioId = string(item.scenarioId, `scenarios[${index}].scenarioId`);
    assert.equal(ids.has(scenarioId), false, `duplicate scenarioId: ${scenarioId}`);
    ids.add(scenarioId);
    const sourceProvider = string(item.sourceProvider, "sourceProvider") as P7Provider;
    const targetProvider = string(item.targetProvider, "targetProvider") as P7Provider;
    const mode = string(item.mode, "mode") as ImplicitRecallMode;
    const classification = string(item.classification, "classification") as P7Classification;
    assert.ok(providers.has(sourceProvider));
    assert.ok(providers.has(targetProvider));
    assert.ok(modes.has(mode));
    assert.ok(classifications.has(classification));
    assert.equal(typeof item.expectedAbstention, "boolean");
    assert.equal(item.explicitToolAllowed, false);
    const scenario: P7ImplicitRecallScenario = {
      scenarioId,
      sourceProvider,
      targetProvider,
      mode,
      prompt: string(item.prompt, "prompt"),
      classification,
      relevantMemoryKeys: stringArray(item.relevantMemoryKeys, "relevantMemoryKeys"),
      bootstrapExcludedKeys: stringArray(item.bootstrapExcludedKeys, "bootstrapExcludedKeys"),
      expectedInjectedKeys: stringArray(item.expectedInjectedKeys, "expectedInjectedKeys"),
      expectedAbstention: item.expectedAbstention as boolean,
      explicitToolAllowed: false
    };
    if (item.expectedFirstKey !== undefined) {
      scenario.expectedFirstKey = string(item.expectedFirstKey, "expectedFirstKey");
    }
    for (const key of [
      ...scenario.relevantMemoryKeys,
      ...scenario.bootstrapExcludedKeys,
      ...scenario.expectedInjectedKeys,
      ...(scenario.expectedFirstKey ? [scenario.expectedFirstKey] : [])
    ]) assert.ok(memoryCatalog[key], `${scenarioId} references unknown Memory key ${key}`);
    return scenario;
  });
  return { version: 1, memoryCatalog, scenarios };
}

export async function loadP7Fixture(): Promise<P7ImplicitRecallFixture> {
  return validateP7Fixture(JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown);
}

export function assertP7FixtureContract(
  candidate: P7ImplicitRecallFixture,
  accepted: P7ImplicitRecallFixture
): void {
  assert.deepEqual(candidate, accepted, "P7 frozen fixture contract changed");
}

function nativeEvent(
  provider: P7Provider,
  event: "SessionStart" | "UserPromptSubmit",
  externalSessionId: string,
  cwd: string,
  prompt?: string
): Record<string, unknown> {
  return {
    session_id: externalSessionId,
    transcript_path: `/opaque/${provider}/${externalSessionId}`,
    cwd,
    hook_event_name: event,
    permission_mode: "default",
    ...(event === "SessionStart"
      ? { source: "startup" }
      : provider === "codex"
        ? { turn_id: `turn-${externalSessionId}`, prompt }
        : { prompt_id: `prompt-${externalSessionId}`, prompt })
  };
}

async function runScenario(
  fixture: P7ImplicitRecallFixture,
  scenario: P7ImplicitRecallScenario
): Promise<P7ScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), "memory-space-p7-eval-"));
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  try {
    const primary = await memorySpace.createSpace({ id: "p7-primary", name: "P7 Primary" });
    const other = await memorySpace.createSpace({ id: "p7-other", name: "P7 Other" });
    const sourceSessions = {
      primary: await memorySpace.createSession({
        spaceId: primary.id,
        provider: scenario.sourceProvider
      }),
      other: await memorySpace.createSession({
        spaceId: other.id,
        provider: scenario.sourceProvider
      })
    };
    const runtimeIds = new Map<string, string>();
    for (const [key, item] of Object.entries(fixture.memoryCatalog)) {
      const space = item.space === "primary" ? primary : other;
      const source = sourceSessions[item.space];
      let stored = await memorySpace.remember({
        spaceId: space.id,
        sourceSessionId: source.id,
        family: "knowledge",
        type: "fact",
        key,
        content: item.content
      });
      if (item.tier === "core") {
        stored = await memorySpace.promote(stored.id, { actor: "user" });
      }
      if (item.status !== "active") {
        stored = await memorySpace.setMemoryStatus(stored.id, item.status);
      }
      runtimeIds.set(key, stored.id);
    }

    mkdirSync(join(root, ".memory-space"));
    writeFileSync(join(root, ".memory-space", "config.json"), JSON.stringify({
      version: 1,
      spaceId: primary.id,
      implicitRecall: { mode: scenario.mode }
    }));
    const handler = new RecordingLifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver: new ProviderSessionResolver(memorySpace),
      checkpointPolicy: new CheckpointPolicy(memorySpace),
      implicitRecall: new ImplicitRecallService(memorySpace)
    });
    const integration = scenario.targetProvider === "codex"
      ? new CodexLifecycleIntegration({ lifecycleHandler: handler })
      : new ClaudeCodeLifecycleIntegration({ lifecycleHandler: handler });
    const externalSessionId = `target-${scenario.scenarioId}`;
    const started = await integration.handleNative(nativeEvent(
      scenario.targetProvider,
      "SessionStart",
      externalSessionId,
      root
    ));
    assert.equal(started.status, "ok");
    assert.equal(started.type, "session_start");
    if (started.status !== "ok" || started.type !== "session_start") {
      throw new Error("Expected provider SessionStart success");
    }
    const targetSession = await memorySpace.getSession(started.sessionId);
    const bootstrap = await memorySpace.bootstrap(targetSession.spaceId);
    const bootstrapKeys = bootstrap.coreMemories.map((item) => item.key).filter(Boolean);
    const bootstrapExcluded = scenario.bootstrapExcludedKeys.every(
      (key) => !bootstrapKeys.includes(key)
    );

    const response = await integration.handleNative(nativeEvent(
      scenario.targetProvider,
      "UserPromptSubmit",
      externalSessionId,
      root,
      scenario.prompt
    ));
    assert.equal(response.status, "ok");
    assert.equal(response.type, "user_prompt");
    if (response.status !== "ok" || response.type !== "user_prompt") {
      throw new Error("Expected provider UserPromptSubmit success");
    }
    const lifecycleResult = handler.lastResult;
    assert.equal(lifecycleResult?.status, "ok");
    assert.equal(lifecycleResult?.type, "user_prompt");
    if (lifecycleResult?.status !== "ok" || lifecycleResult.type !== "user_prompt") {
      throw new Error("Provider integration did not consume a user_prompt LifecycleResult");
    }
    assert.ok(lifecycleResult.recall, "user_prompt LifecycleResult must include recall decision");
    const observedDecision: P7LifecycleDecision = {
      effectiveMode: lifecycleResult.recall.effectiveMode,
      bypassed: lifecycleResult.recall.bypassed
    };
    const output = response.output;
    const context = output?.hookSpecificOutput?.hookEventName === "UserPromptSubmit"
      ? output.hookSpecificOutput.additionalContext
      : undefined;
    const injectedKeys = Object.entries(fixture.memoryCatalog)
      .filter(([, item]) => context?.includes(item.content) ?? false)
      .sort((left, right) => (
        (context?.indexOf(left[1].content) ?? -1)
        - (context?.indexOf(right[1].content) ?? -1)
      ))
      .map(([key]) => key);
    const contentAssertionsPassed = scenario.expectedInjectedKeys.every(
      (key) => context?.includes(fixture.memoryCatalog[key]!.content) ?? false
    ) && Object.entries(fixture.memoryCatalog).every(([key, item]) => (
      scenario.expectedInjectedKeys.includes(key) || !context?.includes(item.content)
    ));
    const metadataLeakage = [...runtimeIds.values()].some((id) => context?.includes(id));
    const coreReinjected = context?.includes(fixture.memoryCatalog.CORE_ONLY_20260817!.content)
      ?? false;
    const firstKey = injectedKeys[0];
    const abstained = injectedKeys.length === 0;
    const passed = bootstrapExcluded
      && JSON.stringify(injectedKeys) === JSON.stringify(scenario.expectedInjectedKeys)
      && firstKey === scenario.expectedFirstKey
      && abstained === scenario.expectedAbstention
      && contentAssertionsPassed
      && !metadataLeakage
      && !coreReinjected
      && (context?.length ?? 0) <= 2400
      && (output?.hookSpecificOutput?.hookEventName
        === (context ? "UserPromptSubmit" : undefined))
      && p7LifecycleDecisionMatches(scenario, observedDecision);
    return {
      scenarioId: scenario.scenarioId,
      sourceProvider: scenario.sourceProvider,
      targetProvider: scenario.targetProvider,
      classification: scenario.classification,
      effectiveMode: observedDecision.effectiveMode,
      bypassed: observedDecision.bypassed,
      bootstrapExcluded,
      injectedKeys,
      firstKey,
      abstained,
      providerHookEvent: output?.hookSpecificOutput?.hookEventName,
      contentAssertionsPassed,
      metadataLeakage,
      coreReinjected,
      withinBudget: (context?.length ?? 0) <= 2400,
      passed
    };
  } finally {
    await memorySpace.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export async function runP7ImplicitRecallEval(
  fixture?: P7ImplicitRecallFixture
): Promise<P7ImplicitRecallReport> {
  fixture ??= await loadP7Fixture();
  const scenarios: P7ScenarioResult[] = [];
  for (const scenario of fixture.scenarios) scenarios.push(await runScenario(fixture, scenario));
  const bare = scenarios.filter((item) => item.scenarioId.startsWith("bare-"));
  const exact = scenarios.filter((item) => item.classification === "exact-key");
  const positives = fixture.scenarios.filter((item) => item.expectedInjectedKeys.length > 0);
  const positiveResults = scenarios.filter((item) => (
    positives.some((scenario) => scenario.scenarioId === item.scenarioId)
  ));
  const negatives = scenarios.filter((item) => (
    item.classification === "negative" || item.classification === "opt-out"
  ));
  const optOut = scenarios.filter((item) => item.classification === "opt-out");
  return {
    version: 1,
    fixtureVersion: fixture.version,
    metrics: {
      bareIdentifierHitRate: ratio(bare.filter((item) => item.passed).length, bare.length),
      exactKeyHitRate: ratio(exact.filter((item) => item.passed).length, exact.length),
      implicitRecallPrecisionAt1: ratio(
        positiveResults.filter((item) => {
          const contract = fixture.scenarios.find(
            (scenario) => scenario.scenarioId === item.scenarioId
          );
          return item.firstKey !== undefined
            && (contract?.relevantMemoryKeys.includes(item.firstKey) ?? false);
        }).length,
        positiveResults.length
      ),
      negativeAbstentionRate: ratio(
        negatives.filter((item) => item.abstained).length,
        negatives.length
      ),
      coreReinjectionRate: ratio(
        scenarios.filter((item) => item.coreReinjected).length,
        scenarios.length
      ),
      metadataLeakageRate: ratio(
        scenarios.filter((item) => item.metadataLeakage).length,
        scenarios.length
      ),
      optOutComplianceRate: ratio(
        optOut.filter((item) => item.passed).length,
        optOut.length
      ),
      budgetComplianceRate: ratio(
        scenarios.filter((item) => item.withinBudget).length,
        scenarios.length
      ),
      crossProviderMatrix: {
        passed: bare.filter((item) => item.passed).length,
        total: bare.length
      }
    },
    scenarios,
    hardCorrectness: scenarios.every((item) => item.passed) ? "pass" : "fail"
  };
}
