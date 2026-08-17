import { displayLabel } from "../../lib/format";

interface BadgeProps {
  children: string;
  tone?: "core" | "indexed" | "active" | "muted" | "accent" | "warning";
}

export function Badge({ children, tone = "muted" }: BadgeProps) {
  return <span className={`badge badge--${tone}`}>{displayLabel(children)}</span>;
}
