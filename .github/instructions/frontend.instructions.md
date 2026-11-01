---
applyTo: "shortdrama-agent-lab/web/**/*.ts,shortdrama-agent-lab/web/**/*.tsx,shortdrama-agent-lab/web/**/*.css,shortdrama-agent-lab/web/**/*.mjs,shortdrama-agent-lab/web/**/*.html"
---

# OHAO frontend instructions

- Keep navigation, routes, unsaved-change guards, persisted run recovery, and safe-link handling intact.
- Use existing shared components, tokens, spacing, dark surfaces, and lime accent before introducing new visual primitives.
- Product copy must distinguish implemented behavior from planned behavior. “Technical review” must not imply semantic, dramatic, identity, or aesthetic approval.
- Never place secrets or private endpoints in browser storage, source files, `VITE_` variables, rendered HTML, logs, or error messages.
- Do not automatically load or play untrusted remote media. Use validated local media routes or explicit user-opened HTTPS links.
- Preserve keyboard access, visible focus, semantic controls, explicit labels, reduced-motion behavior, and mobile layouts without horizontal overflow.
- Add or update focused tests in `shortdrama-agent-lab/web/tests/` for navigation, parsing, recovery, consent, and state-transition behavior.
- Run `npm --prefix shortdrama-agent-lab/web test` and `npm --prefix shortdrama-agent-lab/web run build` before finishing.
