import { inspectorApi } from "../api/client";
import type { BootstrapResult, Memory, OverviewResult } from "../api/types";
import { useResource } from "../hooks/useResource";
import { MemoryList } from "../components/memory/MemoryList";
import { Icon } from "../components/ui/Icon";
import { PageHeader } from "../components/ui/PageHeader";
import { ErrorState, LoadingState } from "../components/ui/States";

interface ValidationData {
  overview: OverviewResult;
  bootstrap: BootstrapResult;
  stored: Memory[];
}

function Check({
  label,
  value,
  note,
  ok = true
}: {
  label: string;
  value: string | number;
  note: string;
  ok?: boolean;
}) {
  return (
    <div className={`validation-check ${ok ? "" : "validation-check--warning"}`}>
      <span className="validation-check__icon"><Icon name={ok ? "check" : "close"} size={15} /></span>
      <div><strong>{label}</strong><small>{note}</small></div>
      <b>{value}</b>
    </div>
  );
}

export function ValidationPage({
  spaceId,
  refreshKey,
  onSelectMemory
}: {
  spaceId: string;
  refreshKey: number;
  onSelectMemory: (memoryId: string) => void;
}) {
  const resource = useResource<ValidationData>(async () => {
    const [overview, bootstrap, stored] = await Promise.all([
      inspectorApi.overview(spaceId),
      inspectorApi.bootstrap(spaceId),
      inspectorApi.allMemories(spaceId)
    ]);
    return { overview, bootstrap, stored };
  }, [spaceId, refreshKey]);
  if (resource.loading && !resource.data) return <LoadingState label="正在核对 Stored 与 Disclosed state…" />;
  if (resource.error) return <ErrorState error={resource.error} />;
  if (!resource.data) return null;
  const { overview, bootstrap, stored } = resource.data;
  const disclosedIds = new Set(bootstrap.coreMemories.map((memory) => memory.id));
  const excluded = stored.filter((memory) => !disclosedIds.has(memory.id));
  const indexed = excluded.filter((memory) => memory.tier === "indexed");
  const inactive = excluded.filter((memory) => memory.status !== "active");
  const spaceIsolated = overview.space.id === spaceId
    && bootstrap.space.id === spaceId
    && stored.every((memory) => memory.spaceId === spaceId);
  const countsAgree = overview.totalMemories === stored.length;
  const coreDisclosureValid = bootstrap.coreMemories.every((memory) => (
    memory.spaceId === spaceId && memory.tier === "core" && memory.status === "active"
  ));
  const validationOk = spaceIsolated && countsAgree && coreDisclosureValid;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="VALIDATION MODE"
        title="验证存储与披露边界"
        description="并排核对 durable store 与默认上下文，快速发现 Core、Handoff 或状态污染。"
      />

      <section className="validation-compare">
        <div className="validation-column">
          <span className="eyebrow">STORED</span>
          <strong>{overview.totalMemories}</strong>
          <h2>持久化 Memory</h2>
          <p>SQLite 中属于当前 Space 的完整逻辑状态。</p>
        </div>
        <div className="validation-divider"><Icon name="arrow" /></div>
        <div className="validation-column validation-column--accent">
          <span className="eyebrow">DISCLOSED</span>
          <strong>{bootstrap.coreMemories.length}</strong>
          <h2>Bootstrap Core</h2>
          <p>下一 Agent 默认收到的 active Core 工作集。</p>
        </div>
      </section>

      <div className="validation-grid">
        <section className="panel">
          <div className="panel__header"><div><span className="eyebrow">BOUNDARY CHECKS</span><h2>验证结果</h2></div><span className={validationOk ? "validation-pass" : "validation-pass validation-pass--warning"}>{validationOk ? "PASS" : "CHECK"}</span></div>
          <div className="validation-checks">
            <Check label="Space isolation" value="1 Space" note="API 固定到 daemon 可信绑定" ok={spaceIsolated} />
            <Check label="Stored consistency" value={stored.length} note="overview 与分页 browse 数量一致" ok={countsAgree} />
            <Check label="Core disclosure" value={bootstrap.coreMemories.length} note="仅 active Core 进入 production bootstrap" ok={coreDisclosureValid} />
            <Check label="Indexed exclusion" value={indexed.length} note="未默认注入，可按需检索" />
            <Check label="Inactive exclusion" value={inactive.length} note="非 active Memory 未默认披露" />
            <Check label="Latest Handoff" value={bootstrap.handoffSnapshot ? "Present" : "None"} note="使用持久化 checkpoint snapshot" />
          </div>
        </section>
        <section className="panel">
          <div className="panel__header"><div><span className="eyebrow">HANDOFF CONTENT</span><h2>交接覆盖</h2></div></div>
          <div className="handoff-coverage">
            <div><span>Goal</span><strong>{bootstrap.handoffSnapshot?.goal ? "✓" : "—"}</strong></div>
            <div><span>Tasks</span><strong>{bootstrap.handoffSnapshot?.activeTasks.length ?? 0}</strong></div>
            <div><span>Decisions</span><strong>{bootstrap.handoffSnapshot?.decisions.length ?? 0}</strong></div>
            <div><span>Blockers</span><strong>{bootstrap.handoffSnapshot?.blockers.length ?? 0}</strong></div>
            <div><span>Next steps</span><strong>{bootstrap.handoffSnapshot?.nextSteps.length ?? 0}</strong></div>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel__header">
          <div><span className="eyebrow">EXCLUDED FROM DEFAULT CONTEXT</span><h2>未披露的 Memory</h2></div>
          <strong className="panel__count">{excluded.length}</strong>
        </div>
        <MemoryList
          memories={excluded}
          onSelect={onSelectMemory}
          emptyTitle="没有被排除的 Memory"
          emptyDescription="当前完整状态与默认 Core 集合一致。"
        />
      </section>
    </div>
  );
}
