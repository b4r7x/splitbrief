# 01 — `@` File Hook and UI

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Add mid-text `@` file path autocomplete to the TUI input bar. New hook detects `@` trigger, lists files, applies fuzzy matching, renders dropdown. Integrates into `input-bar.tsx` alongside existing slash autocomplete.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`
- `/coding-standards`

## Required Reading

- `CLAUDE.md`
- `src/components/input-bar/use-slash-autocomplete.ts`
- `src/components/input-bar/input-bar.tsx`
- `src/components/input-bar/slash-suggestions.tsx`
- `src/components/pickers/picker-utils.ts`
- `src/core/slash-commands/fuzzy.ts`

## Write Ownership

```
src/lib/file-listing.ts                                    (create)
src/lib/file-listing.test.ts                               (create)
src/components/input-bar/use-at-file-autocomplete.ts       (create)
src/components/input-bar/use-at-file-autocomplete.test.ts  (create)
src/components/input-bar/at-file-suggestions.tsx            (create)
src/components/input-bar/input-bar.tsx                      (modify)
```

## Required Behavior

### Part A: File listing utility

Create `src/lib/file-listing.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ALWAYS_EXCLUDE: RegExp[] = [
  /^\.env/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /^credentials\./,
  /(?:^|\/)\.diptych\/sessions\//,
  /(?:^|\/)\.git\//,
];

function isExcluded(filePath: string): boolean {
  return ALWAYS_EXCLUDE.some(re => re.test(filePath));
}

function listViaGit(projectDir: string): string[] | null {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: projectDir, encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function listViaReaddir(dir: string, base: string, result: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    if (entry.isDirectory()) {
      listViaReaddir(join(dir, entry.name), rel, result);
    } else {
      result.push(rel);
    }
  }
}

export function listProjectFiles(projectDir: string): string[] {
  const files = listViaGit(projectDir) ?? listViaFilesystem(projectDir);
  return files.filter(f => !isExcluded(f));
}

function listViaFilesystem(projectDir: string): string[] {
  const result: string[] = [];
  listViaReaddir(projectDir, '', result);
  return result;
}
```

### Part B: Autocomplete hook

Create `src/components/input-bar/use-at-file-autocomplete.ts`:

```typescript
import { useState } from 'react';
import { useInput } from 'ink';
import { Fzf } from 'fzf';

interface UseAtFileAutocompleteOptions {
  files: string[];
  value: string;
  setValue: (v: string) => void;
  disabled?: boolean;
}

interface UseAtFileAutocompleteResult {
  filtered: string[];
  selectedIndex: number;
  showSuggestions: boolean;
  atQuery: string;
}

function findAtToken(value: string): { start: number; query: string } | null {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] === '@') {
      if (i === 0 || value[i - 1] === ' ') {
        return { start: i, query: value.slice(i + 1) };
      }
      return null;
    }
    if (value[i] === ' ') return null;
  }
  return null;
}
```

The hook should:
1. Call `findAtToken(value)` to detect active `@` token.
2. If no token → return `showSuggestions: false`.
3. If token found → fuzzy filter `files` using `Fzf` with the query part.
4. Handle keyboard: Up/Down to navigate, Tab/Enter to accept (replace `@query` with `@selected-path`), Esc to dismiss.
5. Limit visible results to 8.

### Part C: Suggestions component

Create `src/components/input-bar/at-file-suggestions.tsx`:

Follow the exact pattern of `slash-suggestions.tsx`:
- Box with background color stepping (`#141414`).
- Each row: selected highlight with accent color + `▸`, unselected dim.
- Scroll indicators at top/bottom when list exceeds max visible.
- Footer: `↑↓ select  Tab fill  Esc close`.
- Use `computeScrollOffset` from `picker-utils.ts`.

### Part D: Input bar integration

Modify `src/components/input-bar/input-bar.tsx`:

1. Import `useAtFileAutocomplete` and `AtFileSuggestions`.
2. Pass project file list (from a store or prop) and current value/setValue.
3. Render `<AtFileSuggestions>` when `atFile.showSuggestions` is true AND `slash.showSuggestions` is false. Slash takes priority.
4. File list source: call `listProjectFiles(projectDir)` once at mount, store in `useState`. Refresh on `/refresh` command.

## TDD Steps

- [ ] **Write test: file listing excludes sensitive files**

```typescript
// src/lib/file-listing.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listProjectFiles } from './file-listing.js';

describe('listProjectFiles', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'files-'));
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true }); });

  it('lists regular files', () => {
    writeFileSync(join(tmpDir, 'src', 'app.ts'), '');
    writeFileSync(join(tmpDir, 'src', 'utils.ts'), '');
    const files = listProjectFiles(tmpDir);
    expect(files).toContain('src/app.ts');
    expect(files).toContain('src/utils.ts');
  });

  it('excludes .env files', () => {
    writeFileSync(join(tmpDir, '.env'), 'SECRET=x');
    writeFileSync(join(tmpDir, '.env.local'), 'SECRET=y');
    writeFileSync(join(tmpDir, 'src', 'app.ts'), '');
    const files = listProjectFiles(tmpDir);
    expect(files).not.toContain('.env');
    expect(files).not.toContain('.env.local');
    expect(files).toContain('src/app.ts');
  });

  it('excludes .pem and .key files', () => {
    writeFileSync(join(tmpDir, 'cert.pem'), '');
    writeFileSync(join(tmpDir, 'private.key'), '');
    const files = listProjectFiles(tmpDir);
    expect(files).not.toContain('cert.pem');
    expect(files).not.toContain('private.key');
  });

  it('skips node_modules in filesystem fallback', () => {
    mkdirSync(join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(tmpDir, 'node_modules', 'pkg', 'index.js'), '');
    const files = listProjectFiles(tmpDir);
    expect(files.some(f => f.includes('node_modules'))).toBe(false);
  });
});
```

- [ ] **Write test: findAtToken detection**

```typescript
// src/components/input-bar/use-at-file-autocomplete.test.ts
import { describe, it, expect } from 'vitest';

// Export findAtToken for testing or inline the logic
describe('findAtToken', () => {
  it('detects @ at start of line', () => {
    // @src → { start: 0, query: 'src' }
  });

  it('detects @ after space', () => {
    // add auth @mid → { start: 9, query: 'mid' }
  });

  it('ignores @ mid-word', () => {
    // user@email → null
  });

  it('returns null when no @', () => {
    // hello world → null
  });
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Run:** `npm run test-ci`

## Verification

- [ ] Typing `@` after space shows file suggestions dropdown
- [ ] Typing `@` at line start shows file suggestions dropdown
- [ ] Typing `user@email` does NOT trigger suggestions
- [ ] Arrow keys navigate suggestions
- [ ] Tab/Enter inserts selected file path
- [ ] Esc dismisses suggestions
- [ ] `.env`, `*.pem`, `*.key` files never appear
- [ ] Non-git project falls back to filesystem listing
- [ ] Slash autocomplete (`/`) still works unchanged
- [ ] `npm run test-ci` passes
