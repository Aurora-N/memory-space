import { inspectorApi } from "../api/client";
import { relativeDate } from "../lib/format";
import { useResource } from "../hooks/useResource";
import { MemoryList } from "../components/memory/MemoryList";
import { Badge } from "../components/ui/Badge";
import { Icon } from "../components/ui/Icon";
import { MetricCard } from "../components/ui/MetricCard";
import { PageHeader } from "../components/ui/PageHeader";
import { ErrorState, LoadingState } from "../components/ui/States";

export function OverviewPage({
  spaceId,
  refreshKey,
  onSelectMemory
}: {
  spaceId: string;
  refreshKey: number;
  onSelectMemory: (memoryId: string) => void;
}) {
  const resource = useResource(() => inspectorApi.overview(spaceId), [spaceId, refreshKey]);
  if (resource.loading && !resource.data) return <LoadingState />;
  if (resource.error) return <ErrorState error={resource.error} />;
  if (!resource.data) return null;
  const overview = resource.data;
  const active = overview.counts.statuses.active ?? 0;
  const resolved = overview.counts.statuses.resolved ?? 0;
  const maxTypeCount = Math.max(1, ...Object.values(overview.counts.types));
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="SPACE OVERVIEW"
        title="你的项目记住了什么"
        description="这里展示当前绑定 Space 的持久化状态。所有数字都来自 daemon 的只读应用接口。"
        action={<Badge tone="accent">read only</Badge>}
      />

      <section className="metric-grid" aria-label="Memory 指标">
        <MetricCard label="全部 Memory" value={overview.totalMemories} note="当前 Space 的持久化总量" icon="database" />
        <MetricCard label="Core" value={overview.counts.tiers.core ?? 0} note="可进入默认上下文的工作集" icon="spark" tone="green" />
        <MetricCard label="Indexed" value={overview.counts.tiers.indexed ?? 0} note="按需检索，不默认注入" icon="archive" tone="amber" />
        <MetricCard label="Active" value={active} note={`${resolved} 条已 resolved`} icon="check" tone="blue" />
      </section>

      <div className="overview-grid">
        <section className="panel panel--wide">
          <div className="panel__header">
            <div><span className="eyebrow">RECENT ACTIVITY</span><h2>最近更新的 Memory</h2></div>
            <span className="panel__meta">latest {overview.recentMemories.length}</span>
          </div>
          <MemoryList
            memories={overview.recentMemories}
            onSelect={onSelectMemory}
            emptyTitle="这个 Space 还没有 Memory"
            emptyDescription="Agent 写入 durable memory 后，它们会出现在这里。"
          />
        </section>

        <div className="overview-grid__side">
          <section className="panel">
            <div className="panel__header"><div><span className="eyebrow">COMPOSITION</span><h2>按类型分布</h2></div></div>
            {Object.keys(overview.counts.types).length === 0 ? (
              <p className="muted-copy">暂无类型数据。</p>
            ) : (
              <div className="distribution-list">
                {Object.entries(overview.counts.types)
                  .sort(([, a], [, b]) => b - a)
                  .map(([type, count]) => (
                    <div className="distribution" key={type}>
                      <div><span>{type}</span><strong>{count}</strong></div>
                      <span className="distribution__track"><i style={{ width: `${(count / maxTypeCount) * 100}%` }} /></span>
                    </div>
                  ))}
              </div>
            )}
          </section>

          <section className="panel handoff-peek">
            <div className="panel__header"><div><span className="eyebrow">LATEST HANDOFF</span><h2>交接状态</h2></div><Icon name="handoff" /></div>
            {overview.latestHandoff ? (
              <>
                <strong className="handoff-peek__goal">{overview.latestHandoff.goal ?? "没有记录 goal"}</strong>
                <div className="handoff-peek__stats">
                  <span><strong>{overview.latestHandoff.activeTasks.length}</strong> tasks</span>
                  <span><strong>{overview.latestHandoff.decisions.length}</strong> decisions</span>
                  <span><strong>{overview.latestHandoff.blockers.length}</strong> blockers</span>
                </div>
                <small>生成于 {relativeDate(overview.latestHandoff.createdAt)}</small>
              </>
            ) : (
              <p className="muted-copy">还没有 checkpoint 生成 Handoff。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
