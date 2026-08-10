# ADR 0002: Use Node's built-in test runner for the MVP

- Status: accepted for MVP
- Date: 2026-08-10

## Context

The MVP test suite exercises a TypeScript domain service, a SQLite persistence adapter, the in-memory HTTP adapter boundary, and JSON-driven evaluation fixtures. It does not currently test browser UI, framework components, fake timers, or modules requiring extensive mocking.

## Decision

Continue using `node:test` with Node's TypeScript type stripping instead of adding Vitest now.

The built-in runner already provides the capabilities currently required:

- asynchronous tests and lifecycle cleanup;
- parallel test-file execution;
- assertions through `node:assert/strict`;
- test name filtering and watch mode;
- no additional test runtime or transform configuration;
- behavior close to the Node runtime used by the application.

## Revisit triggers

Re-evaluate Vitest when one or more of these become real requirements:

- a frontend or component test suite is introduced;
- extensive module mocking, fake timers, or snapshot tooling is needed;
- built-in coverage reporting cannot satisfy an enforced coverage threshold;
- developer watch-mode performance becomes measurably inadequate;
- the project adopts Vite and sharing its transform/plugin pipeline materially simplifies tests.

Migration remains straightforward because tests use conventional `test` and assertion patterns and domain dependencies are injected through ports.
