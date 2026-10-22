import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { warnDroppedRunnerFields } from './factory-gates.js';

describe('warnDroppedRunnerFields', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The limit is the tool's, not the runner kind's: a cli seat on Claude Code takes effort, one on OpenCode does not.
  const cases: ReadonlyArray<readonly [RunnerConfig, boolean, string]> = [
    [
      { kind: 'cli', tool: 'claude-code', temperature: 0.2 },
      true,
      'The planner temperature setting is not used: Claude Code CLI takes no temperature',
    ],
    [
      { kind: 'cli', tool: 'opencode', effort: 'high' },
      false,
      'The planner effort setting is not used: OpenCode CLI has no effort channel',
    ],
    [
      { kind: 'cli', tool: 'claude-code', variant: 'max' },
      true,
      'The planner variant setting is not used: Claude Code CLI has no variant channel',
    ],
    [
      {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
        effort: 'high',
      },
      false,
      'The planner effort setting is not used: Ollama has no effort channel',
    ],
  ];
  it.each(cases)(
    'names the unused setting and the tool that takes none (%#)',
    (runner, supportsEffort, words) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      warnDroppedRunnerFields({ runner, seat: 'planner', supportsEffort });

      expect(stderr.mock.calls).toEqual([[`${words}\n`]]);
    },
  );
});
