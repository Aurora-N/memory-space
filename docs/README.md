# Documentation

Use this page as the entry point for project documentation. Documents are
grouped by audience and purpose; frozen specifications retain their original
content and status after being moved.

## User Guides

- Codex integration: [English](guides/CODEX_INTEGRATION.md) ·
  [中文](guides/CODEX_INTEGRATION.zh-CN.md)
- Claude Code integration: [English](guides/CLAUDE_CODE_INTEGRATION.md) ·
  [中文](guides/CLAUDE_CODE_INTEGRATION.zh-CN.md)
- Project extraction rules: [English](guides/EXTRACTION_RULES.md) ·
  [中文](guides/EXTRACTION_RULES.zh-CN.md)
- HTTP and daemon API: [English](guides/API.md) · [中文](guides/API.zh-CN.md)

## Specifications

Start with the product and domain contracts:

- [Product specification](specs/PRODUCT_SPEC.md)
- [Domain model](specs/DOMAIN_MODEL.md)
- [Provider integration specification](specs/PROVIDER_INTEGRATION_SPEC.md)
- [Provider integration guardrails](specs/PROVIDER_INTEGRATION_GUARDRAILS.md)

Phase and subsystem specifications:

- [P4 cross-session/provider evaluation](specs/P4_CROSS_SESSION_PROVIDER_EVAL.md)
- [P5 productization](specs/PRODUCTIZATION_SPEC.md)
- [Local Inspector](specs/LOCAL_INSPECTOR_SPEC.md)
- [P6 Memory Quality v1](specs/MEMORY_QUALITY_V1_SPEC.md)
- [P7 implicit recall](specs/P7_IMPLICIT_RECALL_SPEC.md)

Additional P6 stage specifications are under [`specs/`](specs/).

## Plans

- [MVP execution plan](plans/MVP_PLAN.md)
- [Provider integration plan](plans/PROVIDER_INTEGRATION_PLAN.md)
- [v1 roadmap](plans/V1_ROADMAP.md)

Plans describe sequencing and historical execution. Normative behavior remains
defined by the corresponding specification.

## Reports And Reviews

- [`reports/quality/`](reports/quality/) contains quality baselines and phase results.
- [`reports/validation/`](reports/validation/) contains real-provider smoke records.
- [`reviews/`](reviews/) contains historical code-review records.

Reports and reviews are evidence, not current product contracts.

## Decisions And Reference

- [`adr/`](adr/) contains architecture decision records.
- [Workspace conventions](reference/WORKSPACE.md) documents repository layout.

When behavior changes, update the relevant guide and specification. Update a
report, review, or frozen specification only when its governing process
explicitly authorizes that change.
