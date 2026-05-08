# Agent Brief 00 - Coordinator

## Mission

Coordinate the architecture naming refactor in one implementation pass while keeping behavior unchanged.

## Mandatory Rules

- Do not run `git add`, `git stage`, `git commit`, `git stash`, or `git mv`.
- Do not create barrels or compatibility re-export modules.
- Preserve `.js` suffixes on local TypeScript imports.
- Do not change user-facing behavior.
- Do not rewrite archival docs under `docs/superpowers/specs/**` except this current spec pack.
- Keep phases sequential; do not let writer agents edit overlapping files in parallel.

## Work Order

1. Composer move.
2. Runtime command core move.
3. Palette/help feature extraction.
4. App shell/runners/docs cleanup.
5. Final active-doc and old-path sweep.

## Collision Map

| Area | Why It Is Risky | Mitigation |
|---|---|---|
| `src/core/runtime/commands/types.ts` | Types fan out into app, CLI, engine, features, tests | Move and rename in one focused phase, then typecheck |
| Composer tests | Some fixtures contain old source paths | Update fixtures to new paths and keep behavior assertions |
| Palette | Currently split between workflow feature, engine helper, and UI store | Move all palette-owned pieces in same phase |
| Docs | Active docs and archival specs both mention old paths | Exclude archival specs from old-path verification |
| Stores | Singleton identity matters | Only rename palette MRU store in this pass; do not reshape all stores |

## Final Report Checklist

- [ ] Changed path summary.
- [ ] Behavior-preservation summary.
- [ ] Tests and validation output.
- [ ] Old-path search results.
- [ ] Barrel search result.
- [ ] Confirmation no staging/commit/stash was run.

