# 01 - Config Schema + Heuristic Detection

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Extend the config schema with optional per-project validation commands and add a heuristic fallback that detects validation tools from project marker files (Cargo.toml, go.mod, pyproject.toml).

## Required Skills

Load these before writing any code:
- `/test-behavior-not-implementation`
- `/clean-code`
- `/coding-standards`

## Required Reading

- `CLAUDE.md`
- `src/core/schemas/config.ts` — current config schema
- `src/core/config/load/load.ts` — createDefaultConfig()
- `src/core/validation/test-discovery.ts` — current test finder

## Write Ownership

```
src/core/schemas/config.ts                          (modify)
src/core/config/load/load.ts                        (modify)
src/engine/orchestrator/validation-heuristic.ts      (create)
src/engine/orchestrator/validation-heuristic.test.ts (create)
src/core/validation/test-discovery.ts               (modify)
src/core/validation/test-discovery.test.ts          (create or modify)
```

## Required Behavior

### Part A: Extend validation config schema

In `src/core/schemas/config.ts`, add three optional fields to the `validation` object:

```typescript
validation: z.object({
  typecheck: z.boolean(),
  lint: z.boolean(),
  test: z.boolean(),
  testCommand: z.string().min(1).optional(),
  typecheckCommand: z.string().min(1).optional(),
  lintCommand: z.string().min(1).optional(),
  testPattern: z.string().min(1).optional(),
}),
```

Do NOT add defaults for the new fields in `createDefaultConfig()`. They are optional — absence means "try lower layers."

### Part B: Heuristic detection

Create `src/engine/orchestrator/validation-heuristic.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';

export function detectValidationHeuristic(projectDir: string): DiscoveredValidation | null {
  if (existsSync(join(projectDir, 'Cargo.toml'))) {
    return {
      typecheckCommand: 'cargo check',
      lintCommand: 'cargo clippy --no-deps',
      testCommand: 'cargo test',
      testPattern: '*_test.rs',
      language: 'rust',
    };
  }

  if (existsSync(join(projectDir, 'go.mod'))) {
    return {
      typecheckCommand: 'go vet ./...',
      testCommand: 'go test ./...',
      testPattern: '*_test.go',
      language: 'go',
    };
  }

  if (existsSync(join(projectDir, 'pyproject.toml'))) {
    return {
      testCommand: 'pytest',
      testPattern: 'test_*.py',
      language: 'python',
    };
  }

  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.typescript) return null; // null = use existing TS defaults
      return { testCommand: 'npm test', language: 'javascript' };
    } catch {
      return null;
    }
  }

  return null;
}
```

**Important:** Return `null` for TS projects so the existing default pipeline applies unchanged.

### Part C: Generalize test-discovery.ts

Modify `src/core/validation/test-discovery.ts` to accept an optional `testPattern`:

```typescript
export function findAffectedTestFile(
  taskFile: string,
  projectDir: string,
  testPattern?: string,
): string | null {
  const dir = dirname(taskFile);
  const name = basename(taskFile).replace(/\.\w+$/, '');
  const candidates = testPattern
    ? buildCandidatesFromPattern(name, dir, projectDir, testPattern)
    : buildDefaultTsCandidates(name, dir, projectDir);

  return candidates.find(existsSync) ?? null;
}
```

Where `buildDefaultTsCandidates` is the existing `.test.ts`/`.test.tsx` logic extracted, and `buildCandidatesFromPattern` builds candidates from the pattern string (e.g., `*_test.go` → `${dir}/${name}_test.go`).

## TDD Steps

- [ ] **Write test: heuristic detects Cargo.toml**

```typescript
// src/engine/orchestrator/validation-heuristic.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectValidationHeuristic } from './validation-heuristic.js';

describe('detectValidationHeuristic', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'val-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true }); });

  it('detects Rust project from Cargo.toml', () => {
    writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('rust');
    expect(result?.typecheckCommand).toBe('cargo check');
    expect(result?.testCommand).toBe('cargo test');
  });

  it('detects Go project from go.mod', () => {
    writeFileSync(join(tmpDir, 'go.mod'), 'module example.com/test');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('go');
    expect(result?.typecheckCommand).toBe('go vet ./...');
  });

  it('detects Python project from pyproject.toml', () => {
    writeFileSync(join(tmpDir, 'pyproject.toml'), '[tool.pytest]');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('python');
    expect(result?.typecheckCommand).toBeUndefined(); // too much variance
  });

  it('returns null for TS project (use existing defaults)', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when no marker files exist', () => {
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toBeNull();
  });

  it('prefers Cargo.toml over package.json when both exist', () => {
    writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]');
    writeFileSync(join(tmpDir, 'package.json'), '{}');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('rust');
  });
});
```

- [ ] **Run test to verify it fails** — `npx vitest run src/engine/orchestrator/validation-heuristic.test.ts`
- [ ] **Implement validation-heuristic.ts** — code shown above in Required Behavior Part B
- [ ] **Run test to verify it passes**

- [ ] **Write test: test discovery with custom pattern**

```typescript
// src/core/validation/test-discovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findAffectedTestFile } from './test-discovery.js';

describe('findAffectedTestFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test-disc-'));
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true }); });

  it('finds Go test file with custom pattern', () => {
    writeFileSync(join(tmpDir, 'src', 'handler_test.go'), '');
    const result = findAffectedTestFile('src/handler.go', tmpDir, '*_test.go');
    expect(result).toContain('handler_test.go');
  });

  it('finds TS test file with default pattern', () => {
    writeFileSync(join(tmpDir, 'src', 'handler.test.ts'), '');
    const result = findAffectedTestFile('src/handler.ts', tmpDir);
    expect(result).toContain('handler.test.ts');
  });

  it('returns null when no test file exists', () => {
    const result = findAffectedTestFile('src/handler.go', tmpDir, '*_test.go');
    expect(result).toBeNull();
  });
});
```

- [ ] **Run test to verify it fails**
- [ ] **Implement test-discovery.ts changes** — code shown in Required Behavior Part C
- [ ] **Run test to verify it passes**
- [ ] **Run full suite:** `npm run test-ci`

## Verification

- [ ] Config schema accepts optional `typecheckCommand`, `lintCommand`, `testPattern`
- [ ] Existing config without new fields still validates
- [ ] Heuristic detects Rust, Go, Python from marker files
- [ ] Heuristic returns null for TS projects (preserving existing defaults)
- [ ] Test discovery works with custom patterns AND default TS patterns
- [ ] `npm run test-ci` passes
