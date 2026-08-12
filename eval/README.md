# MVP evaluation harness

JSON fixtures under `fixtures/` drive automated scenarios for the four frozen MVP abilities:

- extraction;
- keyed update/dedup;
- Indexed recall;
- cross-session handoff;
- Codex native lifecycle bootstrap/capture/checkpoint/resume;
- Claude Code native lifecycle bootstrap/capture/checkpoint/resume and
  cross-provider handoff parity;
- parameterized Codex/Claude same-provider and cross-provider durable Memory;
- SQLite close/reopen, Space isolation, provenance preservation, progressive
  recall, Handoff advancement, and Codex→Claude→Codex→Claude multi-hop state.

Run them together with unit/integration tests using `pnpm test` or the complete quality gate with `pnpm run check`. New fixtures can extend the scenario arrays without changing persistence or domain code.

The P4 cross-session proof is implemented once in
`eval/support/cross-session-runner.ts`. The `node:test` wrapper and P5 CLI both
call that canonical runner, so the product demo does not maintain a weaker
second implementation:

```bash
pnpm memory-space eval cross-session
pnpm memory-space eval cross-session --json
```

The runner owns only isolated temporary SQLite files and never opens the
daemon's configured database. Real Claude model-driven MCP remains a separate
waived external acceptance gate and is not reported as deterministic eval PASS.

## P6 deterministic Memory Quality baseline

`quality/` measures the current Memory implementation without changing its
algorithms or turning baseline scores into arbitrary test thresholds:

```text
quality/
├── fixtures/       independent JSON inputs and expected logical Memory keys
├── fixtures.ts     schema validation and loading
├── identity.ts     random runtime ID to stable fixture-key mapping
├── metrics.ts      deterministic formulas and zero-denominator policy
├── runner.ts       isolated SQLite scenarios and hard correctness checks
├── report.ts       concise human report
└── memory-quality.test.ts
```

Run it through the product CLI:

```bash
pnpm memory-space eval quality
pnpm memory-space eval quality --json
```

Each invocation creates and removes its own temporary SQLite databases; it does
not connect to the daemon or open the daemon database. Fixture ground truth is
declared independently of extractor/search output using stable logical keys.
The report covers checkpoint-only extraction, macro retrieval Precision@K and
Recall@K for K = 1/3/5/10, Core pollution, bootstrap critical coverage and
size, Handoff completeness, stale and duplicate Memory, supersession, one
20-Session history, and a small provider-neutral proof.

Quality metrics are baseline observations. The CLI exits non-zero only when a
hard correctness invariant fails. Equal-score lexical results are ordered by
fixture logical key for reproducible reporting; production ranking is not
modified. See [`../docs/quality/P6_BASELINE.md`](../docs/quality/P6_BASELINE.md)
for recorded Stage A evidence and observed limitations.
