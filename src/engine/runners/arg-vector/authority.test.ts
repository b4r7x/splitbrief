import { describe, expect, it } from 'vitest';
import { semanticConfiguredArgViolations } from './authority.js';

describe('semanticConfiguredArgViolations (REQ-018)', () => {
  it('reports authority-bearing long flags in plain and attached value forms', () => {
    expect(semanticConfiguredArgViolations(['--sandbox', 'workspace-write'])).toEqual([
      '--sandbox',
    ]);
    expect(semanticConfiguredArgViolations(['--sandbox=read-only'])).toEqual(['--sandbox']);
    expect(semanticConfiguredArgViolations(['--cwd', '/tmp/work'])).toEqual(['--cwd']);
  });

  it('reports authority-bearing short flags and their attached short forms', () => {
    expect(semanticConfiguredArgViolations(['-y'])).toEqual(['-y']);
    expect(semanticConfiguredArgViolations(['-yyes'])).toEqual(['-y']);
  });

  it('a positional separator does not hide a flag from the scan', () => {
    expect(semanticConfiguredArgViolations(['--', '--session-id', 's1'])).toEqual(['--session-id']);
  });

  it('covers role, permission, approval, config-source, and session aliases', () => {
    expect(semanticConfiguredArgViolations(['--approval-mode', 'acceptEdits'])).toEqual([
      '--approval-mode',
    ]);
    expect(semanticConfiguredArgViolations(['--dangerously-skip-permissions'])).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(semanticConfiguredArgViolations(['--mcp-config', 'x.json'])).toEqual(['--mcp-config']);
    expect(semanticConfiguredArgViolations(['--output-format', 'text'])).toEqual([
      '--output-format',
    ]);
    expect(semanticConfiguredArgViolations(['--resume', 'session-1'])).toEqual(['--resume']);
  });

  it('leaves ordinary configured flags alone', () => {
    expect(
      semanticConfiguredArgViolations(['--model', 'gpt-5', '--verbose', '--max-turns', '5']),
    ).toEqual([]);
  });
});
