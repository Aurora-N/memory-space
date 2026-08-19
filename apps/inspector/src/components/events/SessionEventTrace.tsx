import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionEvent } from "../../api/types";
import { Icon } from "../ui/Icon";

type EventLane = "user" | "assistant" | "tool" | "other";

const eventLanes: Array<{ id: EventLane; label: string }> = [
  { id: "user", label: "Input" },
  { id: "assistant", label: "Model" },
  { id: "tool", label: "Tools" },
  { id: "other", label: "Other" },
];

interface TraceTooltip {
  left: number;
  summary: string;
  top: number;
}

interface SessionEventTraceProps {
  events: SessionEvent[];
  onSelectEvent: (eventId: string) => void;
  selectedEventId?: string;
}

function eventRole(event: SessionEvent): string {
  return typeof event.payload.role === "string" ? event.payload.role : event.type;
}

function eventLane(event: SessionEvent): EventLane {
  const role = eventRole(event);
  if (role === "user" || role === "assistant") return role;
  if (event.type === "tool_call" || role === "tool") return "tool";
  return "other";
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

export function SessionEventTrace({
  events,
  onSelectEvent,
  selectedEventId,
}: SessionEventTraceProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [tooltip, setTooltip] = useState<TraceTooltip>();
  const laneEvents = useMemo(
    () =>
      eventLanes
        .map((lane) => ({
          ...lane,
          events: events.filter((event) => eventLane(event) === lane.id),
        }))
        .filter((lane) => lane.events.length > 0),
    [events]
  );
  const eventPositions = useMemo(
    () => new Map(events.map((event, index) => [event.id, index])),
    [events]
  );
  const selectedEvent = events.find((event) => event.id === selectedEventId);
  const selectedEventIndex = selectedEvent ? (eventPositions.get(selectedEvent.id) ?? 0) : 0;
  const selectedEventPosition =
    events.length > 0 ? `${(selectedEventIndex / events.length) * 100}%` : "0";

  const showTooltip = (event: SessionEvent, target: HTMLButtonElement): void => {
    const rect = target.getBoundingClientRect();
    const halfWidth = Math.min(140, window.innerWidth / 2 - 12);
    setTooltip({
      left: Math.min(
        window.innerWidth - halfWidth - 8,
        Math.max(halfWidth + 8, rect.left + rect.width / 2)
      ),
      summary: `#${event.sequence} ${eventSummary(event)}`,
      top: rect.top - 8,
    });
  };

  if (events.length === 0) return null;

  return (
    <>
      <section className="event-trace" aria-label="Session event trace">
        <header className="event-trace__header">
          <strong>Sequence</strong>
          <div className="event-trace__legend">
            {laneEvents.map((lane) => (
              <span
                className={`event-trace__legend-item event-trace__legend-item--${lane.id}`}
                key={lane.id}
              >
                <i />
                {lane.label}
              </span>
            ))}
          </div>
          <span>{events.length} events</span>
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开事件轨迹" : "收起事件轨迹"}
            className="event-trace__toggle"
            onClick={() => {
              setCollapsed((current) => !current);
              setTooltip(undefined);
            }}
            title={collapsed ? "展开事件轨迹" : "收起事件轨迹"}
            type="button"
          >
            <Icon
              className={collapsed ? undefined : "event-trace__toggle-icon--expanded"}
              name="chevron"
              size={13}
            />
          </button>
        </header>
        {!collapsed && (
          <div className="event-trace__viewport" onScroll={() => setTooltip(undefined)}>
            <div
              className="event-trace__chart"
              style={{ "--event-count": events.length } as React.CSSProperties}
            >
              <div className="event-trace__lanes">
                <span aria-hidden="true" className="event-trace__cursor-track">
                  <i className="event-trace__cursor" style={{ left: selectedEventPosition }} />
                </span>
                {laneEvents.map((lane) => (
                  <div className="event-trace__lane" key={lane.id}>
                    <span className="event-trace__label">{lane.label}</span>
                    <div className="event-trace__track">
                      {lane.events.map((event) => {
                        const position = eventPositions.get(event.id) ?? 0;
                        const activeClass =
                          event.id === selectedEventId ? " event-trace__node--active" : "";
                        return (
                          <button
                            aria-label={`${lane.label} event ${event.sequence}: ${eventSummary(event)}`}
                            className={`event-trace__node event-trace__node--${lane.id}${activeClass}`}
                            key={event.id}
                            onBlur={() => setTooltip(undefined)}
                            onClick={() => {
                              setTooltip(undefined);
                              onSelectEvent(event.id);
                            }}
                            onFocus={(focusEvent) => showTooltip(event, focusEvent.currentTarget)}
                            onMouseEnter={(mouseEvent) =>
                              showTooltip(event, mouseEvent.currentTarget)
                            }
                            onMouseLeave={() => setTooltip(undefined)}
                            style={{ left: `${(position / events.length) * 100}%` }}
                            type="button"
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="event-trace__axis">
                <span>#{events[0]?.sequence}</span>
                {selectedEvent &&
                  selectedEventIndex > 0 &&
                  selectedEventIndex < events.length - 1 && (
                    <strong style={{ left: selectedEventPosition }}>
                      #{selectedEvent.sequence}
                    </strong>
                  )}
                <span>#{events.at(-1)?.sequence}</span>
              </div>
            </div>
          </div>
        )}
      </section>
      {tooltip &&
        createPortal(
          <div
            className="event-trace__tooltip"
            role="tooltip"
            style={{ left: tooltip.left, top: tooltip.top }}
          >
            {tooltip.summary}
          </div>,
          document.body
        )}
    </>
  );
}
