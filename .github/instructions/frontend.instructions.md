---
applyTo: "packages/web/**/*.ts,packages/web/**/*.tsx,packages/web/**/*.css,packages/web/**/*.mjs,packages/web/**/*.html"
---

# Lyra frontend instructions

- Keep navigation, routes, unsaved-change guards, persisted run recovery, and safe-link handling intact.
- Use existing shared components, tokens, spacing, surfaces, and brand accents before introducing new visual primitives.
- Product copy must distinguish implemented behavior from planned behavior. “Technical review” must not imply semantic, dramatic, identity, or aesthetic approval.
- Never place secrets or private endpoints in browser storage, source files, `VITE_` variables, rendered HTML, logs, or error messages.
- Do not automatically load or play untrusted remote media. Use validated local media routes or explicit user-opened HTTPS links.
- Preserve keyboard access, visible focus, semantic controls, explicit labels, reduced-motion behavior, and mobile layouts without horizontal overflow.
- Add or update focused tests in `packages/web/tests/` for navigation, parsing, recovery, consent, and state-transition behavior.
- Run `npm --prefix packages/web test` and `npm --prefix packages/web run build` before finishing.

Current branch/review rules: root `AGENTS.md`. Capability claims: `docs/feature-status.md`. Legacy OHAO filenames remain aliases; they do not select an old product or branch policy.
