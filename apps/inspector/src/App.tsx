import { useCallback, useEffect, useState } from "react";
import { inspectorApi } from "./api/client";
import type { BindingResult } from "./api/types";
import { AppShell, type PageId } from "./components/layout/AppShell";
import { MemoryDrawer } from "./components/memory/MemoryDrawer";
import { Icon } from "./components/ui/Icon";
import { LoadingState } from "./components/ui/States";
import { DisclosurePage } from "./pages/DisclosurePage";
import { HandoffPage } from "./pages/HandoffPage";
import { MemoriesPage } from "./pages/MemoriesPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ValidationPage } from "./pages/ValidationPage";

const pages = new Set<PageId>(["overview", "memories", "disclosure", "handoff", "validation"]);

function pageFromHash(): PageId {
  const value = window.location.hash.slice(1) as PageId;
  return pages.has(value) ? value : "overview";
}

function SetupError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <main className="setup-screen">
      <div className="setup-card">
        <span className="brand__mark brand__mark--large"><Icon name="spark" size={26} /></span>
        <span className="eyebrow">MEMORY SPACE INSPECTOR</span>
        <h1>无法读取当前绑定的 Space</h1>
        <p>{error.message}</p>
        <div className="setup-command">
          <span>先在项目目录完成初始化</span>
          <code>pnpm memory-space init</code>
        </div>
        <button className="button button--primary" onClick={onRetry} type="button">
          <Icon name="refresh" size={16} />重新连接
        </button>
        <small>Inspector 只连接 127.0.0.1 daemon，不提供手动 Space 切换或远程访问。</small>
      </div>
    </main>
  );
}

export function App() {
  const [binding, setBinding] = useState<BindingResult>();
  const [bindingError, setBindingError] = useState<Error>();
  const [bindingKey, setBindingKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>();

  useEffect(() => {
    let active = true;
    setBindingError(undefined);
    void inspectorApi.binding().then((result) => {
      if (active) setBinding(result);
    }).catch((reason: unknown) => {
      if (active) setBindingError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => { active = false; };
  }, [bindingKey]);

  useEffect(() => {
    const onHashChange = (): void => setPage(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = (next: PageId): void => {
    setPage(next);
    window.location.hash = next;
  };
  const refresh = (): void => {
    setRefreshing(true);
    setBindingKey((value) => value + 1);
    setRefreshKey((value) => value + 1);
    window.setTimeout(() => setRefreshing(false), 500);
  };
  const closeDrawer = useCallback(() => setSelectedMemoryId(undefined), []);

  if (!binding && !bindingError) {
    return <main className="boot-screen"><div className="boot-mark"><Icon name="spark" size={23} /></div><LoadingState label="正在连接本地 Memory Space…" /></main>;
  }
  if (bindingError) return <SetupError error={bindingError} onRetry={() => setBindingKey((value) => value + 1)} />;
  if (!binding) return null;

  const content = (() => {
    const props = { spaceId: binding.space.id, refreshKey };
    switch (page) {
      case "memories": return <MemoriesPage {...props} onSelectMemory={setSelectedMemoryId} />;
      case "disclosure": return <DisclosurePage {...props} onSelectMemory={setSelectedMemoryId} />;
      case "handoff": return <HandoffPage {...props} />;
      case "validation": return <ValidationPage {...props} onSelectMemory={setSelectedMemoryId} />;
      case "overview":
      default: return <OverviewPage {...props} onSelectMemory={setSelectedMemoryId} />;
    }
  })();

  return (
    <>
      <AppShell
        binding={binding}
        page={page}
        onNavigate={navigate}
        onRefresh={refresh}
        refreshing={refreshing}
      >
        {content}
      </AppShell>
      <MemoryDrawer memoryId={selectedMemoryId} onClose={closeDrawer} />
    </>
  );
}
