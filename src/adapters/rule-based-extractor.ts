import type { MemoryCandidate, MemoryFamily, SessionEvent } from "../domain/types.ts";
import type { ExtractionContext, MemoryExtractor } from "../ports/extractor.ts";

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
  { type: "goal", family: "state", pattern: /^(?:goal|目标)\s*[:：]\s*(.+)$/iu, key: "project.goal.primary", core: true },
  { type: "roadmap", family: "state", pattern: /^(?:roadmap|路线图|计划)\s*[:：]\s*(.+)$/iu, key: "project.roadmap.current", core: true },
  { type: "progress", family: "state", pattern: /^(?:progress|进度|已完成)\s*[:：]\s*(.+)$/iu, key: "project.progress.current", core: true },
  { type: "task", family: "state", pattern: /^(?:task|todo|任务|下一步)\s*[:：]\s*(.+)$/iu, core: true },
  { type: "decision", family: "knowledge", pattern: /^(?:decision|决定)\s*[:：]\s*(.+)$/iu, core: true },
  { type: "constraint", family: "knowledge", pattern: /^(?:constraint|约束)\s*[:：]\s*(.+)$/iu, core: true },
  { type: "convention", family: "knowledge", pattern: /^(?:convention|约定)\s*[:：]\s*(.+)$/iu, core: true },
  { type: "blocker", family: "state", pattern: /^(?:blocker|阻塞)\s*[:：]\s*(.+)$/iu, core: true },
  { type: "question", family: "state", pattern: /^(?:question|待确认|问题)\s*[:：]\s*(.+)$/iu, core: true },
  { type: "fact", family: "knowledge", pattern: /^(?:fact|事实)\s*[:：]\s*(.+)$/iu, core: false }
];

const currentExecutionNarrationPatterns = [
  /^(?:i(?:'m| am)|we(?:'re| are))\s+(?:now\s+|currently\s+|just\s+)?(?:checking|inspecting|reading|running|executing|opening|building|testing|analy[sz]ing|replying|responding|writing|editing|modifying)\b/iu,
  /^(?:i|we)\s+(?:will\s+)?(?:now|first|next|just)\s+(?:check|inspect|read|run|execute|open|build|test|analy[sz]e|reply|respond|output|write|edit|modify|handle|fix)\b/iu,
  /^(?:i|we)\s+(?:have\s+)?just\s+(?:checked|inspected|read|ran|executed|opened|built|tested|analy[sz]ed|replied|responded|wrote|edited|modified|handled|fixed)\b/iu,
  /^(?:next|now|first),?\s+(?:i|we)\s+(?:will\s+)?(?:check|inspect|read|run|execute|open|build|test|analy[sz]e|reply|respond|output|write|edit|modify|handle|fix)\b/iu,
  /^(?:我|我们)(?:(?:现在|先|接下来|稍后|刚刚|刚才|刚|正在|等一下)){1,3}(?:会|将|要|再|正)?(?:检查|查看|读取|运行|执行|打开|构建|测试|分析|回复|输出|修改|处理|修复)/u,
  /^接下来我(?:会|将|要)(?:检查|查看|读取|运行|执行|打开|构建|测试|分析|回复|输出|修改|处理|修复)/u,
  /^(?:正在|刚刚|刚才|稍后)(?:检查|查看|读取|运行|执行|打开|构建|测试|分析|回复|输出|修改|处理|修复)/u
] as const;

const temporaryOperationFailurePatterns = [
  /^(?:the\s+)?(?:command|tool(?:\s+call)?|test|build)\s+(?:just\s+)?(?:failed|errored)(?:\s+(?:because|due\s+to)\b.*)?[.!]?$/iu,
  /^(?:刚才|刚刚|这次|本次)(?:的)?(?:命令|工具调用|测试|构建).*(?:失败|报错|出错)[。！？]?$/u
] as const;

const currentInteractionScope = /(?:\b(?:this|the\s+current)\s+(?:command|turn|response)\b|(?:本次|这次|当前|这一轮|这轮)(?:命令|对话|回复|响应))/iu;

function explicitDefinition(line: string): MatchedDefinition | undefined {
  for (const definition of definitions) {
    const match = line.match(definition.pattern);
    if (match) return { definition, content: match[1].trim() };
  }
  return undefined;
}

function isTransientEvidence(text: string): boolean {
  return currentInteractionScope.test(text)
    || currentExecutionNarrationPatterns.some((pattern) => pattern.test(text))
    || temporaryOperationFailurePatterns.some((pattern) => pattern.test(text));
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
    operation: definition.key ? "update" : "create"
  };
}

function naturalCandidate(line: string, sourceEventId: string): MemoryCandidate | undefined {
  const naturalDecision = /^(?:we|the (?:project|team))\s+(?:(?:have|had)\s+)?(?:(?:selected|chose)\s+.+\s+(?:for|as)\s+.+|adopted\s+.+|standardized\s+on\s+.+|decided\s+to\s+(?:use|adopt|keep|move\s+to)\s+.+)[.!?]?$/iu.test(line)
    || /^(?:(?:项目|团队)(?:已经|已)?(?:决定|选择|确定)(?:采用|使用|改用|保留)|我们(?:已经|已)?(?:决定|确定)(?:采用|使用|改用|保留))\s*.+[。！？]?$/u.test(line);
  if (naturalDecision) {
    return candidateFromDefinition(
      { family: "knowledge", type: "decision", core: true },
      line,
      sourceEventId,
      0.88
    );
  }

  const durableTask = /^(?:(?:the\s+)?project(?:'s)?\s+(?:next\s+(?:phase|milestone)\s+)?(?:must|needs?\s+to|plans?\s+to)|before\s+.+?,?\s+(?:the\s+)?project\s+(?:must|needs?\s+to))\s+(?:complete|implement|deliver|migrate|prepare|finish|ship|add|remove|upgrade|deploy)\b.+$/iu.test(line)
    || /^(?:(?:项目|团队)(?:的)?(?:下一阶段|下个阶段|下一里程碑)(?:需要|必须|计划)|.+(?:前|之前)必须)\s*(?:完成|实现|交付|迁移|准备|修复|升级|发布|部署)\s*.+[。！？]?$/u.test(line);
  if (durableTask) {
    return candidateFromDefinition(
      { family: "state", type: "task", core: true },
      line,
      sourceEventId,
      0.86
    );
  }

  const naturalConstraint = /^(?!i\b|we\b)(?=\S)(?:.+\s+)(?:must(?:\s+not)?|shall(?:\s+not)?|is\s+required\s+to)\s+.+$/iu.test(line)
    || /^(?!我(?:们)?(?:必须|不得|只能|禁止))(?:(?:.+?)(?:必须|不得|只能).+|禁止\s*.+)[。！？]?$/u.test(line);
  if (naturalConstraint) {
    return candidateFromDefinition(
      { family: "knowledge", type: "constraint", core: true },
      line,
      sourceEventId,
      0.88
    );
  }

  const durableProgress = /^(?!i\b|we\b)(?:.+?)\s+(?:(?:has\s+been\s+)?(?:completed|finished|deployed|shipped)|is\s+(?:now\s+)?complete)[.!]?$/iu.test(line)
    || /^(?!我(?:们)?)(?:.+?)(?:已经|已)(?:完成|结束|上线|发布|部署|就绪)[。！？]?$/u.test(line);
  if (durableProgress) {
    return candidateFromDefinition(
      { family: "state", type: "progress", key: "project.progress.current", core: true },
      line,
      sourceEventId,
      0.86
    );
  }

  const durableBlocker = /^(?!i\b|we\b)(?:.+?)\s+(?:is|remains)\s+blocked\s+(?:by|on)\s+.+[.!]?$/iu.test(line)
    || /^(?!我(?:们)?)(?:.+?)(?:被.+(?:阻塞|阻断)|因.+(?:无法继续|无法发布|受阻))[。！？]?$/u.test(line);
  if (durableBlocker) {
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
      operation: candidate.operation ?? "create"
    } as MemoryCandidate;
  });
}

export class RuleBasedExtractor implements MemoryExtractor {
  async extract(events: SessionEvent[], _context: ExtractionContext): Promise<MemoryCandidate[]> {
    const candidates: MemoryCandidate[] = [];
    for (const event of events) {
      candidates.push(...structuredCandidates(event));
      if (event.type !== "message") continue;
      const text = event.payload.text ?? event.payload.content;
      if (typeof text !== "string") continue;
      for (const line of text.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
        const explicit = explicitDefinition(line);
        const evidence = explicit?.content ?? line;
        if (isTransientEvidence(evidence)) continue;

        const database = line.match(/数据库(?:已)?(?:确定)?使用\s*([A-Za-z][\w.+-]*)/iu);
        if (database) {
          candidates.push({
            family: "knowledge", type: "decision", key: "project.database",
            content: `数据库使用 ${database[1]}`, confidence: 0.98, importance: 0.9,
            recommendedTier: "core", promoteReason: "Stable project-wide database decision",
            sourceEventIds: [event.id], operation: "update"
          });
          continue;
        }
        const firstTask = line.match(/^先(?:完成|实现)\s*(.+)$/u);
        if (firstTask) {
          candidates.push({
            family: "state", type: "task", key: "project.task.current",
            content: `完成 ${firstTask[1]}`, confidence: 0.9, importance: 0.8,
            recommendedTier: "core", promoteReason: "Explicit current next task",
            sourceEventIds: [event.id], operation: "update"
          });
          continue;
        }
        if (explicit) {
          candidates.push(candidateFromDefinition(
            explicit.definition,
            explicit.content,
            event.id,
            0.9,
            `Explicit project ${explicit.definition.type}`
          ));
          continue;
        }
        const natural = naturalCandidate(line, event.id);
        if (natural) candidates.push(natural);
      }
    }
    return candidates;
  }
}

export class NoopExtractor implements MemoryExtractor {
  async extract(_events: SessionEvent[], _context: ExtractionContext): Promise<MemoryCandidate[]> {
    return [];
  }
}
