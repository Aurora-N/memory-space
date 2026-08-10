import type { MemoryCandidate, MemoryFamily, SessionEvent } from "../domain/types.ts";
import type { ExtractionContext, MemoryExtractor } from "../ports/extractor.ts";

interface TypeDefinition {
  type: string;
  family: MemoryFamily;
  pattern: RegExp;
  key?: string;
  core: boolean;
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
        const definition = definitions.find(({ pattern }) => pattern.test(line));
        if (!definition) continue;
        const match = line.match(definition.pattern)!;
        candidates.push({
          family: definition.family, type: definition.type, key: definition.key,
          content: match[1].trim(), confidence: 0.9, importance: definition.core ? 0.8 : 0.5,
          recommendedTier: definition.core ? "core" : "indexed",
          promoteReason: definition.core ? `Explicit project ${definition.type}` : undefined,
          sourceEventIds: [event.id], operation: definition.key ? "update" : "create"
        });
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
