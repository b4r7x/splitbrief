# Website Execution Plan

spec: `PLAN.md`
mode: full
started: 2026-07-30

The execution follows P0–P7 in dependency order. Within a phase, agents own disjoint files. No phase advances until fresh validators have checked its acceptance criteria and matching gates.

## Gates

| Prefix | Required gates |
|---|---|
| Root fixture/tooling edits | focused visual tests, `npm run tui-shots`, `npm run test-ci` |
| `website/src/**` and `website/scripts/**` | website tests, typecheck, Biome, build, applicable Playwright/axe checks |
| `website/content/**` | page-count/source-fidelity review, banned-copy scan, link checker, build |
| `website/deploy/**` | built-output static curls; Docker/nginx curls when Docker is available |
| Full changed set | website build/test/e2e/Lighthouse, root `npm run test-ci`, fresh code/design/completeness sweeps |

## Skill map

- TypeScript: TypeScript best practices, clean code, code quality, anti-slop.
- React: React senior guide, React anti-patterns, useEffect/useRef guidance, accessibility compliance.
- CSS/visual: nuke creative, frontend design, Tailwind v4, responsive design, web performance.
- Tests: test behavior rather than implementation, webapp testing.

The source bundle's P0–P7 tasks and acceptance gates are incorporated by reference without reinterpretation.
