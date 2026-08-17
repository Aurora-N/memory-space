import type { ReactNode } from "react";
import { useState } from "react";
import type { BindingResult } from "../../api/types";
import { compactId } from "../../lib/format";
import { Icon, type IconName } from "../ui/Icon";

export type PageId = "overview" | "memories" | "disclosure" | "handoff" | "validation";

const navigation: Array<{ id: PageId; label: string; subtitle: string; icon: IconName }> = [
  { id: "overview", label: "Overview", subtitle: "全局概览", icon: "layers" },
  { id: "memories", label: "Memories", subtitle: "浏览与检索", icon: "database" },
  { id: "disclosure", label: "Disclosure", subtitle: "实际注入上下文", icon: "eye" },
  { id: "handoff", label: "Handoff", subtitle: "最新交接快照", icon: "handoff" },
  { id: "validation", label: "Validation", subtitle: "存储与披露验证", icon: "shield" }
];

export function AppShell({
  binding,
  page,
  onNavigate,
  onRefresh,
  refreshing,
  children
}: {
  binding: BindingResult;
  page: PageId;
  onNavigate: (page: PageId) => void;
  onRefresh: () => void;
  refreshing: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = (next: PageId): void => {
    onNavigate(next);
    setMenuOpen(false);
  };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar--open" : ""}`}>
        <div className="brand">
          <span className="brand__mark"><Icon name="spark" size={20} /></span>
          <div>
            <strong>memory-space</strong>
            <small>LOCAL INSPECTOR</small>
          </div>
          <button className="icon-button sidebar__close" onClick={() => setMenuOpen(false)} type="button">
            <Icon name="close" />
          </button>
        </div>

        <nav className="nav" aria-label="Inspector 页面">
          {navigation.map((item) => (
            <button
              aria-current={page === item.id ? "page" : undefined}
              className={page === item.id ? "nav__item nav__item--active" : "nav__item"}
              key={item.id}
              onClick={() => navigate(item.id)}
              type="button"
            >
              <Icon name={item.icon} />
              <span><strong>{item.label}</strong><small>{item.subtitle}</small></span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </nav>

        <div className="sidebar__space">
          <span className="sidebar__space-label">BOUND SPACE</span>
          <strong>{binding.space.name}</strong>
          <code title={binding.space.id}>{compactId(binding.space.id)}</code>
          <span className="sidebar__binding" title={binding.binding.configPath ?? "MEMORY_SPACE_SPACE_ID"}>
            <i /> {binding.binding.source === "config" ? "Project config" : "Explicit binding"}
          </span>
        </div>

        <div className="sidebar__footer">
          <Icon name="shield" size={15} />
          <span><strong>Local · Read only</strong><small>不会修改 Memory state</small></span>
        </div>
      </aside>
      {menuOpen && <button className="mobile-scrim" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />}

      <div className="workspace">
        <header className="topbar">
          <button className="icon-button topbar__menu" aria-label="打开菜单" onClick={() => setMenuOpen(true)}>
            <Icon name="menu" />
          </button>
          <div className="topbar__space">
            <span>Space</span>
            <strong>{binding.space.name}</strong>
            <small>{binding.binding.source === "config" ? binding.binding.configPath : "MEMORY_SPACE_SPACE_ID"}</small>
          </div>
          <div className="topbar__actions">
            <span className="live-pill"><i /> daemon connected</span>
            <button className="button button--secondary" disabled={refreshing} onClick={onRefresh} type="button">
              <Icon className={refreshing ? "spin" : ""} name="refresh" size={16} />
              刷新
            </button>
          </div>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
