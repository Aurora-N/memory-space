# MVP evaluation harness

JSON fixtures under `fixtures/` drive automated scenarios for the frozen MVP and provider-integration abilities:

- extraction;
- keyed update/dedup;
- Indexed recall;
- cross-session handoff;
- Codex native lifecycle bootstrap/capture/checkpoint/resume;
- Claude Code native lifecycle bootstrap/capture/checkpoint/resume and cross-provider handoff parity;
- parameterized Codex/Claude same-provider and cross-provider durable Memory;
- SQLite close/reopen, Space isolation, provenance preservation, progressive recall, Handoff advancement, and Codex→Claude→Codex→Claude multi-hop state.

Run them together with unit/integration tests using `pnpm test` or the complete quality gate with `pnpm run check`.

## P7 implicit prompt-time recall

The frozen P7 fixture exercises active-Indexed-only prompt injection, bare and
explicit stable keys, lexical recall, abstention, opt-out, Space/status/tier
isolation, stale-history disclosure, metadata non-disclosure, and all four
Codex/Claude source-to-target pairs:

```bash
pnpm memory-space eval implicit-recall
pnpm memory-space eval implicit-recall --json
```

The runner uses isolated temporary SQLite stores and provider-native event
normalization/rendering, but does not require a daemon or authenticated CLI.
Real native/production bridge evidence is recorded in
[`../docs/reports/quality/P7_PROVIDER_CAPABILITY_SPIKE.md`](../docs/reports/quality/P7_PROVIDER_CAPABILITY_SPIKE.md).

## P8 implicit turn-time remember

The P8 deterministic suite covers opaque assignments, durable decisions,
transient and assistant-only rejection, recalled-content repetition, opt-out,
invalid configuration, replay, checkpoint convergence, Core collision, and
Space mismatch:

```bash
pnpm memory-space eval implicit-remember
pnpm memory-space eval implicit-remember --json
pnpm run smoke:p8 -- --provider claude
```

The evaluator uses only persisted SessionEvents and local deterministic
extraction. Real-provider results are recorded in
[`../docs/reports/quality/P8_IMPLICIT_REMEMBER_RESULT.md`](../docs/reports/quality/P8_IMPLICIT_REMEMBER_RESULT.md).

The P4 cross-session proof is implemented once in `eval/support/cross-session-runner.ts`. The `node:test` wrapper and P5 CLI both call that canonical runner:

```bash
pnpm memory-space eval cross-session
pnpm memory-space eval cross-session --json
```

The runner owns isolated temporary SQLite files and never opens the daemon's configured database. Real Claude model-driven MCP remains a separate waived external acceptance gate and is not reported as deterministic eval PASS.

## P6 deterministic Memory Quality

`quality/` contains the accepted Stage A benchmark and the comparison surface used by later targeted improvements:

```text
quality/
├── baselines/      immutable accepted Stage A retrieval and extraction snapshots
├── baseline.ts     strict snapshot schema/version validation
├── comparison.ts   Stage A versus B1 delta report and acceptance gate
├── extraction-baseline.ts   strict Stage A extraction snapshot validation
├── extraction-comparison.ts Stage A versus B2 extraction comparison/gate
├── fixtures/       independent JSON inputs and expected logical Memory keys
├── fixtures.ts     schema validation and loading
├── identity.ts     random runtime ID to stable fixture-key mapping
├── metrics.ts      deterministic formulas and denominator policy
├── runner.ts       isolated SQLite scenarios and hard correctness checks
├── report.ts       concise human report
└── memory-quality.test.ts
```

Run the accepted benchmark surface through:

```bash
pnpm memory-space eval quality
pnpm memory-space eval quality --json
pnpm memory-space eval quality --compare-stage-a
pnpm memory-space eval quality --compare-stage-a --json
pnpm memory-space eval quality --compare-stage-a-extraction
pnpm memory-space eval quality --compare-stage-a-extraction --json
```

Each invocation creates and removes its own temporary SQLite databases; it does not connect to the daemon or open the daemon database.

Fixture ground truth is declared independently of extractor/search output using stable logical keys. The report covers checkpoint-only extraction, positive-query macro Retrieval Precision@K and Recall@K for meaningful K values from 1/3/5/10, separate negative-query false-positive/abstention metrics, Core pollution, bootstrap critical coverage and size, Handoff completeness, stale and duplicate Memory, supersession, one 20-Session history, and a small provider-neutral proof.

Quality metrics are observations. The CLI exits non-zero only when a hard correctness invariant fails. Per-query K eligibility uses the corpus from the same status/family/type/tier filters. Results retain exact production search order; logical fixture keys never re-rank equal-score results.

Accepted Stage A reference:

```text
9490ebce94928132a2fb16aca247c8ae4888a7cf
```

Evidence:

- [`../docs/reports/quality/P6_BASELINE.md`](../docs/reports/quality/P6_BASELINE.md)
- [`../docs/reviews/CR-PHASE9.md`](../docs/reviews/CR-PHASE9.md)

## P6 Stage B1 comparison rule

Stage B1 is the frozen retrieval-quality optimization and is defined by:

[`../docs/specs/P6_STAGE_B_RETRIEVAL_SPEC.md`](../docs/specs/P6_STAGE_B_RETRIEVAL_SPEC.md)

Before production retrieval changes, the implementation froze the immutable
machine-readable Stage A snapshot at:

```text
eval/quality/baselines/p6-stage-a.json
```

The snapshot must be generated from the accepted Stage A reference and contain stable summary/per-query evidence without runtime UUIDs.

Snapshot schema v2 also freezes query text, relevant logical keys,
positive/negative classification, family/type/tier/status filters, and eligible
corpus size. These contract fields were added without regenerating accepted Stage
A returned results or metrics through the B1 implementation.

Stage B1 candidate evaluation compares that immutable before-state with the new deterministic runner output and reports:

```text
baseline P@K/R@K
candidate P@K/R@K
delta per K
negative-query FP/abstention delta
per-query returned logical keys
removed/new/unchanged failures
hard correctness result
```

Do not overwrite Stage A baseline evidence with candidate values, and do not change accepted fixture relevance labels merely to improve scores.

Stage B1 changes lexical relevance/ranking only and is frozen. Stage B2 changes
deterministic extraction/transient rejection only and is also reviewed/frozen.
The B3 Core/Handoff policy spec is drafted, but implementation is not authorized;
semantic dedup, embeddings/vector search, and new providers remain out of scope.

The comparison command exits non-zero when the Stage B1 delta gate or accepted
hard-correctness checks fail. Regular `eval quality` still separates observational
quality scores from its hard-correctness exit status.

Candidate evidence: [`../docs/reports/quality/P6_STAGE_B1_RESULT.md`](../docs/reports/quality/P6_STAGE_B1_RESULT.md).

## P6 Stage B2 extraction comparison rule

The dedicated accepted extraction before-state is frozen independently at:

```text
eval/quality/baselines/p6-stage-a-extraction.json
```

It records the accepted Stage A commit, ordered event evidence, ordered expected
Memory identities and fields, ordered negative evidence with reasons, and the
accepted 4 TP / 1 FP / 2 FN result. The B2 comparison validates this contract
before measuring the current extractor. Mutated event text/order, labels,
Memory identity or fields, negative evidence/reason, result identities, or
accepted metrics fail before candidate metric comparison.

Use `--compare-stage-a-extraction` for B2 evidence. It reports the accepted and
candidate TP/FP/FN, precision/recall, fixed/removed/new/unchanged failures, hard
correctness, and the B2 acceptance gate. It does not run or relabel the B1
retrieval comparison.

Candidate evidence: [`../docs/reports/quality/P6_STAGE_B2_RESULT.md`](../docs/reports/quality/P6_STAGE_B2_RESULT.md).

The proposed B3 baseline/comparison contract is design-only and is documented in
[`../docs/specs/P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md`](../docs/specs/P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md).
No B3 baseline artifact or comparison command exists until implementation is
separately authorized.
