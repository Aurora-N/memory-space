import { useEffect, useState } from "react";
import { inspectorApi } from "../../api/client";
import type { Memory, MemoryHistoryRecord, Session } from "../../api/types";
import { compactId, formatDate, percent } from "../../lib/format";
import { Badge } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { ErrorState, LoadingState } from "../ui/States";

interface DrawerData {
  memory: Memory;
  history: MemoryHistoryRecord[];
  session?: Session;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail-pair">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function promotionExplanation(data: DrawerData): string | undefined {
  if (data.memory.tier !== "core") return undefined;
  const promotion = [...data.history].reverse().find((entry) => entry.operation.startsWith("promote"));
  return promotion?.reason;
}

export function MemoryDrawer({ memoryId, onClose }: { memoryId?: string; onClose: () => void }) {
  const [data, setData] = useState<DrawerData>();
  const [error, setError] = useState<Error>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!memoryId) return;
    let active = true;
    setData(undefined);
    setError(undefined);
    void Promise.all([inspectorApi.memory(memoryId), inspectorApi.history(memoryId)])
      .then(async ([memory, history]) => {
        let session: Session | undefined;
        if (memory.sourceSessionId) {
          try {
            session = await inspectorApi.session(memory.sourceSessionId);
          } catch {
            // The immutable Memory remains inspectable if old provenance cannot be resolved.
          }
        }
        if (active) setData({ memory, history, session });
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
      });
    return () => { active = false; };
  }, [memoryId]);

  useEffect(() => {
    if (!memoryId) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("drawer-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("drawer-open");
    };
  }, [memoryId, onClose]);

  if (!memoryId) return null;
  const copyId = (): void => {
    const operation = navigator.clipboard?.writeText(memoryId);
    if (!operation) return;
    void operation.then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {
      // Clipboard permission is browser-controlled; inspection remains available.
    });
  };

  return (
    <div className="drawer-layer" role="presentation">
      <button className="drawer-scrim" aria-label="关闭详情" onClick={onClose} type="button" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Memory 详情">
        <header className="drawer__header">
          <div>
            <span className="eyebrow">MEMORY DETAIL</span>
            <h2>记忆详情</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose} type="button">
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer__body">
          {!data && !error && <LoadingState label="正在读取详情和历史…" />}
          {error && <ErrorState error={error} />}
          {data && (
            <>
              <section className="memory-hero">
                <div className="badge-line">
                  <Badge tone={data.memory.tier}>{data.memory.tier}</Badge>
                  <Badge>{data.memory.type}</Badge>
                  <Badge tone={data.memory.status === "active" ? "active" : "muted"}>{data.memory.status}</Badge>
                </div>
                <h3>{data.memory.key ?? "Unkeyed Memory"}</h3>
                <p>{data.memory.content}</p>
              </section>

              <section className="drawer-section">
                <div className="drawer-section__title">
                  <h3>属性</h3>
                  <button className="copy-button" onClick={copyId} type="button">
                    <Icon name={copied ? "check" : "copy"} size={14} />
                    {copied ? "已复制" : "复制 ID"}
                  </button>
                </div>
                <dl className="detail-grid">
                  <Detail label="Memory ID"><code title={data.memory.id}>{compactId(data.memory.id)}</code></Detail>
                  <Detail label="Family">{data.memory.family}</Detail>
                  <Detail label="Version">v{data.memory.version}</Detail>
                  <Detail label="Importance">{percent(data.memory.importance)}</Detail>
                  <Detail label="Confidence">{percent(data.memory.confidence)}</Detail>
                  <Detail label="Created">{formatDate(data.memory.createdAt)}</Detail>
                  <Detail label="Updated">{formatDate(data.memory.updatedAt)}</Detail>
                </dl>
              </section>

              <section className="drawer-section">
                <h3>Core admission</h3>
                {data.memory.tier === "core" ? (
                  <p className="fact-note">
                    当前持久化 tier 为 Core。
                    {promotionExplanation(data) && <> 记录原因：{promotionExplanation(data)}</>}
                  </p>
                ) : (
                  <p className="fact-note fact-note--muted">
                    Admission explanation unavailable. Inspector 不会重新运行分类器或猜测原因。
                  </p>
                )}
              </section>

              <section className="drawer-section">
                <h3>Provenance</h3>
                <dl className="detail-grid">
                  <Detail label="Provider">{data.session?.provider ?? "unknown"}</Detail>
                  <Detail label="Agent">{data.memory.sourceAgentId ?? data.session?.agentId ?? "unknown"}</Detail>
                  <Detail label="Session">
                    <code title={data.memory.sourceSessionId}>{compactId(data.memory.sourceSessionId)}</code>
                  </Detail>
                </dl>
              </section>

              {data.memory.data && Object.keys(data.memory.data).length > 0 && (
                <section className="drawer-section">
                  <h3>Structured data</h3>
                  <pre className="code-panel">{JSON.stringify(data.memory.data, null, 2)}</pre>
                </section>
              )}

              <section className="drawer-section">
                <h3>History</h3>
                {data.history.length === 0 ? (
                  <p className="muted-copy">没有可用的历史记录。</p>
                ) : (
                  <ol className="timeline">
                    {[...data.history].reverse().map((entry) => (
                      <li key={entry.id}>
                        <span className="timeline__dot" />
                        <div>
                          <div className="timeline__top">
                            <strong>{entry.operation}</strong>
                            <time>{formatDate(entry.createdAt)}</time>
                          </div>
                          {entry.reason && <p>{entry.reason}</p>}
                          {entry.sourceEventIds.length > 0 && (
                            <small>{entry.sourceEventIds.length} source event(s)</small>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
