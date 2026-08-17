# P5.1 — Local Memory Inspector

Status: IMPLEMENTED / READ-ONLY

## Goal

Expose trusted, local observability over one daemon-bound Space without changing
Memory semantics. The Inspector answers five questions:

1. What has the project remembered?
2. Which Memory is Core versus Indexed?
3. What context will the next Agent actually receive?
4. What is the latest persisted Handoff?
5. Which stored records were excluded from default disclosure?

## Architecture

```text
Browser
  └─ /inspector/ (React + TypeScript + Vite)
       └─ same-origin read API
            └─ loopback memory-space daemon
                 └─ MemorySpace application API
                      └─ MemoryStore
                           └─ SQLite
```

The Inspector never opens SQLite and never obtains `memorySpace.store`. The
daemon remains the single durable-store owner. Browse and overview are explicit
read-only application methods; bootstrap and Handoff views consume the existing
production policy output.

## Trusted Space resolution

The browser cannot select or submit a trusted `spaceId`. It calls
`GET /inspector/api/binding`, which uses the same daemon runtime resolution as
MCP and lifecycle handling:

1. `MEMORY_SPACE_SPACE_ID`, when explicitly configured;
2. otherwise `MEMORY_SPACE_CWD` (or daemon cwd) and the nearest ancestor
   `.memory-space/config.json`.

The returned config path is shown only in the local UI for diagnostics. Query
parameters cannot override the binding. Multi-Space management is not part of
this release.

## Pages

- **Overview** — total/Core/Indexed/active counts, type distribution, recent
  Memory, and latest Handoff summary.
- **Memories** — browse, lexical search, tier/status/family/type filters, and a
  detail drawer with persisted fields, provenance, structured data, and history.
- **Disclosure** — stored state next to the exact production `bootstrap()`
  context and its Core/Handoff pipeline.
- **Handoff** — latest immutable Handoff goal, tasks, decisions, blockers,
  questions, completed items, and next steps.
- **Validation** — Stored versus Disclosed counts, exclusion categories, and
  Handoff coverage for local validation and demonstrations.

When an Indexed Memory lacks a persisted admission explanation, the UI says
`Admission explanation unavailable`. It never reruns a classifier or infers a
reason from current content.

## Read API

| Endpoint | Purpose |
| --- | --- |
| `GET /inspector/api/binding` | Resolve the one trusted Space and local binding source. |
| `GET /spaces/:spaceId/overview` | Counts, recent Memory, and latest Handoff summary. |
| `GET /spaces/:spaceId/memories` | Deterministic, cursor-paginated database browsing. |
| `GET /spaces/:spaceId/memories/search` | Existing production lexical search. |
| `GET /memories/:memoryId` | Existing Memory detail. |
| `GET /memories/:memoryId/history` | Existing immutable Memory history. |
| `GET /spaces/:spaceId/bootstrap` | Existing production default context. |
| `GET /spaces/:spaceId/handoff/latest` | Existing latest Handoff. |

Browse accepts comma-separated `families`, `types`, `tiers`, and `statuses`, a
`limit` from 1 to 100, and an opaque `cursor`. Unlike search, omitted statuses
mean all statuses. It orders by latest `updatedAt`, then ID, and does not reuse
or alter retrieval ranking.

## Security and mutation boundary

- The Inspector is served only by the existing loopback-only daemon.
- All requests retain the daemon's localhost Host/Origin checks.
- Static responses include a same-origin Content Security Policy, no-referrer,
  no-sniff, and frame-denial headers.
- The UI exposes only refresh, search, filter, inspect, and copy-ID operations.
- It has no create, edit, delete, promote, demote, resolve, or Space-management
  control.
- v1 has no authentication and must not be exposed to LAN or the public
  internet.

## Run

Production-style, same-origin use:

```bash
pnpm inspector:build
MEMORY_SPACE_CWD=/absolute/path/to/bound/project pnpm start
```

Then open <http://127.0.0.1:4310/inspector/>.

Frontend development uses the same daemon with Vite's local proxy:

```bash
pnpm inspector:dev
```

Open <http://127.0.0.1:5173/inspector/>.

## Non-goals

- No Memory policy, extraction, retrieval, domain, lifecycle, MCP, checkpoint,
  or Handoff behavior changes.
- No Memory mutation UI or Memory CMS.
- No Sessions/checkpoint/event explorer in v0.1.
- No list/create/delete Space manager.
- No raw SQLite access or second database owner.
- No remote hosting, authentication, knowledge graph, or inferred relationships.
- No semantic retrieval, embeddings, vector database, or B4 work.
