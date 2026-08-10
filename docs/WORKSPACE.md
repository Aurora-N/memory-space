# pnpm workspace conventions

The MVP currently lives in the workspace root to preserve its package API and avoid a non-functional source move. The workspace is ready to grow along these boundaries:

```text
memory-space/
├── apps/       # deployable HTTP servers, workers, CLIs, or provider adapters
├── packages/   # reusable domain, persistence, SDK, and shared packages
├── tools/      # repository-only build, migration, and evaluation tooling
└── src/        # current MVP root package
```

## Commands

```bash
pnpm install
pnpm run check
pnpm run check:workspace
```

- `check` validates the current root package.
- `check:workspace` runs the `check` script in the root and every future workspace package that defines one.
- A single root `pnpm-lock.yaml` records dependency resolution for the entire workspace.
- Shared toolchain versions live in the root `catalog`; packages reference them with `catalog:` to prevent version drift.

CI should install with `pnpm install --frozen-lockfile` so dependency drift fails the build instead of rewriting the shared lockfile.

## Adding a package

Give every package a unique scoped name, for example `@memory-space/postgres`, and keep internal dependencies explicit:

```json
{
  "name": "@memory-space/postgres",
  "private": true,
  "dependencies": {
    "memory-space": "workspace:*"
  },
  "devDependencies": {
    "typescript": "catalog:"
  }
}
```

Use `workspace:*` for internal dependencies so a registry package cannot be substituted accidentally. Each package should expose its own `test`, `typecheck`, and `check` scripts when applicable.

Moving the existing root package into `packages/core` is deliberately deferred until a real second package exists. At that point the move should include an export/import compatibility plan rather than silently changing the current API.
