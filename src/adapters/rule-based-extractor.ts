import type { MemoryCandidate, MemoryFamily, SessionEvent } from "../domain/types.ts";
import type { ExtractionContext, MemoryExtractor } from "../ports/extractor.ts";
import { builtInExtractionRules, DeclarativeRuleExtractor } from "./declarative-rule-extractor.ts";
import { builtInMemoryKeys } from "./extraction-contract.ts";
import { isTransientExtractionEvidence } from "./extraction-policy.ts";

interface TypeDefinition {
  type: string;
  family: MemoryFamily;
  pattern: RegExp;
  key?: string;
  core: boolean;
}

interface MatchedDefinition {
  definition: TypeDefinition;
  content: string;
}

const definitions: TypeDefinition[] = [
  {
    type: "goal",
    family: "state",
    pattern: /^(?:goal|目标)\s*[:：]\s*(.+)$/iu,
    key: builtInMemoryKeys.primaryGoal,
    core: true,
  },
  {
    type: "roadmap",
    family: "state",
    pattern: /^(?:roadmap|路线图|计划)\s*[:：]\s*(.+)$/iu,
    key: builtInMemoryKeys.currentRoadmap,
    core: true,
  },
  {
    type: "progress",
    family: "state",
    pattern: /^(?:progress|进度|已完成)\s*[:：]\s*(.+)$/iu,
    key: builtInMemoryKeys.currentProgress,
    core: true,
  },
  {
    type: "task",
    family: "state",
    pattern: /^(?:task|todo|任务|下一步)\s*[:：]\s*(.+)$/iu,
    core: true,
  },
  {
    type: "decision",
    family: "knowledge",
    pattern: /^(?:decision|决定)\s*[:：]\s*(.+)$/iu,
    core: true,
  },
  {
    type: "constraint",
    family: "knowledge",
    pattern: /^(?:constraint|约束)\s*[:：]\s*(.+)$/iu,
    core: true,
  },
  {
    type: "convention",
    family: "knowledge",
    pattern: /^(?:convention|约定)\s*[:：]\s*(.+)$/iu,
    core: true,
  },
  { type: "blocker", family: "state", pattern: /^(?:blocker|阻塞)\s*[:：]\s*(.+)$/iu, core: true },
  {
    type: "question",
    family: "state",
    pattern: /^(?:question|待确认|问题)\s*[:：]\s*(.+)$/iu,
    core: true,
  },
  { type: "fact", family: "knowledge", pattern: /^(?:fact|事实)\s*[:：]\s*(.+)$/iu, core: false },
];

const durableEnglishSubjectClasses = [
  /^(?:all\s+)?(?:public\s+)?apis?\b/iu,
  /^(?:the\s+)?(?:project|team|service|system|database)\b/iu,
  /\b(?:credentials|tokens?|configuration|components?)\b/iu,
  /\b(?:release|rollout|migration|deployment|pipeline)\b/iu,
] as const;

const durableChineseSubjectClasses = [
  /^(?:项目|团队|服务|系统|数据库)/u,
  /(?:API|接口|凭证|令牌|配置|组件)/iu,
  /(?:发布|上线|迁移|部署|里程碑|构建流程|流水线)/u,
] as const;

const durableProjectBoundaryShapes = [
  /^(?:(?:项目|团队|服务|系统|数据库|生产|正式|版本)(?:的)?)?(?:发布|上线|部署|迁移)(?:阶段|窗口|节点|里程碑)?$/u,
  /^(?:项目|团队|服务|系统)(?:的)?(?:阶段|里程碑|交付节点)$/u,
] as const;

function isInteractionLocalSubject(subject: string): boolean {
  const normalized = subject.trim();
  return (
    /\b(?:i|we|you)\b/iu.test(normalized) ||
    /^(?:(?:this|the|the\s+current)\s+)?(?:command|tool\s+call|test|response|turn|run)$/iu.test(
      normalized
    ) ||
    /(?:我|我们|你)/u.test(normalized) ||
    /^(?:(?:这次|本次|当前|这一轮|这轮)的?)?(?:命令|工具调用|测试|回复|对话|运行)$/u.test(
      normalized
    )
  );
}

function hasDurableProjectSubject(subject: string): boolean {
  if (isInteractionLocalSubject(subject)) return false;
  return (
    durableEnglishSubjectClasses.some((pattern) => pattern.test(subject)) ||
    durableChineseSubjectClasses.some((pattern) => pattern.test(subject))
  );
}

function hasDurableProjectScope(scope: string): boolean {
  return (
    hasDurableProjectSubject(scope) &&
    durableProjectBoundaryShapes.some((pattern) => pattern.test(scope.trim()))
  );
}

function explicitDefinition(line: string): MatchedDefinition | undefined {
  for (const definition of definitions) {
    const match = line.match(definition.pattern);
    if (match) return { definition, content: match[1].trim() };
  }
  return undefined;
}

function candidateFromDefinition(
  definition: Omit<TypeDefinition, "pattern">,
  content: string,
  sourceEventId: string,
  confidence = 0.9,
  promoteReason = `Durable project ${definition.type}`
): MemoryCandidate {
  return {
    family: definition.family,
    type: definition.type,
    key: definition.key,
    content,
    confidence,
    importance: definition.core ? 0.8 : 0.5,
    recommendedTier: definition.core ? "core" : "indexed",
    promoteReason: definition.core ? promoteReason : undefined,
    sourceEventIds: [sourceEventId],
    operation: definition.key ? "update" : "create",
  };
}

function naturalCandidate(line: string, sourceEventId: string): MemoryCandidate | undefined {
  const naturalDecision =
    /^(?:we|the (?:project|team))\s+(?:(?:have|had)\s+)?(?:(?:selected|chose)\s+.+\s+(?:for|as)\s+.+|adopted\s+.+|standardized\s+on\s+.+|decided\s+to\s+(?:use|adopt|keep|move\s+to)\s+.+)[.!?]?$/iu.test(
      line
    ) ||
    /^(?:(?:项目|团队)(?:已经|已)?(?:决定|选择|确定)(?:采用|使用|改用|保留)|我们(?:已经|已)?(?:决定|确定)(?:采用|使用|改用|保留))\s*.+[。！？]?$/u.test(
      line
    );
  if (naturalDecision) {
    return candidateFromDefinition(
      { family: "knowledge", type: "decision", core: true },
      line,
      sourceEventId,
      0.88
    );
  }

  const englishDurableTask =
    /^(?:(?:the\s+)?project(?:'s)?\s+(?:next\s+(?:phase|milestone)\s+)?(?:must|needs?\s+to|plans?\s+to)|before\s+.+?,?\s+(?:the\s+)?project\s+(?:must|needs?\s+to))\s+(?:complete|implement|deliver|migrate|prepare|finish|ship|add|remove|upgrade|deploy)\b.+$/iu.test(
      line
    );
  const chineseProjectTask =
    /^(?:项目|团队)(?:的)?(?:下一阶段|下个阶段|下一里程碑)(?:需要|必须|计划)\s*(?:完成|实现|交付|迁移|准备|修复|升级|发布|部署)\s*.+[。！？]?$/u.test(
      line
    );
  const chineseBoundaryTask = line.match(
    /^(.+?)(?:之前|前)必须\s*(?:完成|实现|交付|迁移|准备|修复|升级|发布|部署)\s*.+[。！？]?$/u
  );
  const durableTask =
    englishDurableTask ||
    chineseProjectTask ||
    Boolean(chineseBoundaryTask && hasDurableProjectScope(chineseBoundaryTask[1]));
  if (durableTask) {
    return candidateFromDefinition(
      { family: "state", type: "task", core: true },
      line,
      sourceEventId,
      0.86
    );
  }
  if (chineseBoundaryTask) return undefined;

  const englishConstraint = line.match(
    /^(.+?)\s+(?:must(?:\s+not)?|shall(?:\s+not)?|is\s+required\s+to)\s+.+$/iu
  );
  const chineseConstraint = line.match(/^(.+?)(?:必须|不得|只能).+[。！？]?$/u);
  if (
    (englishConstraint && hasDurableProjectSubject(englishConstraint[1])) ||
    (chineseConstraint && hasDurableProjectSubject(chineseConstraint[1]))
  ) {
    return candidateFromDefinition(
      { family: "knowledge", type: "constraint", core: true },
      line,
      sourceEventId,
      0.88
    );
  }

  const englishProgress = line.match(
    /^(.+?)\s+(?:(?:has\s+been\s+)?(?:completed|finished|deployed|shipped)|is\s+(?:now\s+)?complete)[.!]?$/iu
  );
  const chineseProgress = line.match(
    /^(.+?)(?:已经|已)(?:完成|结束|上线|发布|部署|就绪)[。！？]?$/u
  );
  if (
    (englishProgress && hasDurableProjectSubject(englishProgress[1])) ||
    (chineseProgress && hasDurableProjectSubject(chineseProgress[1]))
  ) {
    return candidateFromDefinition(
      {
        family: "state",
        type: "progress",
        key: builtInMemoryKeys.currentProgress,
        core: true,
      },
      line,
      sourceEventId,
      0.86
    );
  }

  const englishBlocker = line.match(/^(.+?)\s+(?:is|remains)\s+blocked\s+(?:by|on)\s+.+[.!]?$/iu);
  const chineseBlocker = line.match(
    /^(.+?)(?:被.+(?:阻塞|阻断)|因.+(?:无法继续|无法发布|受阻))[。！？]?$/u
  );
  if (
    (englishBlocker && hasDurableProjectSubject(englishBlocker[1])) ||
    (chineseBlocker && hasDurableProjectSubject(chineseBlocker[1]))
  ) {
    return candidateFromDefinition(
      { family: "state", type: "blocker", core: true },
      line,
      sourceEventId,
      0.86
    );
  }

  return undefined;
}

function structuredCandidates(event: SessionEvent): MemoryCandidate[] {
  if (event.type !== "memory") return [];
  const payload = event.payload;
  const raw = Array.isArray(payload.candidates)
    ? payload.candidates
    : payload.candidate
      ? [payload.candidate]
      : [payload];
  return raw.map((value) => {
    const candidate = value as Partial<MemoryCandidate>;
    return {
      ...candidate,
      confidence: candidate.confidence ?? 1,
      recommendedTier: candidate.recommendedTier ?? "indexed",
      sourceEventIds: candidate.sourceEventIds ?? [event.id],
      operation: candidate.operation ?? "create",
    } as MemoryCandidate;
  });
}

/** Deterministic provider-neutral extractor for supported durable-memory patterns. */
export class RuleBasedExtractor implements MemoryExtractor {
  readonly specialCases = new DeclarativeRuleExtractor(builtInExtractionRules);

  async extract(events: SessionEvent[], _context: ExtractionContext): Promise<MemoryCandidate[]> {
    const candidates: MemoryCandidate[] = [];
    for (const event of events) {
      candidates.push(...structuredCandidates(event));
      if (event.type !== "message") continue;
      const text = event.payload.text ?? event.payload.content;
      if (typeof text !== "string") continue;
      for (const line of text
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean)) {
        const explicit = explicitDefinition(line);
        const evidence = explicit?.content ?? line;
        if (isTransientExtractionEvidence(evidence)) continue;
        const special = this.specialCases.extractLine(line, event.id);
        if (special.length > 0) {
          candidates.push(...special);
          continue;
        }
        if (explicit) {
          candidates.push(
            candidateFromDefinition(
              explicit.definition,
              explicit.content,
              event.id,
              0.9,
              `Explicit project ${explicit.definition.type}`
            )
          );
          continue;
        }
        const natural = naturalCandidate(line, event.id);
        if (natural) candidates.push(natural);
      }
    }
    return candidates;
  }
}

/** Extractor implementation that deliberately produces no candidates. */
export class NoopExtractor implements MemoryExtractor {
  async extract(_events: SessionEvent[], _context: ExtractionContext): Promise<MemoryCandidate[]> {
    return [];
  }
}
