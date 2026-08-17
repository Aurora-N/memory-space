import { inspectorApi } from "../api/client";
import type { BootstrapResult, Memory } from "../api/types";
import { useResource } from "../hooks/useResource";
import { MemoryList } from "../components/memory/MemoryList";
import { Badge } from "../components/ui/Badge";
import { Icon } from "../components/ui/Icon";
import { PageHeader } from "../components/ui/PageHeader";
import { ErrorState, LoadingState } from "../components/ui/States";

interface DisclosureData {
  bootstrap: BootstrapResult;
  stored: Memory[];
}

export function DisclosurePage({
  spaceId,
  refreshKey,
  onSelectMemory
}: {
  spaceId: string;
  refreshKey: number;
  onSelectMemory: (memoryId: string) => void;
}) {
  const resource = useResource<DisclosureData>(async () => {
    const [bootstrap, stored] = await Promise.all([
      inspectorApi.bootstrap(spaceId),
      inspectorApi.allMemories(spaceId)
    ]);
    return { bootstrap, stored };
  }, [spaceId, refreshKey]);
  if (resource.loading && !resource.data) return <LoadingState label="正在构建真实 bootstrap 视图…" />;
  if (resource.error) return <ErrorState error={resource.error} />;
  if (!resource.data) return null;
  const { bootstrap, stored } = resource.data;
  const disclosedIds = new Set(bootstrap.coreMemories.map((memory) => memory.id));
  const excluded = stored.filter((memory) => !disclosedIds.has(memory.id));
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="DISCLOSURE PIPELINE"
        title="下一个 Agent 实际会看到什么"
        description="右侧内容直接来自生产 bootstrap()。Inspector 不会重新实现 Core 或 Handoff policy。"
        action={<Badge tone="accent">real bootstrap</Badge>}
      />

      <section className="pipeline" aria-label="Memory 披露流程">
        <div><Icon name="database" /><span><strong>Stored</strong><small>{stored.length} memories</small></span></div>
        <Icon name="arrow" />
        <div><Icon name="spark" /><span><strong>Core admission</strong><small>{bootstrap.coreMemories.length} active Core</small></span></div>
        <Icon name="arrow" />
        <div><Icon name="handoff" /><span><strong>Handoff policy</strong><small>{bootstrap.handoffSnapshot ? "latest snapshot" : "no snapshot"}</small></span></div>
        <Icon name="arrow" />
        <div className="pipeline__final"><Icon name="terminal" /><span><strong>Agent context</strong><small>production output</small></span></div>
      </section>

      <div className="disclosure-grid">
        <section className="panel">
          <div className="panel__header">
            <div><span className="eyebrow">FULL STORED STATE</span><h2>持久化状态</h2></div>
            <strong className="panel__count">{stored.length}</strong>
          </div>
          <div className="stored-summary">
            <div><strong>{bootstrap.coreMemories.length}</strong><span>disclosed Core</span></div>
            <div><strong>{excluded.length}</strong><span>excluded by policy</span></div>
          </div>
          <h3 className="subsection-title">未进入默认上下文</h3>
          <MemoryList
            memories={excluded.slice(0, 12)}
            onSelect={onSelectMemory}
            emptyTitle="没有被排除的 Memory"
            emptyDescription="所有当前记录都在 bootstrap Core 集合中。"
          />
          {excluded.length > 12 && <p className="panel__footnote">另有 {excluded.length - 12} 条，可在 Memories 页面查看。</p>}
        </section>

        <section className="panel context-panel">
          <div className="panel__header">
            <div><span className="eyebrow">DISCLOSED CONTEXT</span><h2>真实 Agent Context</h2></div>
            <span className="context-panel__live"><i /> bootstrap</span>
          </div>
          <pre className="context-output">{bootstrap.context}</pre>
        </section>
      </div>
    </div>
  );
}
