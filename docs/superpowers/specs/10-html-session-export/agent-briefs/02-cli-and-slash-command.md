# 02 — CLI Command and Slash Command

> Implement only this brief. Do not run git add/commit/stage/stash. Brief 01 must be complete first.

## Goal

Wire the HTML renderer into a CLI command (`diptych export`) and a slash command (`/export`). Both produce the same HTML file.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`

## Required Reading

- `CLAUDE.md`
- `src/engine/export/html-renderer.ts` (from brief 01)
- `src/engine/export/types.ts` (from brief 01)
- `src/core/sessions/io.ts` (readSummaryFile, listSessions)
- `src/cli/commands/stats.ts` (CLI command registration pattern)
- `src/core/slash-commands/catalog.ts` (slash command registration)
- `src/core/slash-commands/types.ts` (CommandDef, CommandContext)
- `src/cli.ts` (commander registration)

## Write Ownership

```
src/engine/export/collect.ts           (create)
src/engine/export/collect.test.ts      (create)
src/cli/commands/export.ts             (create)
src/cli/commands/export.test.ts        (create)
src/core/slash-commands/catalog.ts     (modify — add /export)
src/cli.ts                             (modify — register export command)
```

## Required Behavior

### Part A: Data collector

Create `src/engine/export/collect.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportData } from './types.js';

export function collectExportData(sessionDir: string, sessionId: string): ExportData | null {
  const summaryPath = join(sessionDir, 'summary.json');
  let raw: string;
  try {
    raw = readFileSync(summaryPath, 'utf-8');
  } catch {
    return null;
  }

  const session = JSON.parse(raw);
  const summary = session.summary;
  if (!summary) return null;

  const data: ExportData = {
    sessionId,
    feature: summary.feature ?? session.feature ?? 'unknown',
    completedAt: session.completedAt ? new Date(session.completedAt).toISOString() : new Date().toISOString(),
    summary,
  };

  // Optional: evidence
  const evidenceSummary = summary.evidenceSummary;
  if (evidenceSummary) {
    data.evidence = {
      totalTasks: evidenceSummary.totalTasks,
      tasksWithValidationEvidence: evidenceSummary.tasksWithValidationEvidence,
      escalatedTasks: evidenceSummary.escalatedTasks,
      failedTasks: evidenceSummary.failedTasks,
    };
  }

  // Optional: drift
  const drift = summary.driftSummary;
  if (drift) {
    data.drift = { passed: drift.passed, score: drift.score, errorCount: drift.errorCount, warningCount: drift.warningCount };
  }

  // Optional: brief quality
  const bq = summary.briefQuality;
  if (bq) {
    data.briefQuality = { score: bq.score, passed: bq.passed, errorCount: bq.errorCount, warningCount: bq.warningCount };
  }

  return data;
}
```

### Part B: CLI command

Create `src/cli/commands/export.ts`:

```typescript
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectExportData } from '../../engine/export/collect.js';
import { renderSessionHtml } from '../../engine/export/html-renderer.js';

// Register as: program.command('export [session-id]')
//   .option('-o, --out <path>', 'Output file path')
//   .option('-p, --project <dir>', 'Project directory', '.')
//   .description('Export a session as an HTML report')
//   .action(exportAction);
```

The action should:
1. Resolve project dir.
2. If no session-id: use active session or most recent completed session.
3. Build session dir path: `.diptych/sessions/<id>/`.
4. Call `collectExportData(sessionDir, sessionId)`.
5. If null: print error "No summary.json found for session" and exit 1.
6. Call `renderSessionHtml(data)`.
7. Write to `--out` path or default `<sessionDir>/report.html`.
8. Print: `Report written to <path>`.

### Part C: Slash command

Add `/export` to `src/core/slash-commands/catalog.ts`:

```typescript
{
  kind: 'noarg',
  name: '/export',
  label: 'Export',
  description: 'Export session as HTML report',
  validScreens: ['workflow'],
  handler: async (_arg, ctx) => {
    const result = ctx.exportSession();
    if (result.status === 'ok') {
      return { message: `Report written to ${result.path}` };
    }
    return { message: `Export failed: ${result.error}`, isError: true };
  },
}
```

Add `exportSession` to `CommandContext` type in `types.ts`. Wire it through from the workflow screen context.

## TDD Steps

- [ ] **Write test: collectExportData reads summary.json**

```typescript
// src/engine/export/collect.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectExportData } from './collect.js';

describe('collectExportData', () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), 'export-')); });
  afterEach(() => { rmSync(sessionDir, { recursive: true }); });

  it('reads summary.json and returns ExportData', () => {
    writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify({
      id: 'test-session',
      feature: 'add auth',
      completedAt: Date.now(),
      summary: { feature: 'add auth', totalTasks: 3, completedByLocal: 2, escalatedToPlanner: 1, skipped: 0, failed: 0, totalTime: 60000, tokenUsage: {} },
    }));
    const data = collectExportData(sessionDir, 'test-session');
    expect(data).not.toBeNull();
    expect(data!.feature).toBe('add auth');
    expect(data!.summary.totalTasks).toBe(3);
  });

  it('returns null when summary.json missing', () => {
    const data = collectExportData(sessionDir, 'missing');
    expect(data).toBeNull();
  });

  it('includes evidence when evidenceSummary present', () => {
    writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify({
      id: 'test', feature: 'x', summary: {
        feature: 'x', totalTasks: 2, completedByLocal: 2, escalatedToPlanner: 0, skipped: 0, failed: 0, totalTime: 1000, tokenUsage: {},
        evidenceSummary: { totalTasks: 2, tasksWithValidationEvidence: 2, escalatedTasks: 0, failedTasks: 0 },
      },
    }));
    const data = collectExportData(sessionDir, 'test');
    expect(data!.evidence).toBeDefined();
    expect(data!.evidence!.totalTasks).toBe(2);
  });
});
```

- [ ] **Write test: CLI command (integration)**

```typescript
// src/cli/commands/export.test.ts
// Test that exportAction writes HTML file to disk
// Use temp directory with a valid summary.json
```

- [ ] **Run tests, implement, verify**
- [ ] **Register command in src/cli.ts**
- [ ] **Register /export in catalog.ts**
- [ ] **Run:** `npm run test-ci`

## Verification

- [ ] `diptych export` writes report.html for the most recent session
- [ ] `diptych export <session-id>` works with explicit session
- [ ] `diptych export --out /tmp/report.html` writes to custom path
- [ ] Missing summary.json → clear error message, exit 1
- [ ] `/export` in TUI prints path to generated file
- [ ] Generated HTML opens in browser and looks correct
- [ ] `npm run test-ci` passes
