import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  ANTIGRAVITY_CLI_CANDIDATE_PATHS,
  CURSOR_CLI_ADMISSION_VERDICT,
  CURSOR_CLI_CANDIDATE_PATHS,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../core/runners/cli-tool-catalog.js';
import { resolveRepoPath as productionResolveRepoPath } from '../../../core/runners/candidate-admission.js';
import {
  CLI_IMPLEMENTER_ADAPTERS,
  CLI_PLANNER_ADAPTERS,
  lookupCliImplementerAdapter,
  lookupCliPlannerAdapter,
} from './registry.js';

const REPO_ROOT = join(import.meta.dirname, '../../../..');

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

describe('CLI role registries', () => {
  it('resolves production repo root to the workspace package.json', () => {
    expect(existsSync(productionResolveRepoPath('package.json'))).toBe(true);
    expect(productionResolveRepoPath('package.json')).toBe(resolveRepoPath('package.json'));
  });

  it('matches planner keys to the core planner tuple', () => {
    expect(Object.keys(CLI_PLANNER_ADAPTERS)).toEqual([...PLANNER_CLI_TOOL_IDS]);
    for (const id of PLANNER_CLI_TOOL_IDS) {
      const adapter = CLI_PLANNER_ADAPTERS[id];
      expect(adapter.role).toBe('planner');
      expect(adapter.descriptor.id).toBe(id);
    }
  });

  it('matches implementer keys to the core implementer tuple', () => {
    expect(Object.keys(CLI_IMPLEMENTER_ADAPTERS)).toEqual([...IMPLEMENTER_CLI_TOOL_IDS]);
    for (const id of IMPLEMENTER_CLI_TOOL_IDS) {
      const adapter = CLI_IMPLEMENTER_ADAPTERS[id];
      expect(adapter.role).toBe('implementer');
      expect(adapter.descriptor.id).toBe(id);
    }
  });

  it('executes OMIT absence branches for Cursor and Antigravity without registry keys', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('OMIT');
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('OMIT');

    for (const relativePath of CURSOR_CLI_CANDIDATE_PATHS) {
      expect(existsSync(resolveRepoPath(relativePath))).toBe(false);
    }
    for (const relativePath of ANTIGRAVITY_CLI_CANDIDATE_PATHS) {
      expect(existsSync(resolveRepoPath(relativePath))).toBe(false);
    }

    expect('cursor' in CLI_PLANNER_ADAPTERS).toBe(false);
    expect('antigravity' in CLI_PLANNER_ADAPTERS).toBe(false);
    expect('cursor' in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
    expect('antigravity' in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
  });
});

describe('CLI registry lookup', () => {
  it('returns admitted planner adapters', () => {
    expect(lookupCliPlannerAdapter('codex')).toBe(CLI_PLANNER_ADAPTERS.codex);
  });

  it('returns admitted implementer adapters', () => {
    expect(lookupCliImplementerAdapter('aider')).toBe(CLI_IMPLEMENTER_ADAPTERS.aider);
  });

  it.each([
    'cursor',
    'antigravity',
    'kiro',
    'unknown-cli',
  ])('rejects unsupported planner lookup for %s before spawn', (toolId) => {
    expect(() => lookupCliPlannerAdapter(toolId)).toThrow(/has no planner configuration/);
  });

  it.each([
    'cursor',
    'antigravity',
    'kiro',
    'unknown-cli',
  ])('rejects unsupported implementer lookup for %s before spawn', (toolId) => {
    expect(() => lookupCliImplementerAdapter(toolId)).toThrow(/has no implementer configuration/);
  });
});
