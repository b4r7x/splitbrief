import { describe, expect, it } from 'vitest';
import { SCOPE_ENTRY_CASES } from '#testing/helpers/scope-entries.js';
import { requiredWriteModeForTask } from '../../engine/orchestrator/context-routing/decision.js';
import type { Task } from '../schemas/task.js';
import { taskId } from '../schemas/task.js';
import {
  isInDeclaredSet,
  isScopePlaceholder,
  matchesScopeEntry,
  scopeEntryPatterns,
  taskDeclaredPatterns,
  undeclaredFiles,
} from './declared-set.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId('T001'),
    title: 'anchor',
    action: 'modify',
    file: 'src/a.ts',
    dependsOn: [],
    description: '',
    tests: [],
    constraints: [],
    typeDefs: '',
    implementationSteps: [],
    status: 'pending',
    ...overrides,
  };
}

describe('matchesScopeEntry', () => {
  it('prose in-bounds bullet licenses its path', () => {
    for (const entryCase of SCOPE_ENTRY_CASES) {
      for (const file of entryCase.matches) {
        expect(matchesScopeEntry(file, entryCase.entry), `${entryCase.name}: ${file}`).toBe(true);
      }
      for (const file of entryCase.nonMatches) {
        expect(matchesScopeEntry(file, entryCase.entry), `${entryCase.name}: ${file}`).toBe(false);
      }
    }
  });
});

describe('scopeEntryPatterns', () => {
  it.each(['None', 'None.', ' none. ', 'n/a', 'N/A', '-'])(
    'a placeholder entry %j licenses no path',
    (entry) => {
      expect(scopeEntryPatterns(entry)).toEqual([]);
      expect(isScopePlaceholder(entry)).toBe(true);
    },
  );

  it('a placeholder beside real paths leaves only the real paths', () => {
    const subject = task({ scope: { approvedOutOfBounds: ['None.', 'src/shared.ts'] } });
    expect(undeclaredFiles(['None.', 'src/shared.ts', 'src/other.ts'], subject)).toEqual([
      'None.',
      'src/other.ts',
    ]);
    expect(isScopePlaceholder('src/none.ts')).toBe(false);
  });

  it('keeps a whitespace-free bullet as its own pattern and drops pathless prose', () => {
    expect(scopeEntryPatterns('tsconfig.json')).toEqual(['tsconfig.json']);
    expect(scopeEntryPatterns('the auth flow and nothing else')).toEqual([]);
  });

  it('licenses a leading backticked path, root-level files included, and drops prose backticks', () => {
    expect(scopeEntryPatterns('`README.md` — planner-approved: consumer')).toEqual(['README.md']);
    expect(scopeEntryPatterns('Keep the public API stable')).toEqual([]);
    expect(scopeEntryPatterns('Keep `runWorkflow` stable')).toEqual([]);
    expect(scopeEntryPatterns('`applyConsultAnswer` — the consult applier')).toEqual([]);
    expect(scopeEntryPatterns('`src/x.ts` — the union collapse')).toEqual(['src/x.ts']);
  });
});

describe('write-mode routing', () => {
  it('a bullet that opens on a backticked identifier never routes an API implementer to direct writes', () => {
    const subject = task({
      scope: { inBounds: ['`applyConsultAnswer` — the consult applier'] },
    });
    expect(requiredWriteModeForTask(subject)).toBe('extracted-code');
  });
});

describe('taskDeclaredPatterns', () => {
  it('collects files, in bounds and approved out of bounds', () => {
    const patterns = taskDeclaredPatterns(
      task({
        files: ['src/a.ts', 'src/a.test.ts'],
        scope: { inBounds: ['src/api/**'], approvedOutOfBounds: ['tsconfig.json'] },
      }),
    );
    expect(patterns).toEqual(['src/a.ts', 'src/a.test.ts', 'src/api/**', 'tsconfig.json']);
  });

  it('falls back to the anchor when files is absent', () => {
    expect(taskDeclaredPatterns(task())).toEqual(['src/a.ts']);
  });
});

describe('undeclaredFiles', () => {
  it('returns only the changed files no declared pattern licenses', () => {
    const subject = task({
      files: ['src/a.ts', 'src/a.test.ts'],
      scope: { inBounds: ['docs/**'] },
    });
    expect(undeclaredFiles(['src/a.ts', 'docs/x.md', './src/b.ts'], subject)).toEqual([
      './src/b.ts',
    ]);
  });
});

describe('isInDeclaredSet', () => {
  it('matches a file against any of the patterns', () => {
    expect(isInDeclaredSet('src/api/routes.ts', ['src/a.ts', 'src/api/**'])).toBe(true);
    expect(isInDeclaredSet('src/b.ts', ['src/a.ts'])).toBe(false);
    expect(isInDeclaredSet('README.md', ['`README.md` — planner-approved: consumer'])).toBe(true);
  });
});
