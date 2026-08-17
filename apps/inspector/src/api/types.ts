export type MemoryFamily = "knowledge" | "state" | "episode" | "procedure";
export type MemoryTier = "core" | "indexed";
export type MemoryStatus = "active" | "resolved" | "superseded" | "archived";

export interface Space {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  spaceId: string;
  agentId?: string;
  provider?: string;
  externalSessionId?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Memory {
  id: string;
  spaceId: string;
  family: MemoryFamily;
  type: string;
  key?: string;
  content: string;
  data?: Record<string, unknown>;
  tier: MemoryTier;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  sourceSessionId?: string;
  sourceAgentId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryHistoryRecord {
  id: number;
  memoryId: string;
  operation: string;
  before?: Memory;
  after?: Memory;
  reason?: string;
  sourceSessionId?: string;
  sourceEventIds: string[];
  createdAt: string;
}

export interface HandoffSnapshot {
  id: string;
  spaceId: string;
  sessionId: string;
  checkpointId: string;
  goal?: string;
  completed: string[];
  activeTasks: string[];
  decisions: string[];
  blockers: string[];
  openQuestions: string[];
  nextSteps: string[];
  createdAt: string;
}

export interface BootstrapResult {
  space: Space;
  coreMemories: Memory[];
  handoffSnapshot?: HandoffSnapshot;
  context: string;
}

export interface OverviewResult {
  space: Space;
  totalMemories: number;
  counts: {
    tiers: Record<string, number>;
    statuses: Record<string, number>;
    families: Record<string, number>;
    types: Record<string, number>;
  };
  recentMemories: Memory[];
  latestHandoff?: HandoffSnapshot;
}

export interface BindingResult {
  space: Space;
  binding: {
    spaceId: string;
    source: "explicit" | "config";
    configPath?: string;
  };
  cwd?: string;
  capabilities: {
    readOnly: true;
    localOnly: true;
    multiSpaceManagement: false;
  };
}

export interface BrowseResult {
  items: Memory[];
  total: number;
  nextCursor?: string;
}

export interface MemoryFilters {
  families?: MemoryFamily[];
  types?: string[];
  tiers?: MemoryTier[];
  statuses?: MemoryStatus[];
}

export interface SearchResult {
  memory: Memory;
  score: number;
}
