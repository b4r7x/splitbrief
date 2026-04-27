# 05 — Handoff Custom Renderers

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Allow users to define project-local render targets by dropping TypeScript (or JavaScript) files
under `.diptych/handoff-renderers/<name>.ts`. When `diptych handoff <name>` is called and `<name>`
matches no built-in target, the engine loads and invokes that file as a custom renderer.

Discovery: `diptych handoff --list` prints all built-in targets plus any custom renderer files
found in `.diptych/handoff-renderers/`.

## Read First

- `CLAUDE.md`
- `docs/HOOKS-CONFIG.md`               (module hook loading pattern; custom renderers mirror this)
- `src/engine/hooks/load-module.ts`     (existing dynamic ESM import helper — do NOT reuse directly)
- `src/engine/handoff/types.ts`         (HandoffInput, HandoffPack, HandoffTarget — from brief 01)
- `src/engine/handoff/render.ts`        (renderHandoff — from brief 01)
- `src/engine/handoff/write.ts`         (writeHandoffPack — from brief 02)
- `src/cli/commands/handoff.ts`         (Commander action — from brief 02)
- `src/core/paths.ts`                   (DIPTYCH_DIR, diptychDir)

## Files To Touch

- `src/engine/handoff/load-renderer.ts` **new** — custom renderer loader
- `src/engine/handoff/load-renderer.test.ts` **new**
- `src/engine/handoff/render.ts` — extend `renderHandoff` to fall through to custom renderer
- `src/cli/commands/handoff.ts` — add `--list` flag

Do not touch `src/engine/hooks/load-module.ts` (hook loader is hook-specific; do not reuse or modify it).
Do not create `src/engine/handoff/index.ts` (zero barrels).

## Custom Renderer Contract

A custom renderer file must have a default export matching:

```ts
// .diptych/handoff-renderers/linear-ticket.ts (ESM)
import type { HandoffInput, HandoffPack } from '<diptych-package>/engine/handoff/types';

export default async function render(input: HandoffInput): Promise<HandoffPack> {
  // ... build HandoffPack.files ...
  return { files: [...] };
}
```

The function signature is `(input: HandoffInput) => Promise<HandoffPack>`. Synchronous returns
are also accepted (the loader calls `Promise.resolve(fn(input))`).

Custom renderers may call built-in renderers by directly importing from the built-in renderer
files — no special API wrapper is provided in v1.

## Loader (`src/engine/handoff/load-renderer.ts`)

Follow the exact same pattern as `src/engine/hooks/load-module.ts` but typed for renderers.
Do NOT import from `load-module.ts` — write a parallel implementation.

```ts
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HandoffInput, HandoffPack } from './types.js';

export type RendererFunction = (input: HandoffInput) => Promise<HandoffPack> | HandoffPack;

export type LoadRendererResult =
  | { ok: true; fn: RendererFunction }
  | { ok: false; reason: string };

export async function loadRenderer(
  rendererPath: string,
  projectDir: string,
): Promise<LoadRendererResult>;
```

`loadRenderer` must:
1. Resolve `rendererPath` to an absolute path (if relative, resolve against `projectDir`).
2. Convert to a file URL via `pathToFileURL`.
3. Call `await import(url)`. Return `{ ok: false, reason: '...' }` on any thrown error.
4. Validate `mod.default` is a function. Return `{ ok: false, reason: '...' }` if not.
5. Return `{ ok: true, fn: mod.default }`.

ESM `import()` is cached by URL — each module is loaded once per process.

## Discovery Helper

Add a function in `src/engine/handoff/load-renderer.ts`:

```ts
export function listCustomRenderers(projectDir: string): string[];
```

Lists basenames (without extension) of all `.ts` and `.js` files under
`<projectDir>/.diptych/handoff-renderers/`. Returns `[]` if the directory does not exist.
Uses `readdirSync` synchronously — this is a CLI startup step, not a hot path.

## Integration with `render.ts`

Extend `renderHandoff` in `src/engine/handoff/render.ts` to accept an optional async overload:

```ts
export async function renderHandoffWithCustom(
  input: HandoffInput | (Omit<HandoffInput, 'target'> & { target: string }),
  projectDir: string,
): Promise<HandoffPack>;
```

When `input.target` is not in `HANDOFF_TARGETS`, call `loadRenderer` from the path
`<projectDir>/.diptych/handoff-renderers/<target>.ts` (try `.ts` first, then `.js`). If neither
exists, throw `Error('unknown target: <target>. No built-in or custom renderer found.')`.

If the custom renderer fails to load, throw with the loader's `reason`.

Keep the original synchronous `renderHandoff(input: HandoffInput): HandoffPack` unchanged for
built-in targets — do not make it async.

## Integration with `write.ts`

Change the call in `writeHandoffPack` (`src/engine/handoff/write.ts`) from:

```ts
const pack = renderHandoff(input);
```

to:

```ts
const pack = await renderHandoffWithCustom(input, options.projectDir);
```

`writeHandoffPack` is already `async`, so no signature change is needed.

## Integration with `handoff.ts` CLI command

### `--list` flag

Add to the Commander definition in `src/cli/commands/handoff.ts`:

```ts
.option('--list', 'List all available render targets and exit')
```

In the action, if `opts.list` is truthy:
1. Print `Built-in targets:` followed by each of `HANDOFF_TARGETS` on its own line.
2. Call `listCustomRenderers(projectDir)` and, if any exist, print `Custom renderers:` followed by each name.
3. Exit 0 without writing any files.

### Custom target validation change

Remove the hard guard that rejects targets not in `HANDOFF_TARGETS`. Let `renderHandoffWithCustom`
do the validation — it throws with a clear message if neither a built-in nor a custom renderer matches.

## Constraints

- No agent spawning, no auto-pickup, no watch mode (ADR-011). Custom renderers produce files;
  diptych never executes them or their output.
- Custom renderers run in the diptych process — they are trusted code that the user authored.
  No sandbox. This matches the existing `kind: module` hook behavior.
- Engine code must not import React/Ink/UI modules.
- No classes. No barrel `index.ts`.

## Tests (`src/engine/handoff/load-renderer.test.ts`)

Use `mkdtemp` for temp directories. Write real `.mjs` fixture files (use `.mjs` so Node runs them
as ESM without `tsconfig` — the loader uses `import()` by file URL, not `tsx`).

Required assertions:
- Valid renderer file returns `{ ok: true, fn }` and `fn` is a function.
- Non-existent path returns `{ ok: false, reason: '...' }` with "not found" / ENOENT in the reason.
- File whose default export is not a function returns `{ ok: false, reason: '...' }`.
- `listCustomRenderers` returns basenames for `.ts` and `.js` files in the renderers folder.
- `listCustomRenderers` returns `[]` when the folder does not exist.
- `renderHandoffWithCustom` with a known built-in target delegates to the sync renderer and does
  not attempt to load a file.
- `renderHandoffWithCustom` with an unknown target loads the custom renderer and returns its output.
- `renderHandoffWithCustom` with an unknown target and no matching file throws with "unknown target".

## Acceptance Criteria

- Users can drop `.diptych/handoff-renderers/my-target.ts` and run `diptych handoff my-target`.
- `diptych handoff --list` enumerates built-ins and discovered custom renderers.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/handoff/load-renderer.test.ts
npm run typecheck
npm run lint
npm test
```
