import type { IconName } from "./Icon";
import { Icon } from "./Icon";

export function MetricCard({
  label,
  value,
  note,
  icon,
  tone = "neutral"
}: {
  label: string;
  value: number | string;
  note: string;
  icon: IconName;
  tone?: "neutral" | "green" | "amber" | "blue";
}) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__top">
        <span>{label}</span>
        <span className="metric-card__icon"><Icon name={icon} size={17} /></span>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
