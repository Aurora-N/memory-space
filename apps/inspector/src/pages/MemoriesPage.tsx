import { useEffect, useMemo, useState } from "react";
import { inspectorApi } from "../api/client";
import type { Memory, MemoryFamily, MemoryStatus, MemoryTier, SearchResult } from "../api/types";
import { useResource } from "../hooks/useResource";
import { MemoryList } from "../components/memory/MemoryList";
import { Icon } from "../components/ui/Icon";
import { PageHeader } from "../components/ui/PageHeader";
import { ErrorState, LoadingState } from "../components/ui/States";

interface Filters {
  tier: "" | MemoryTier;
  status: "" | MemoryStatus;
  family: "" | MemoryFamily;
  type: string;
}

const initialFilters: Filters = { tier: "", status: "", family: "", type: "" };

export function MemoriesPage({
  spaceId,
  refreshKey,
  onSelectMemory
}: {
  spaceId: string;
  refreshKey: number;
  onSelectMemory: (memoryId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [scores, setScores] = useState<Map<string, number>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const overview = useResource(() => inspectorApi.overview(spaceId), [spaceId, refreshKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const apiFilters = useMemo(() => ({
    tiers: filters.tier ? [filters.tier] : undefined,
    statuses: filters.status ? [filters.status] : undefined,
    families: filters.family ? [filters.family] : undefined,
    types: filters.type ? [filters.type] : undefined
  }), [filters]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    const operation: Promise<Memory[] | SearchResult[]> = debouncedQuery
      ? inspectorApi.search(spaceId, debouncedQuery, apiFilters)
      : inspectorApi.allMemories(spaceId, apiFilters);
    void operation.then((result) => {
      if (!active) return;
      if (debouncedQuery) {
        const searchResults = result as SearchResult[];
        setMemories(searchResults.map((entry) => entry.memory));
        setScores(new Map(searchResults.map((entry) => [entry.memory.id, entry.score])));
      } else {
        setMemories(result as Memory[]);
        setScores(undefined);
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [spaceId, refreshKey, debouncedQuery, apiFilters]);

  const hasFilters = Object.values(filters).some(Boolean) || query.length > 0;
  const clear = (): void => {
    setQuery("");
    setDebouncedQuery("");
    setFilters(initialFilters);
  };
  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]): void => {
    setFilters((current) => ({ ...current, [key]: value }));
  };
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="MEMORY EXPLORER"
        title="浏览持久化记忆"
        description="空搜索使用数据库浏览顺序；输入查询后才使用生产检索排序。两种结果不会混淆。"
      />

      <section className="panel explorer-panel">
        <div className="search-box">
          <Icon name="search" />
          <input
            aria-label="搜索 Memory"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 key、内容或当前值…"
            type="search"
            value={query}
          />
          {query && <button aria-label="清除搜索" className="icon-button" onClick={() => setQuery("")}><Icon name="close" size={15} /></button>}
        </div>
        <div className="filter-row">
          <label>Tier<select value={filters.tier} onChange={(event) => setFilter("tier", event.target.value as Filters["tier"])}><option value="">全部</option><option value="core">Core</option><option value="indexed">Indexed</option></select></label>
          <label>Status<select value={filters.status} onChange={(event) => setFilter("status", event.target.value as Filters["status"])}><option value="">全部</option><option value="active">Active</option><option value="resolved">Resolved</option><option value="superseded">Superseded</option><option value="archived">Archived</option></select></label>
          <label>Family<select value={filters.family} onChange={(event) => setFilter("family", event.target.value as Filters["family"])}><option value="">全部</option><option value="knowledge">Knowledge</option><option value="state">State</option><option value="episode">Episode</option><option value="procedure">Procedure</option></select></label>
          <label>Type<select value={filters.type} onChange={(event) => setFilter("type", event.target.value)}><option value="">全部</option>{Object.keys(overview.data?.counts.types ?? {}).map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          {hasFilters && <button className="button button--ghost" onClick={clear} type="button">清除筛选</button>}
        </div>
        <div className="result-summary">
          <span>{debouncedQuery ? "检索结果" : "持久化记录"}</span>
          <strong>{loading ? "…" : memories.length}</strong>
          {debouncedQuery && <small>按生产 relevance order</small>}
        </div>
        {loading && memories.length === 0 && <LoadingState label="正在读取 Memory…" />}
        {error && <ErrorState error={error} />}
        {!error && (!loading || memories.length > 0) && (
          <MemoryList memories={memories} onSelect={onSelectMemory} scores={scores} />
        )}
      </section>
    </div>
  );
}
