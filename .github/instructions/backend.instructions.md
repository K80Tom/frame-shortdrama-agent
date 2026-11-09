---
applyTo: "packages/main/src/**/*.ts,packages/main/tests/**/*.cjs,packages/main/migrations/**/*.sql,packages/main/scripts/**/*.mjs,packages/main/.env.example"
---

# Lyra backend and production instructions

- Keep NestJS controllers limited to transport concerns. Put validation, orchestration, persistence, media handling, and provider coordination in dedicated modules and services.
- Parse unknown input through explicit contracts. Reject extra fields where the public contract is closed, and keep persisted snapshots detached and immutable.
- For paid or external operations, persist intent before submission, reuse stable request or operation keys, and reconcile unknown outcomes without automatic resubmission.
- A failed task invalidates only the smallest dependent subgraph. Never lower a confirmed quality gate or fabricate a successful artifact to complete a run.
- Preserve budget reserve, settle, and release accounting. A new model-assisted step must declare how its cost enters the run budget before it is enabled by default.
- Media ingestion must retain HTTPS validation, DNS/address checks, download bounds, content hashing, `ffprobe` validation, controlled local paths, and sanitized process errors.
- SQL must be parameterized. New persisted fields require an explicit migration, checksum coverage, repository mapping, and database integration coverage where applicable.
- Do not call real providers in tests. Use injected transports, deterministic fake clocks, temporary directories, and bounded fixtures.
- Run `npm --prefix packages/main test` before finishing backend or orchestration work.

Current branch/review rules: root `AGENTS.md`. Capability claims: `docs/feature-status.md`. Legacy OHAO filenames remain aliases; they do not select an old product or branch policy.
