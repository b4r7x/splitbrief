import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import {
  fitSeatIdentity,
  formatCollapsedSeatLine,
  formatInheritedIdentity,
  formatSeatIdentity,
  formatShortSeatIdentity,
  PLANNER_INHERITANCE,
} from './identity.js';

const planner: RunnerConfig = { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' };
const build: RunnerConfig = {
  kind: 'api',
  provider: 'ollama',
  service: 'ollama',
  offering: 'local',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://127.0.0.1:11434/v1',
};

describe('formatSeatIdentity', () => {
  it('names the tool and the model, separated once', () => {
    const identity = formatSeatIdentity(planner);

    expect(identity).toContain('Claude Code CLI');
    expect(identity).toContain(' · ');
    expect(identity).toContain('Claude Sonnet 4');
    expect(identity).not.toContain('›');
  });

  it('says the automatic word instead of resolving a catalog default', () => {
    expect(formatSeatIdentity({ kind: 'cli', tool: 'claude-code' })).toContain('auto');
    expect(
      formatSeatIdentity({
        kind: 'api',
        provider: 'deepseek',
        service: 'deepseek',
        offering: 'payg',
        model: 'auto',
        apiBase: 'https://api.deepseek.com/v1',
      }),
    ).toContain('auto');
  });

  it('renders a hostile model id as measurable, control-free text', () => {
    const identity = formatSeatIdentity({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: '\u001b[31mvendor/\u001b]0;pwned\u0007model\u001b[0m',
      apiBase: 'http://127.0.0.1:11434/v1',
    });

    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('\u0007');
    expect(identity).not.toContain('pwned');
    expect(getTerminalCellWidth(identity)).toBe(identity.length);
  });
});

describe('formatShortSeatIdentity', () => {
  it('drops the brand and keeps the first and last distinguishing words', () => {
    expect(formatShortSeatIdentity(planner)).toBe('Sonnet 4');
    expect(formatShortSeatIdentity(build)).toBe('Qwen 7B');
    expect(formatShortSeatIdentity({ kind: 'cli', tool: 'claude-code' })).toBe('auto');
  });

  it('still names a model whose only word is the brand', () => {
    expect(formatShortSeatIdentity({ kind: 'cli', tool: 'claude-code', model: 'claude' })).toBe(
      'Claude',
    );
  });
});

describe('formatInheritedIdentity', () => {
  it('marks the seat as the planner and still names what the planner runs', () => {
    const identity = formatInheritedIdentity(planner);

    expect(identity.startsWith(PLANNER_INHERITANCE.mark)).toBe(true);
    expect(identity).toContain(formatSeatIdentity(planner));
  });
});

describe('formatCollapsedSeatLine', () => {
  it('states all three seats on one line, with the short inheritance mark', () => {
    expect(formatCollapsedSeatLine({ planner, build, reviewer: undefined })).toBe(
      'PLAN Sonnet 4 · BUILD Qwen 7B · REVIEW = plan',
    );
  });

  it('names a reviewer that has its own setup', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(formatCollapsedSeatLine({ planner, build, reviewer })).toContain('REVIEW GPT-5 Codex');
  });
});

describe('fitSeatIdentity', () => {
  it('cuts the full identity to the budget instead of shortening it', () => {
    const fitted = fitSeatIdentity({ runner: planner, budget: 10 });

    expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(10);
    expect(fitted.startsWith('Claude Co')).toBe(true);
  });

  it('leaves an identity that already fits alone', () => {
    expect(fitSeatIdentity({ runner: planner, budget: 80 })).toBe(formatSeatIdentity(planner));
  });
});
