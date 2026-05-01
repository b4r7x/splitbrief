# 02 - @file Syntax

> Fresh-context worker brief.
> Implement only this brief after `01-cli-shorthand.md` is complete.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add `@file` syntax so users can enrich planner context directly from the CLI invocation. Text file contents are inlined into the feature prompt; image files are routed through the existing attachment pipeline.

Example: `diptych "refactor auth" @context.md @screenshot.png`

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Do not add trivial hook tests.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/cli/commands/start.ts`
- `src/cli/commands/start.test.ts`
- `src/core/schemas/attachment.ts` (SUPPORTED_IMAGE_EXTS, MAX_ATTACHMENT_BYTES)
- `src/core/attachments/resolve.ts` (resolveAttachment)
- `src/stores/workflow/attachments.ts` (attachmentsStore)
- `src/engine/planners/types.ts` (PlannerCallbacks.attachments)

## Write Ownership

Primary files:

```text
src/cli/parse-at-files.ts           (new — pure parser)
src/cli/parse-at-files.test.ts      (new — parser tests)
src/cli/commands/start.ts           (integration — wire parser into action)
src/cli/commands/start.test.ts      (integration tests for @file end-to-end)
```

Do not edit `src/core/schemas/attachment.ts`. Do not edit `src/core/attachments/resolve.ts`. Do not edit planner files.

## Steps

### Step 1: Create the pure @file parser

Create `src/cli/parse-at-files.ts`:

```typescript
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { SUPPORTED_IMAGE_EXTS, MAX_ATTACHMENT_BYTES } from '../core/schemas/attachment.js';
import { resolveAttachment } from '../core/attachments/resolve.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';

export interface AtFileResult {
  feature: string;
  textContext: string;
  imageCount: number;
  errors: AtFileError[];
}

export interface AtFileError {
  path: string;
  reason: 'not-found' | 'too-large' | 'unreadable' | 'outside-safe-roots';
}

function isImageExt(filePath: string): boolean {
  const ext = extname(filePath).slice(1).toLowerCase();
  return (SUPPORTED_IMAGE_EXTS as readonly string[]).includes(ext);
}

export function parseAtFiles(
  feature: string,
  args: string[],
  projectDir: string,
): AtFileResult {
  const atPaths: string[] = [];
  const extraWords: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('@') && arg.length > 1) {
      atPaths.push(arg.slice(1));
    } else {
      extraWords.push(arg);
    }
  }

  const finalFeature = extraWords.length > 0
    ? `${feature} ${extraWords.join(' ')}`
    : feature;

  const textSegments: string[] = [];
  let imageCount = 0;
  const errors: AtFileError[] = [];

  for (const raw of atPaths) {
    const absPath = resolve(projectDir, raw);

    if (isImageExt(absPath)) {
      const result = resolveAttachment({ input: absPath, projectDir });
      if (result.ok) {
        attachmentsStore.add(result.attachment);
        imageCount++;
      } else {
        errors.push({ path: raw, reason: result.reason });
      }
      continue;
    }

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      errors.push({ path: raw, reason: 'not-found' });
      continue;
    }

    if (!stat.isFile()) {
      errors.push({ path: raw, reason: 'not-found' });
      continue;
    }

    if (stat.size > MAX_ATTACHMENT_BYTES) {
      errors.push({ path: raw, reason: 'too-large' });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      errors.push({ path: raw, reason: 'unreadable' });
      continue;
    }

    textSegments.push(`--- @${raw} ---\n${content}`);
  }

  const textContext = textSegments.join('\n\n');

  return { feature: finalFeature, textContext, imageCount, errors };
}
```

### Step 2: Create parser tests

Create `src/cli/parse-at-files.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { parseAtFiles } from './parse-at-files.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('parse-at-files-test');
  attachmentsStore.init();
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('parseAtFiles', () => {
  it('returns feature unchanged when no @file args are present', () => {
    const result = parseAtFiles('add auth', [], tmp);

    expect(result.feature).toBe('add auth');
    expect(result.textContext).toBe('');
    expect(result.imageCount).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('inlines text file contents into textContext', () => {
    writeFileSync(join(tmp, 'context.md'), '# Auth notes\nUse OAuth2.');

    const result = parseAtFiles('refactor auth', ['@context.md'], tmp);

    expect(result.feature).toBe('refactor auth');
    expect(result.textContext).toContain('--- @context.md ---');
    expect(result.textContext).toContain('# Auth notes');
    expect(result.textContext).toContain('Use OAuth2.');
    expect(result.imageCount).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('routes image files through attachment store', () => {
    const imgPath = join(tmp, 'screenshot.png');
    writeFileSync(imgPath, Buffer.alloc(100));

    const result = parseAtFiles('fix layout', ['@screenshot.png'], tmp);

    expect(result.imageCount).toBe(1);
    expect(result.textContext).toBe('');
    expect(attachmentsStore.peek()).toHaveLength(1);
    expect(attachmentsStore.peek()[0]?.mimeType).toBe('image/png');
  });

  it('handles multiple text and image files together', () => {
    writeFileSync(join(tmp, 'notes.md'), 'Design notes.');
    writeFileSync(join(tmp, 'spec.txt'), 'Spec content.');
    writeFileSync(join(tmp, 'mock.png'), Buffer.alloc(50));

    const result = parseAtFiles('build feature', ['@notes.md', '@mock.png', '@spec.txt'], tmp);

    expect(result.feature).toBe('build feature');
    expect(result.textContext).toContain('--- @notes.md ---');
    expect(result.textContext).toContain('--- @spec.txt ---');
    expect(result.imageCount).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('reports error for missing files', () => {
    const result = parseAtFiles('fix bug', ['@missing.md'], tmp);

    expect(result.errors).toEqual([{ path: 'missing.md', reason: 'not-found' }]);
    expect(result.textContext).toBe('');
  });

  it('reports error for files exceeding size limit', () => {
    const bigFile = join(tmp, 'huge.md');
    writeFileSync(bigFile, Buffer.alloc(11 * 1024 * 1024));

    const result = parseAtFiles('summarize', ['@huge.md'], tmp);

    expect(result.errors).toEqual([{ path: 'huge.md', reason: 'too-large' }]);
  });

  it('concatenates non-@-prefixed extra args into feature string', () => {
    writeFileSync(join(tmp, 'ref.md'), 'Reference.');

    const result = parseAtFiles('add', ['auth', 'flow', '@ref.md'], tmp);

    expect(result.feature).toBe('add auth flow');
    expect(result.textContext).toContain('--- @ref.md ---');
  });

  it('treats double-@ as literal (not a file reference)', () => {
    const result = parseAtFiles('mention @@user', [], tmp);

    expect(result.feature).toBe('mention @@user');
    expect(result.errors).toEqual([]);
  });
});
```

### Step 3: Integrate parser into start command

In `src/cli/commands/start.ts`, modify the command registration to accept variadic args and wire the parser:

Change the command signature from:

```typescript
program
  .command('start [feature]', { isDefault: true })
  .description('Full workflow: plan with Claude, implement with local model')
  .option('--detach', 'spawn workflow as background server and exit', false),
```

to:

```typescript
program
  .command('start [feature] [files...]', { isDefault: true })
  .description('Full workflow: plan with Claude, implement with local model')
  .option('--detach', 'spawn workflow as background server and exit', false),
```

Update the action handler signature:

```typescript
).action(async (feature: string | undefined, files: string[], opts: WorkflowOpts) => {
```

Add the import at the top of the file:

```typescript
import { parseAtFiles } from '../parse-at-files.js';
```

Early in the action body (after `applyWorktreeOption` and before any use of `feature`), add:

```typescript
    const projectDir = resolveProjectDir(opts.project);
    let enrichedFeature = feature;
    let textContext = '';

    if (feature && files.length > 0) {
      const parsed = parseAtFiles(feature, files, projectDir);
      enrichedFeature = parsed.feature;
      textContext = parsed.textContext;
      if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
          console.error(`Warning: @${err.path}: ${err.reason}`);
        }
      }
    }
```

Then use `enrichedFeature` wherever `feature` was used for the feature string passed to the workflow, and pass `textContext` as supplemental context. The existing `feature` variable used for session naming can stay as-is (the original short string is better for session IDs).

For the text context injection, prepend it to the feature description that reaches the planner. The cleanest integration point is to compose the feature string:

```typescript
    const plannerFeature = textContext
      ? `${enrichedFeature}\n\n<user-context>\n${textContext}\n</user-context>`
      : enrichedFeature;
```

Use `plannerFeature` where the feature is passed to orchestrator/headless/router workflow state. Keep the original `feature` (or `enrichedFeature` without context) for display and session naming.

### Step 4: Add integration tests to start.test.ts

```typescript
describe('start command — @file syntax', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inlines text @file content into workflow feature', async () => {
    writeConfigMarker(tmp);
    writeFileSync(join(tmp, 'brief.md'), 'Context about the feature.');

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program);
    await program.parseAsync(['node', 'diptych', 'start', 'build it', '@brief.md', '--project', tmp]);

    const state = routerStore.get();
    expect(state.screen).toBe('workflow');
    expect(state.feature).toContain('build it');
    expect(state.feature).toContain('Context about the feature.');
  });

  it('warns on stderr for missing @file without aborting', async () => {
    writeConfigMarker(tmp);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program);
    await program.parseAsync(['node', 'diptych', 'start', 'build it', '@ghost.md', '--project', tmp]);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('@ghost.md'));
    expect(routerStore.get().screen).toBe('workflow');
  });
});
```

## Verification

```bash
npm test -- src/cli/parse-at-files.test.ts
npm test -- src/cli/commands/start.test.ts
npm run typecheck
npm run lint
```

## Acceptance Criteria

- `diptych "refactor auth" @context.md` reads context.md and includes its contents in the planner prompt.
- `diptych "fix layout" @screenshot.png` adds screenshot.png to the attachment store for image delivery.
- Missing @files produce a stderr warning but do not abort the workflow.
- Files exceeding 10 MB produce a warning.
- Parser is a pure function with independent unit tests.
- All existing start command tests continue to pass.
- `npm run typecheck && npm test` passes.
