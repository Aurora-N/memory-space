import type { Memory } from "../../api/types";
import { relativeDate } from "../../lib/format";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/States";

export function MemoryList({
  memories,
  onSelect,
  scores,
  emptyTitle = "没有符合条件的 Memory",
  emptyDescription = "尝试清除搜索或筛选条件。"
}: {
  memories: Memory[];
  onSelect: (memoryId: string) => void;
  scores?: Map<string, number>;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (memories.length === 0) {
    return <EmptyState icon="search" title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className="memory-table" aria-label="Memory 列表">
      <div className="memory-table__header" aria-hidden="true">
        <span>Memory</span>
        <span>Type</span>
        <span>Tier</span>
        <span>Status</span>
        <span>Updated</span>
      </div>
      {memories.map((memory) => (
        <button
          aria-label={`查看 Memory ${memory.key ?? memory.content}`}
          className="memory-row"
          key={memory.id}
          onClick={() => onSelect(memory.id)}
          type="button"
        >
          <span className="memory-row__primary">
            <strong>{memory.key ?? memory.content}</strong>
            <small>{memory.key ? memory.content : memory.family}</small>
            {scores?.has(memory.id) && (
              <span className="memory-row__score">relevance {scores.get(memory.id)?.toFixed(2)}</span>
            )}
          </span>
          <span><Badge>{memory.type}</Badge></span>
          <span><Badge tone={memory.tier}>{memory.tier}</Badge></span>
          <span><Badge tone={memory.status === "active" ? "active" : "muted"}>{memory.status}</Badge></span>
          <span className="memory-row__time">{relativeDate(memory.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}
