import { useEffect, useMemo, useRef, useState } from "react";
import { inspectorApi } from "../api/client";
import type { Session, SessionEvent } from "../api/types";
import { SessionEventTrace } from "../components/events/SessionEventTrace";
import { MarkdownContent } from "../components/ui/MarkdownContent";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/States";
import { useResource } from "../hooks/useResource";
import { compactId, formatDate, relativeDate } from "../lib/format";

function eventRole(event: SessionEvent): string {
  return typeof event.payload.role === "string" ? event.payload.role : event.type;
}

function eventContent(event: SessionEvent): string | undefined {
  return typeof event.payload.content === "string" ? event.payload.content : undefined;
}

function eventSummary(event: SessionEvent): string {
  const content = eventContent(event);
  if (!content) return `${event.type} event`;
  const compact = content.replace(/\s+/gu, " ").trim();
  return compact.length > 92 ? `${compact.slice(0, 92)}…` : compact;
}

interface LoadedSessionEvents {
  events: SessionEvent[];
  sessionId: string;
}

export function EventsPage({ refreshKey }: { refreshKey: number }) {
  const sessions = useResource<Session[]>(() => inspectorApi.sessions(), [refreshKey]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const events = useResource<LoadedSessionEvents>(
    async () => ({
      events: selectedSessionId ? await inspectorApi.sessionEvents(selectedSessionId) : [],
      sessionId: selectedSessionId ?? "",
    }),
    [selectedSessionId, refreshKey]
  );
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const eventListRef = useRef<HTMLDivElement>(null);
  const eventItemRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!sessions.data?.length) {
      setSelectedSessionId(undefined);
      return;
    }
    if (!sessions.data.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(sessions.data[0]?.id);
    }
  }, [selectedSessionId, sessions.data]);

  useEffect(() => {
    const loadedEvents = events.data;
    if (events.loading || !loadedEvents || loadedEvents.sessionId !== selectedSessionId) return;
    if (!loadedEvents.events.length) {
      setSelectedEventId(undefined);
      return;
    }
    if (!loadedEvents.events.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(loadedEvents.events.at(-1)?.id);
    }
  }, [events.data, events.loading, selectedEventId, selectedSessionId]);

  const selectedSession = useMemo(
    () => sessions.data?.find((session) => session.id === selectedSessionId),
    [selectedSessionId, sessions.data]
  );
  const sessionEvents = useMemo(() => {
    const loadedEvents = events.data;
    if (!loadedEvents || loadedEvents.sessionId !== selectedSessionId) return undefined;
    return loadedEvents.events.filter((event) => event.sessionId === selectedSessionId);
  }, [events.data, selectedSessionId]);
  const traceEvents = events.data?.events ?? [];
  const selectedEvent = useMemo(
    () => sessionEvents?.find((event) => event.id === selectedEventId),
    [selectedEventId, sessionEvents]
  );
  const selectEvent = (eventId: string): void => {
    setSelectedEventId(eventId);
    window.requestAnimationFrame(() => {
      const container = eventListRef.current;
      const item = eventItemRefs.current.get(eventId);
      if (!container || !item) return;
      container.scrollTo({
        behavior: "smooth",
        top: item.offsetTop - container.clientHeight / 2 + item.clientHeight / 2,
      });
    });
  };

  if (sessions.loading) return <LoadingState label="正在读取会话证据…" />;
  if (sessions.error) return <ErrorState error={sessions.error} />;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="SESSION EVIDENCE"
        title="会话事件"
        description="查看当前 Space 捕获的用户消息与 Agent 回复。完整内容仅在选中事件后显示。"
      />
      {!sessions.data?.length ? (
        <section className="panel">
          <EmptyState
            icon="archive"
            title="还没有会话事件"
            description="Provider lifecycle 捕获到消息后，会话证据会显示在这里。"
          />
        </section>
      ) : (
        <>
          <SessionEventTrace
            events={traceEvents}
            onSelectEvent={selectEvent}
            selectedEventId={selectedEventId}
          />
          <section className="event-explorer">
            <div className="event-sessions">
              <header className="event-column__header">
                <span>SESSIONS</span>
                <strong>{sessions.data.length}</strong>
              </header>
              <div className="event-column__scroll">
                {sessions.data.map((session) => (
                  <button
                    className={
                      session.id === selectedSessionId
                        ? "session-item session-item--active"
                        : "session-item"
                    }
                    key={session.id}
                    onClick={() => {
                      setSelectedEventId(undefined);
                      setSelectedSessionId(session.id);
                    }}
                    type="button"
                  >
                    <span>
                      <strong>{session.provider ?? "generic"}</strong>
                      <small>{relativeDate(session.updatedAt)}</small>
                    </span>
                    <code title={session.id}>{compactId(session.id)}</code>
                    {session.summary && <p>{session.summary}</p>}
                  </button>
                ))}
              </div>
            </div>

            <div className="event-list">
              <header className="event-column__header">
                <span>EVENTS</span>
                <strong>{sessionEvents?.length ?? 0}</strong>
              </header>
              {events.loading ? (
                <LoadingState label="正在读取事件…" />
              ) : events.error ? (
                <ErrorState error={events.error} />
              ) : !sessionEvents?.length ? (
                <EmptyState
                  icon="archive"
                  title="这个 Session 还没有事件"
                  description="尚未捕获可查看的会话证据。"
                />
              ) : (
                <div className="event-column__scroll" ref={eventListRef}>
                  {sessionEvents.map((event) => {
                    const role = eventRole(event);
                    return (
                      <button
                        className={
                          event.id === selectedEventId
                            ? "event-item event-item--active"
                            : "event-item"
                        }
                        key={event.id}
                        onClick={() => selectEvent(event.id)}
                        ref={(element) => {
                          if (element) eventItemRefs.current.set(event.id, element);
                          else eventItemRefs.current.delete(event.id);
                        }}
                        type="button"
                      >
                        <span className={`event-role event-role--${role}`}>{role}</span>
                        <span className="event-item__meta">
                          <strong>#{event.sequence}</strong>
                          <time>{formatDate(event.createdAt)}</time>
                        </span>
                        <p>{eventSummary(event)}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="event-detail">
              <header className="event-column__header">
                <span>FULL CONTENT</span>
                {selectedSession && (
                  <code title={selectedSession.id}>{compactId(selectedSession.id)}</code>
                )}
              </header>
              {!selectedEvent ? (
                <EmptyState
                  icon="search"
                  title="选择一个事件"
                  description="事件正文与持久化元数据将在这里显示。"
                />
              ) : (
                <article className="event-content">
                  <div className="event-content__meta">
                    <span className={`event-role event-role--${eventRole(selectedEvent)}`}>
                      {eventRole(selectedEvent)}
                    </span>
                    <dl>
                      <div>
                        <dt>Sequence</dt>
                        <dd>#{selectedEvent.sequence}</dd>
                      </div>
                      <div>
                        <dt>Type</dt>
                        <dd>{selectedEvent.type}</dd>
                      </div>
                      <div>
                        <dt>Created</dt>
                        <dd>{formatDate(selectedEvent.createdAt)}</dd>
                      </div>
                    </dl>
                  </div>
                  {eventContent(selectedEvent) ? (
                    <MarkdownContent content={eventContent(selectedEvent) ?? ""} />
                  ) : (
                    <p className="event-content__empty">这个事件没有可显示的文本内容。</p>
                  )}
                </article>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
