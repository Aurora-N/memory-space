import { inspectorApi } from "../api/client";
import type { HandoffSnapshot } from "../api/types";
import { compactId, formatDate } from "../lib/format";
import { useResource } from "../hooks/useResource";
import { Icon, type IconName } from "../components/ui/Icon";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/States";

function HandoffSection({
  title,
  values,
  icon,
  tone
}: {
  title: string;
  values: string[];
  icon: IconName;
  tone: string;
}) {
  return (
    <section className={`handoff-section handoff-section--${tone}`}>
      <header><span><Icon name={icon} size={17} /></span><h2>{title}</h2><strong>{values.length}</strong></header>
      {values.length > 0 ? (
        <ul>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul>
      ) : <p>None recorded</p>}
    </section>
  );
}

export function HandoffPage({ spaceId, refreshKey }: { spaceId: string; refreshKey: number }) {
  const resource = useResource<HandoffSnapshot | undefined>(
    () => inspectorApi.handoff(spaceId),
    [spaceId, refreshKey]
  );
  if (resource.loading) return <LoadingState label="正在读取最新 Handoff…" />;
  if (resource.error) return <ErrorState error={resource.error} />;
  const handoff = resource.data;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="LATEST HANDOFF"
        title="跨 Agent 交接快照"
        description="这是最近一次成功 checkpoint 形成的持久化交接状态，不是 Inspector 的二次摘要。"
      />
      {!handoff ? (
        <section className="panel"><EmptyState icon="handoff" title="还没有 Handoff" description="完成一次带事件的 checkpoint 后，最新交接快照会显示在这里。" /></section>
      ) : (
        <>
          <section className="handoff-hero">
            <div className="handoff-hero__icon"><Icon name="handoff" size={23} /></div>
            <div><span className="eyebrow">CURRENT GOAL</span><h2>{handoff.goal ?? "No goal recorded"}</h2></div>
            <dl>
              <div><dt>Created</dt><dd>{formatDate(handoff.createdAt)}</dd></div>
              <div><dt>Session</dt><dd title={handoff.sessionId}>{compactId(handoff.sessionId)}</dd></div>
              <div><dt>Checkpoint</dt><dd title={handoff.checkpointId}>{compactId(handoff.checkpointId)}</dd></div>
            </dl>
          </section>
          <div className="handoff-grid">
            <HandoffSection title="Active Tasks" values={handoff.activeTasks} icon="check" tone="green" />
            <HandoffSection title="Decisions" values={handoff.decisions} icon="spark" tone="blue" />
            <HandoffSection title="Blockers" values={handoff.blockers} icon="shield" tone="red" />
            <HandoffSection title="Open Questions" values={handoff.openQuestions} icon="eye" tone="amber" />
            <HandoffSection title="Completed" values={handoff.completed} icon="archive" tone="neutral" />
            <HandoffSection title="Next Steps" values={handoff.nextSteps} icon="arrow" tone="violet" />
          </div>
        </>
      )}
    </div>
  );
}
