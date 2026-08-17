import type { ReactNode } from "react";
import { Icon } from "./Icon";

export function LoadingState({ label = "正在读取本地 Memory…" }: { label?: string }) {
  return (
    <div className="state state--loading" role="status">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  icon = "archive",
  title,
  description,
  children
}: {
  icon?: "archive" | "handoff" | "search";
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="state state--empty">
      <span className="state__icon"><Icon name={icon} size={22} /></span>
      <strong>{title}</strong>
      <p>{description}</p>
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <span className="state__eyebrow">READ ERROR</span>
      <strong>暂时无法读取 Memory Space</strong>
      <p>{error.message}</p>
      {onRetry && <button className="button button--secondary" onClick={onRetry}>重新读取</button>}
    </div>
  );
}
