# MVP evaluation harness

JSON fixtures under `fixtures/` drive automated scenarios for the four frozen MVP abilities:

- extraction;
- keyed update/dedup;
- Indexed recall;
- cross-session handoff;
- Codex native lifecycle bootstrap/capture/checkpoint/resume.

Run them together with unit/integration tests using `pnpm test` or the complete quality gate with `pnpm run check`. New fixtures can extend the scenario arrays without changing persistence or domain code.
