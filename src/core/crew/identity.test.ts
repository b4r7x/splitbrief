import { describe, expect, it } from 'vitest';
import { ELLIPSIS, getTerminalCellWidth } from '../../utils/display-text.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { resolveTheme } from '../theme/resolve.js';
import {
  cutSeatIdentity,
  formatCollapsedSeatSpans,
  formatCollapsedSeatSpansFromIdentities,
  formatSeatCandidateIdentity,
  formatSeatChangeIdentities,
  formatSeatIdentity,
  formatShortSeatIdentity,
  isSeatIdentity,
  PLANNER_INHERITANCE,
  type SeatLineSpan,
  seatIdsOf,
  seatLineText,
  wrapSeatIdentity,
} from './identity.js';
import { CREW_SEAT_ROLES } from './seats.js';

const planner: RunnerConfig = { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' };
const build: RunnerConfig = {
  kind: 'api',
  provider: 'ollama',
  service: 'ollama',
  offering: 'local',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://127.0.0.1:11434/v1',
};
const cursorMultiAxis: RunnerConfig = {
  kind: 'cli',
  tool: 'cursor',
  model: 'claude-opus-5-thinking-xhigh-fast',
};
const openCodeMax: RunnerConfig = {
  kind: 'cli',
  tool: 'opencode',
  model: 'openai/gpt-5.6-luna',
  variant: 'max',
};

it.each([
  { model: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', level: 'high' },
  { model: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', level: 'low' },
] as const)('states the Antigravity level its model id $model runs', ({ model, label, level }) => {
  // A stale effort field beside the id does not reach agy, so no surface states it.
  const seat = { kind: 'cli', tool: 'antigravity', model, effort: 'medium' } as const;
  const identity = `Google Antigravity CLI · Gemini 3.8 Flash · ${level}`;
  expect(formatSeatIdentity({ seat, displayName: label })).toBe(identity);
  expect(formatSeatIdentity({ seat: seatIdsOf(seat), displayName: label })).toBe(identity);
  expect(formatShortSeatIdentity({ seat, displayName: label })).toBe('Gemini 3.8 Flash');
  expect(formatSeatCandidateIdentity(seat, label)).toBe(identity);
});

it.each([
  { axes: [], level: 'high' },
  { axes: ['low'], level: 'low' },
] as const)(
  'formats historical Antigravity seats with saved axes $axes as $level',
  ({ axes, level }) => {
    const seat = { tool: 'antigravity', model: 'gemini-3.8-flash-high', axes };
    const displayName = 'Gemini 3.8 Flash (High)';
    const identity = `Google Antigravity CLI · Gemini 3.8 Flash · ${level}`;
    expect(formatSeatIdentity({ seat, displayName })).toBe(identity);
    expect(formatSeatChangeIdentities({ seat, displayName }, { seat, displayName })).toEqual({
      from: identity,
      to: identity,
    });
  },
);

describe('seatLineText', () => {
  it('projects fitted seat spans without changing their copy or separator ownership', () => {
    const spans = formatCollapsedSeatSpansFromIdentities({
      plan: 'GPT-6-Astra · xhigh',
      build: 'Gemini 3.8 Flash (High)',
      review: null,
      budget: 200,
    });
    expect(spans).toEqual([
      { text: 'PLAN GPT-6-Astra · xhigh', seat: 'plan' },
      { text: ' · ' },
      { text: 'BUILD Gemini 3.8 Flash (High)', seat: 'build' },
      { text: ' · ' },
      { text: 'REVIEW = PLAN', seat: 'review' },
    ]);
    expect(seatLineText(spans)).toBe(
      'PLAN GPT-6-Astra · xhigh · BUILD Gemini 3.8 Flash (High) · REVIEW = PLAN',
    );
  });
});

describe('formatSeatChangeIdentities', () => {
  const from: RunnerConfig = {
    kind: 'cli',
    tool: 'opencode',
    model: 'deepseek/deepseek-flash',
  };
  const to: RunnerConfig = {
    kind: 'cli',
    tool: 'opencode',
    model: 'opencode-go/deepseek-v4.1-flash',
    variant: 'high',
  };
  const displayName = 'DeepSeek V4.1 Flash';

  it('names the model on seats and keeps distinct routes in a same-name switch', () => {
    expect(
      formatSeatChangeIdentities({ seat: from, displayName }, { seat: to, displayName }),
    ).toEqual({
      from: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
      to: 'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
    });
    expect(formatSeatIdentity({ seat: from, displayName })).toBe(
      'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
    );
    expect(formatSeatIdentity({ seat: to, displayName })).toBe(
      'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
    );
    expect(formatSeatCandidateIdentity(to, displayName)).toBe(
      'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
    );
    const shortIdentity = formatShortSeatIdentity({ seat: to, displayName });
    expect(shortIdentity).toBe('DeepSeek V4.1 Flash via opencode-go');
    expect(formatShortSeatIdentity({ seat: from, displayName })).toBe(
      'DeepSeek V4.1 Flash via deepseek',
    );
    expect(shortIdentity).not.toContain('high');
  });

  it('distinguishes same-name model ids even when both sides carry equal axes', () => {
    expect(
      formatSeatChangeIdentities(
        { seat: { ...from, variant: 'high' }, displayName },
        { seat: to, displayName },
      ),
    ).toEqual({
      from: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek · high',
      to: 'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
    });
  });

  it('keeps display words when the model words differ', () => {
    expect(
      formatSeatChangeIdentities(
        { seat: from, displayName },
        { seat: openCodeMax, displayName: 'GPT-5.6 Luna' },
      ),
    ).toEqual({
      from: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
      to: 'OpenCode CLI · GPT-5.6 Luna · via openai · max',
    });
  });

  it('keeps display words for an axis-only switch on the same model id', () => {
    expect(
      formatSeatChangeIdentities(
        { seat: from, displayName },
        { seat: { ...from, variant: 'high' }, displayName },
      ),
    ).toEqual({
      from: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
      to: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek · high',
    });
  });

  it.each([
    [undefined, undefined],
    ['Claude Opus 5 High', 'Claude Opus 5 Xhigh'],
  ])(
    'keeps model words for an axis-only Cursor switch with labels %s and %s',
    (fromName, toName) => {
      expect(
        formatSeatChangeIdentities(
          {
            seat: { kind: 'cli', tool: 'cursor', model: 'claude-opus-5-high' },
            displayName: fromName,
          },
          {
            seat: { kind: 'cli', tool: 'cursor', model: 'claude-opus-5-xhigh' },
            displayName: toName,
          },
        ),
      ).toEqual({
        from: 'Cursor Agent CLI · Claude Opus 5 · high',
        to: 'Cursor Agent CLI · Claude Opus 5 · xhigh',
      });
    },
  );

  it('normalizes configured ids before comparing model changes', () => {
    expect(
      formatSeatChangeIdentities(
        { seat: { ...from, model: ` ${from.model} ` }, displayName },
        { seat: { ...from, variant: 'high' }, displayName },
      ),
    ).toEqual({
      from: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
      to: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek · high',
    });
  });

  it('peels comparison axes only for model-id effort channels', () => {
    expect(
      formatSeatChangeIdentities(
        {
          seat: { tool: 'cursor', model: 'claude-opus-5-high', axes: [], kind: 'api' },
          displayName: 'Claude Opus 5',
        },
        {
          seat: { tool: 'cursor', model: 'claude-opus-5-xhigh', axes: [], kind: 'api' },
          displayName: 'Claude Opus 5',
        },
      ),
    ).toEqual({
      from: 'cursor · claude-opus-5-high',
      to: 'cursor · claude-opus-5-xhigh',
    });
  });

  it('compares sanitized model words independently of axes', () => {
    expect(
      formatSeatChangeIdentities(
        { seat: from, displayName: '\u001b[31mDeepSeek V4.1 Flash\u001b[0m' },
        { seat: to, displayName },
      ),
    ).toEqual({
      from: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
      to: 'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
    });
  });

  it('accepts two recovery candidates with their model-id axes', () => {
    expect(
      formatSeatChangeIdentities(
        { tool: 'cursor', model: 'claude-opus-5-high' },
        { tool: 'cursor', model: 'claude-opus-5-xhigh' },
      ),
    ).toEqual({
      from: 'Cursor Agent CLI · Claude Opus 5 · high',
      to: 'Cursor Agent CLI · Claude Opus 5 · xhigh',
    });
  });

  it('keeps tool-only identities for recovery candidates without a model', () => {
    expect(formatSeatChangeIdentities({ tool: 'codex' }, { tool: 'cursor' })).toEqual({
      from: 'OpenAI Codex CLI',
      to: 'Cursor Agent CLI',
    });
  });
});

describe('formatSeatCandidateIdentity', () => {
  it.each([undefined, 'Claude Opus 5 Xhigh'])(
    'shares the configured Cursor model words and axes with catalog label %s',
    (displayName) => {
      const candidate = { tool: 'cursor', model: 'claude-opus-5-xhigh' };
      expect(formatSeatCandidateIdentity(candidate, displayName)).toBe(
        'Cursor Agent CLI · Claude Opus 5 · xhigh',
      );
      expect(formatSeatCandidateIdentity(candidate, displayName)).toBe(
        formatSeatIdentity({
          seat: { kind: 'cli', tool: 'cursor', model: candidate.model },
          displayName,
        }),
      );
    },
  );

  it('shares the configured Cursor axis order and channel', () => {
    expect(
      formatSeatCandidateIdentity(
        { ...cursorMultiAxis, effort: 'low', variant: 'max' },
        'Claude Opus 5 Xhigh Thinking Fast',
      ),
    ).toBe('Cursor Agent CLI · Claude Opus 5 · xhigh · thinking · fast');
  });

  it('reads candidate axes through the tool effort channel', () => {
    expect(formatSeatCandidateIdentity({ ...openCodeMax, effort: 'low' }, 'GPT-5.6 Luna')).toBe(
      'OpenCode CLI · GPT-5.6 Luna · via openai · max',
    );
  });

  it('keeps candidates without a model tool-only', () => {
    expect(formatSeatCandidateIdentity({ tool: 'cursor' })).toBe('Cursor Agent CLI');
  });
});

describe('formatSeatIdentity', () => {
  it('resolves a routed model name after removing terminal controls', () => {
    const seat = {
      kind: 'cli',
      tool: 'opencode',
      model: 'opencode-go/\u001b[31mdeepseek-v4.1-flash\u001b[0m',
    } as const;
    expect(formatSeatIdentity({ seat })).toBe(
      'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go',
    );
    expect(formatShortSeatIdentity({ seat })).toBe('DeepSeek V4.1 Flash via opencode-go');
    expect(formatSeatCandidateIdentity(seat)).toBe(
      'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go',
    );
  });

  it.each([undefined, 'DeepSeek V4.1 Flash'])(
    'names an OpenCode model consistently across identities with label %s',
    (displayName) => {
      const seat = {
        kind: 'cli',
        tool: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'high',
      } as const;
      const identity = 'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high';
      expect(formatSeatIdentity({ seat, displayName })).toBe(identity);
      expect(formatSeatIdentity({ seat: seatIdsOf(seat), displayName })).toBe(identity);
      expect(formatSeatCandidateIdentity(seat, displayName)).toBe(identity);
      expect(formatShortSeatIdentity({ seat, displayName })).toBe(
        'DeepSeek V4.1 Flash via opencode-go',
      );
      expect(
        seatLineText(
          formatCollapsedSeatSpans({
            planner: seat,
            build: { ...seat, model: 'ollama-cloud/deepseek-v4.1-flash' },
            reviewer: seat,
            budget: 200,
          }),
        ),
      ).toBe(
        'PLAN DeepSeek V4.1 Flash via opencode-go · BUILD DeepSeek V4.1 Flash via ollama-cloud · REVIEW DeepSeek V4.1 Flash via opencode-go',
      );
    },
  );

  it('keeps the model name when a narrow row must drop the tool label', () => {
    const identity = formatSeatIdentity({
      seat: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
    });
    expect(cutSeatIdentity(identity, 34)).toBe('DeepSeek V4.1 Flash · via deepseek');
    expect(cutSeatIdentity(identity, 28)).toBe('DeepSeek V4.1 Flash');
    expect(cutSeatIdentity(`${PLANNER_INHERITANCE.mark} · ${identity}`, 35)).toBe(
      '= PLAN · DeepSeek V4.1 Flash',
    );
  });

  it('keeps the tool, model name and effort when the sidebar needs more identity rows', () => {
    const identity = formatSeatIdentity({
      seat: {
        kind: 'cli',
        tool: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'high',
      },
    });
    for (const budget of [23, 28, 30, 33]) {
      expect(wrapSeatIdentity(identity, budget)).toEqual([
        'OpenCode CLI',
        'DeepSeek V4.1 Flash',
        'via opencode-go · high',
      ]);
      expect(
        wrapSeatIdentity(
          formatSeatIdentity({
            seat: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' },
          }),
          budget,
        ),
      ).toEqual(['OpenCode CLI', 'DeepSeek V4.1 Flash', 'via ollama-cloud']);
    }
    expect(wrapSeatIdentity(identity, 20)).toEqual([
      'OpenCode CLI',
      'DeepSeek V4.1 Flash',
      'via opencode-go',
    ]);
    expect(wrapSeatIdentity(identity, 34)).toEqual([
      'OpenCode CLI · DeepSeek V4.1 Flash',
      'via opencode-go · high',
    ]);
    expect(wrapSeatIdentity(identity, 40)).toEqual([
      'OpenCode CLI · high',
      'DeepSeek V4.1 Flash · via opencode-go',
    ]);
    expect(wrapSeatIdentity(identity, 50)).toEqual([
      'OpenCode CLI',
      'DeepSeek V4.1 Flash · via opencode-go · high',
    ]);
    expect(cutSeatIdentity(identity, 40)).toBe('DeepSeek V4.1 Flash · via opencode-go');
    expect(cutSeatIdentity(identity, 55)).toBe(
      'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go',
    );
  });
  it('shows catalog names for the same OpenCode model on different routes', () => {
    const routes = [
      'deepseek/deepseek-flash',
      'opencode-go/deepseek-v4.1-flash',
      'ollama-cloud/deepseek-v4.1-flash',
    ];
    const identities = routes.map((model) =>
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'opencode', model },
        displayName: 'DeepSeek V4.1 Flash',
      }),
    );
    expect(identities).toEqual(
      routes.map((route) => `OpenCode CLI · DeepSeek V4.1 Flash · via ${route.split('/')[0]}`),
    );
    expect(new Set(identities).size).toBe(routes.length);
    expect(formatSeatIdentity({ seat: { tool: 'opencode', model: routes[1], axes: [] } })).toBe(
      identities[1],
    );
  });

  it('names the route of a Kilo Code model the way it names an OpenCode route', () => {
    const copilot = { kind: 'cli', tool: 'kilo-code', model: 'github-copilot/gpt-5.5' } as const;
    const openai = { ...copilot, model: 'openai/gpt-5.5' } as const;
    expect(formatSeatIdentity({ seat: copilot })).toBe(
      'Kilo Code CLI · GPT-5.5 · via github-copilot',
    );
    expect(formatSeatIdentity({ seat: seatIdsOf(openai) })).toBe(
      'Kilo Code CLI · GPT-5.5 · via openai',
    );
    expect(formatSeatCandidateIdentity(copilot)).toBe(
      'Kilo Code CLI · GPT-5.5 · via github-copilot',
    );
    expect(formatShortSeatIdentity({ seat: copilot })).toBe('GPT-5.5 via github-copilot');
    expect(formatSeatChangeIdentities({ seat: openai }, { seat: copilot })).toEqual({
      from: 'Kilo Code CLI · GPT-5.5 · via openai',
      to: 'Kilo Code CLI · GPT-5.5 · via github-copilot',
    });
    expect(formatSeatIdentity({ seat: { ...copilot, model: 'kilo/kilo-auto/free' } })).toBe(
      'Kilo Code CLI · Kilo Auto Free · via kilo',
    );
  });

  it('spells the route word as the picker route row does, lowercased', () => {
    for (const tool of ['opencode', 'kilo-code'] as const) {
      expect(formatSeatIdentity({ seat: { kind: 'cli', tool, model: 'OpenAI/gpt-5.5' } })).toMatch(
        / · via openai$/,
      );
    }
  });

  it('keeps a Kilo Code model and its route when a narrow row drops the tool label', () => {
    const identity = formatSeatIdentity({
      seat: { kind: 'cli', tool: 'kilo-code', model: 'github-copilot/gpt-5.5' },
    });
    expect(cutSeatIdentity(identity, 30)).toBe('GPT-5.5 · via github-copilot');
    expect(wrapSeatIdentity(identity, 24)).toEqual([
      'Kilo Code CLI · GPT-5.5',
      'via github-copilot',
    ]);
  });

  it('names a tool that does not route by provider without a route word', () => {
    expect(
      formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'openai/gpt-5.5' } }),
    ).not.toContain('via ');
  });

  it('names the tool and the model, separated once', () => {
    const identity = formatSeatIdentity({ seat: planner });

    expect(identity).toContain('Claude Code CLI');
    expect(identity).toContain(' · ');
    expect(identity).toContain('Claude Sonnet 4');
    expect(identity).not.toContain('›');
  });

  it('names a recorded call by the tool its command starts, and a shell command by its kind', () => {
    expect(
      formatSeatIdentity({ seat: { tool: 'claude', model: 'sonnet', axes: [], kind: 'cli' } }),
    ).toMatch(/^Claude Code CLI · /);
    expect(
      formatSeatIdentity({ seat: { tool: 'claude', model: 'gpt-5', axes: [], kind: 'shell' } }),
    ).toBe('Custom Shell · GPT-5');
  });

  it('keeps the configured Shell and Agent seat words when their commands are recorded separately', () => {
    const seats: { runner: RunnerConfig; id: string; word: string }[] = [
      {
        runner: { kind: 'shell', command: 'claude', model: 'gpt-5' },
        id: 'shell',
        word: 'Custom Shell',
      },
      { runner: { kind: 'agent', command: 'claude', model: 'gpt-5' }, id: 'agent', word: 'Agent' },
    ];
    for (const { runner, id, word } of seats) {
      expect(seatIdsOf(runner)).toEqual({ tool: id, model: 'gpt-5', axes: [], kind: runner.kind });
      expect(formatSeatIdentity({ seat: { tool: id, model: 'gpt-5', kind: runner.kind } })).toBe(
        `${word} · GPT-5`,
      );
      expect(formatSeatIdentity({ seat: runner })).toBe(`${word} · GPT-5`);
      expect(formatSeatIdentity({ seat: seatIdsOf(runner) })).toBe(
        formatSeatIdentity({ seat: runner }),
      );
    }
  });

  it('keeps a shell model alias literal in both identity forms', () => {
    expect(
      formatShortSeatIdentity({ seat: { tool: 'claude-code', model: 'opus' }, kind: 'shell' }),
    ).toBe('Opus');
    expect(
      formatSeatIdentity({ seat: { tool: 'claude-code', model: 'opus', axes: [], kind: 'shell' } }),
    ).toBe('Custom Shell · Opus');
  });

  it('says the automatic word instead of resolving a catalog default', () => {
    expect(formatSeatIdentity({ seat: { kind: 'cli', tool: 'claude-code' } })).toContain('auto');
    expect(formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'auto' } })).toBe(
      'Cursor Agent CLI · auto',
    );
    expect(
      formatSeatIdentity({
        seat: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          model: 'auto',
          apiBase: 'https://api.example.test/v1',
        },
      }),
    ).toContain('auto');
  });

  it('renders a hostile model id as measurable, control-free text', () => {
    const identity = formatSeatIdentity({
      seat: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        model: '\u001b[31mvendor/\u001b]0;pwned\u0007model\u001b[0m',
        apiBase: 'http://127.0.0.1:11434/v1',
      },
    });

    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('\u0007');
    expect(identity).not.toContain('pwned');
    expect(getTerminalCellWidth(identity)).toBe(identity.length);
  });

  it('prefers displayName when provided over formatModelName fallback', () => {
    expect(formatSeatIdentity({ seat: planner, displayName: 'Claude Sonnet 5' })).toBe(
      'Claude Code CLI · Claude Sonnet 5',
    );
    expect(formatSeatIdentity({ seat: planner })).toBe('Claude Code CLI · Claude Sonnet 4');
  });

  it('sanitizes displayName before measuring and formatting', () => {
    const identity = formatSeatIdentity({
      seat: planner,
      displayName: '\u001b[31mClaude\u001b]0;pwned\u0007 Sonnet 5\u001b[0m',
    });
    expect(identity).toBe('Claude Code CLI · Claude Sonnet 5');
    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('pwned');
  });

  it('states the effort a flag seat carries and nothing when it carries none', () => {
    const effort = 'high';

    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'claude-code', model: 'claude-opus-5', effort },
      }),
    ).toBe(`Claude Code CLI · Claude Opus 5 · ${effort}`);
    expect(
      formatSeatIdentity({ seat: { kind: 'cli', tool: 'claude-code', model: 'claude-opus-5' } }),
    ).toBe('Claude Code CLI · Claude Opus 5');
  });

  it("states an opencode seat's variant as the config spells it", () => {
    expect(formatSeatIdentity({ seat: openCodeMax })).toBe(
      `OpenCode CLI · GPT-5.6 Luna · via openai · ${openCodeMax.variant}`,
    );
  });

  it('spells each axis of a cursor id exactly once, in effort, thinking, fast order', () => {
    expect(formatSeatIdentity({ seat: cursorMultiAxis })).toBe(
      'Cursor Agent CLI · Claude Opus 5 · xhigh · thinking · fast',
    );
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-opus-5-thinking-high' },
        displayName: 'Claude Opus 5 1M Thinking',
      }),
    ).toBe('Cursor Agent CLI · Claude Opus 5 · high · thinking');
    expect(
      formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'gpt-5.5-none' } }),
    ).toBe('Cursor Agent CLI · GPT-5.5 · none');
  });

  it("keeps the catalog's own words when a cursor id spells no axis to peel", () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-4.5-sonnet' },
        displayName: 'Claude Sonnet 4.5',
      }),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4.5');
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex' },
        displayName: 'Codex 5.3',
      }),
    ).toBe('Cursor Agent CLI · Codex 5.3');
  });

  it('spells a cursor family by its catalog name with the axis words peeled, never by the id', () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex-high' },
        displayName: 'Codex 5.3 High',
      }),
    ).toBe('Cursor Agent CLI · Codex 5.3 · high');
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-4.5-sonnet-thinking' },
        displayName: 'Claude Sonnet 4.5 Thinking',
      }),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4.5 · thinking');
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-4-sonnet-thinking' },
        displayName: 'Claude Sonnet 4 Thinking',
      }),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4 · thinking');
  });

  it('never carries a parenthesised vendor flag or a context word into the identity', () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-fable-5-thinking-high' },
        displayName: 'Claude Fable 5 1M Thinking (NO ZDR)',
      }),
    ).toBe('Cursor Agent CLI · Claude Fable 5 · high · thinking');
  });

  it('peels a No Thinking pair out of the cursor family name', () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-haiku-5-5-low' },
        displayName: 'Claude Haiku 5.5 Low No Thinking',
      }),
    ).toBe('Cursor Agent CLI · Claude Haiku 5.5 · low');
  });

  it('falls back to the peeled id when the catalog name is nothing but axis words', () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'acme-1-high' },
        displayName: 'High',
      }),
    ).toBe('Cursor Agent CLI · Acme 1 · high');
  });

  it('reads one string for the word and the peel, so a padded id still states its axes', () => {
    expect(
      formatSeatIdentity({
        seat: {
          kind: 'cli',
          tool: 'cursor',
          model: 'claude-opus-5-thinking-xhigh-fast ',
        },
      }),
    ).toBe('Cursor Agent CLI · Claude Opus 5 · xhigh · thinking · fast');
  });

  it('names an id made only of axis words instead of splitting it into name and axis', () => {
    expect(formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'extra-high' } })).toBe(
      'Cursor Agent CLI · Extra High',
    );
    expect(
      formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'thinking-fast' } }),
    ).toBe('Cursor Agent CLI · Thinking Fast');
  });

  it('adds nothing on a channel that carries no effort, whatever the config holds', () => {
    // SeatIds now names a kind too, so the effort literal no longer narrows against the union.
    expect(formatSeatIdentity({ seat: { ...build, effort: 'high' as const } })).toBe(
      'Ollama · Qwen2.5 Coder 7B',
    );
  });

  it('renders a hostile variant as measurable, control-free text', () => {
    const identity = formatSeatIdentity({
      seat: {
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.6-luna',
        variant: '\u001b[31mhigh\u001b]0;pwned\u0007',
      },
    });

    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('\u0007');
    expect(identity).not.toContain('pwned');
    expect(getTerminalCellWidth(identity)).toBe(identity.length);
  });

  it('names a claude-code alias by its resolved name, and by its known row label when none resolved', () => {
    const seat: RunnerConfig = { kind: 'cli', tool: 'claude-code', model: 'fable' };

    expect(formatSeatIdentity({ seat: seat, displayName: 'Fable 5.1' })).toBe(
      'Claude Code CLI · Fable 5.1',
    );
    expect(formatSeatIdentity({ seat: seat })).toBe('Claude Code CLI · Fable 5.1');
  });
});

describe('formatShortSeatIdentity', () => {
  it('drops the brand and keeps every remaining word', () => {
    expect(formatShortSeatIdentity({ seat: planner })).toBe('Sonnet 4');
    expect(formatShortSeatIdentity({ seat: build })).toBe('Qwen2.5 Coder 7B');
    expect(formatShortSeatIdentity({ seat: { kind: 'cli', tool: 'claude-code' } })).toBe(
      'Claude Code CLI',
    );
  });

  it('carries no axis word, in the suffix or inside the model word', () => {
    expect(formatShortSeatIdentity({ seat: cursorMultiAxis })).toBe('Opus 5');
    expect(formatShortSeatIdentity({ seat: openCodeMax })).toBe('GPT-5.6 Luna via openai');
  });

  it('peels the catalog name of a cursor seat the same way the full form does', () => {
    expect(
      formatShortSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex-high' },
        displayName: 'Codex 5.3 High',
      }),
    ).toBe('Codex 5.3');
  });

  it('still names a model whose only word is the brand', () => {
    expect(
      formatShortSeatIdentity({ seat: { kind: 'cli', tool: 'claude-code', model: 'claude' } }),
    ).toBe('Claude');
  });
});

describe('formatShortSeatIdentity: a seat whose model is automatic', () => {
  const AUTOMATIC: ReadonlyArray<{ name: string; seat: RunnerConfig; short: string }> = [
    { name: 'cli with no model', seat: { kind: 'cli', tool: 'codex' }, short: 'OpenAI Codex CLI' },
    {
      name: 'cli with the legacy default model',
      seat: { kind: 'cli', tool: 'claude-code', model: 'default' },
      short: 'Claude Code CLI',
    },
    {
      name: 'cli with a provider route and no model',
      seat: { kind: 'cli', tool: 'opencode' },
      short: 'OpenCode CLI',
    },
    {
      name: 'shell with no model',
      seat: { kind: 'shell', command: './build.sh' },
      short: 'Custom Shell',
    },
    {
      name: 'shell with auto',
      seat: { kind: 'shell', command: './build.sh', model: 'auto' },
      short: 'Custom Shell',
    },
    {
      name: 'agent',
      seat: { kind: 'agent', command: './agent.sh', model: 'auto' },
      short: 'Agent',
    },
  ];

  it.each(AUTOMATIC)('names the tool of a $name seat, as the long form does', ({ seat, short }) => {
    expect(formatShortSeatIdentity({ seat })).toBe(short);
    expect(formatSeatIdentity({ seat }).startsWith(`${short} · `)).toBe(true);
  });

  it.each([
    {
      name: 'cli with a model',
      seat: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
      short: 'GPT-5 Codex',
    },
    { name: 'api', seat: build, short: 'Qwen2.5 Coder 7B' },
    {
      name: 'shell with a named model',
      seat: { kind: 'shell', command: './build.sh', model: 'qwen3' },
      short: 'Qwen3',
    },
  ] satisfies ReadonlyArray<{ name: string; seat: RunnerConfig; short: string }>)(
    'keeps the model word of a $name seat',
    ({ seat, short }) => {
      expect(formatShortSeatIdentity({ seat })).toBe(short);
    },
  );

  it('names a recorded tool with no catalog name by its own word, never an empty one', () => {
    expect(formatShortSeatIdentity({ seat: { tool: 'my-tool' } })).toBe('my-tool');
  });

  it('lays three automatic seats out by tool, and drops a whole tool name that does not fit', () => {
    const seats = {
      planner: { kind: 'cli', tool: 'claude-code' },
      build: { kind: 'shell', command: './build.sh' },
      reviewer: { kind: 'cli', tool: 'codex' },
    } satisfies Record<string, RunnerConfig>;

    expect(seatLineText(formatCollapsedSeatSpans(seats))).toBe(
      'PLAN Claude Code CLI · BUILD Custom Shell · REVIEW OpenAI Codex CLI',
    );
    expect(seatLineText(formatCollapsedSeatSpans({ ...seats, budget: 50 }))).toBe(
      'PLAN Claude Code CLI · BUILD Custom Shell',
    );
  });
});

describe('a seat named by the ids a run recorded', () => {
  it('reads exactly as the configured seat the ids were taken from', () => {
    const opusMax: RunnerConfig = {
      kind: 'cli',
      tool: 'claude-code',
      model: 'opus',
      effort: 'max',
    };
    for (const runner of [planner, build, cursorMultiAxis, openCodeMax, opusMax]) {
      const ids = seatIdsOf(runner);
      expect(formatSeatIdentity({ seat: ids })).toBe(formatSeatIdentity({ seat: runner }));
      expect(formatSeatIdentity({ seat: ids, displayName: 'Label 1' })).toBe(
        formatSeatIdentity({ seat: runner, displayName: 'Label 1' }),
      );
      expect(formatShortSeatIdentity({ seat: ids })).toBe(
        formatShortSeatIdentity({ seat: runner }),
      );
    }
    expect(formatSeatIdentity({ seat: seatIdsOf(opusMax), displayName: 'Opus 5.5' })).toBe(
      'Claude Code CLI · Opus 5.5 · max',
    );
  });

  it('shortens a label the way the rail does: the brand dropped, a cursor axis peeled', () => {
    expect(
      formatShortSeatIdentity({
        seat: { tool: 'ollama', model: 'claude-sonnet-5' },
        displayName: 'Claude Sonnet 5',
      }),
    ).toBe('Sonnet 5');
    expect(
      formatShortSeatIdentity({
        seat: { tool: 'cursor', model: 'gpt-5.3-codex-high' },
        displayName: 'Codex 5.3 High',
      }),
    ).toBe('Codex 5.3');
    expect(formatShortSeatIdentity({ seat: { tool: 'cursor', model: 'gpt-5.3-codex-high' } })).toBe(
      'GPT-5.3 Codex',
    );
    expect(formatShortSeatIdentity({ seat: { tool: 'codex' } })).toBe('OpenAI Codex CLI');
  });
});

describe('formatCollapsedSeatSpans', () => {
  it('states all three seats on one line, with the inheritance mark', () => {
    expect(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer: undefined }))).toBe(
      `PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B · REVIEW ${PLANNER_INHERITANCE.mark}`,
    );
  });

  it('names a reviewer that has its own setup', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer }))).toContain(
      'REVIEW GPT-5 Codex',
    );
  });

  it('uses displayNames when provided', () => {
    expect(
      seatLineText(
        formatCollapsedSeatSpans({
          planner,
          build,
          reviewer: undefined,
          displayNames: { planner: 'Claude Sonnet 5', build: 'Qwen 2.5 7B' },
        }),
      ),
    ).toBe(`PLAN Sonnet 5 · BUILD Qwen 2.5 7B · REVIEW ${PLANNER_INHERITANCE.mark}`);
  });

  it('states every seat when the budget holds them', () => {
    const line = seatLineText(
      formatCollapsedSeatSpans({ planner, build, reviewer: undefined, budget: 80 }),
    );

    expect(line).toBe(
      seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer: undefined })),
    );
  });

  it('binds a seat note to its own seat', () => {
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner,
        build,
        reviewer: undefined,
        notes: { build: 'resets 17:00' },
      }),
    );

    expect(line).toContain('BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(line).toContain('PLAN Sonnet 4');
  });

  it('spends another seat name before the noted seat when the note crowds the line', () => {
    const notes = { build: 'resets 17:00' };
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner,
        build,
        reviewer: undefined,
        notes,
        budget: 60,
      }),
    );

    expect(line).toBe('PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(60);
    expect(line).not.toContain(ELLIPSIS);
  });

  it('keeps the noted seat named and drops the seats the note crowds out', () => {
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner,
        build,
        reviewer: undefined,
        notes: { build: 'resets 17:00' },
        budget: 45,
      }),
    );

    expect(line).toBe('BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(45);
  });

  it('gives up one whole seat rather than cutting a model name in half', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const budget =
      getTerminalCellWidth(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer }))) -
      4;
    const line = seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget }));

    expect(line).toBe('PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B');
    expect(line).not.toContain(ELLIPSIS);
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
  });

  it('names the same seats at every width one identity can pay for', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const paid = 'PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B';
    const lines: string[] = [];

    for (
      let budget =
        getTerminalCellWidth(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer }))) -
        1;
      budget >= getTerminalCellWidth(paid);
      budget -= 1
    ) {
      lines.push(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget })));
    }

    expect([...new Set(lines)]).toEqual([paid]);
  });

  it('spends the one long identity and keeps the seats beside it named', () => {
    const longPlanner: RunnerConfig = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: 'qwen3-coder-plus-instruct-preview',
      apiBase: 'http://127.0.0.1:11434/v1',
    };
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner: longPlanner,
        build: planner,
        reviewer: undefined,
        budget: 54,
      }),
    );

    expect(line).toBe(
      `PLAN Qwen3 Coder Plus Instruct Preview · REVIEW ${PLANNER_INHERITANCE.mark}`,
    );
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(54);
  });

  it('keeps the seats it can name and states nothing about the rest', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget: 34 }))).toBe(
      'PLAN Sonnet 4 · REVIEW GPT-5 Codex',
    );
    expect(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget: 27 }))).toBe(
      'PLAN Sonnet 4',
    );
    expect(
      seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer: undefined, budget: 28 })),
    ).toBe('PLAN Sonnet 4');
  });

  it('states no line wider than the budget it was given', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    for (const budget of [20, 12, 4]) {
      const line = seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget }));

      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
    }
  });
});

describe('formatCollapsedSeatSpansFromIdentities', () => {
  const identities = { plan: 'Sonnet 4', build: 'Qwen2.5 Coder 7B', review: 'GPT-5 Codex' };
  const planSpan: SeatLineSpan = { text: 'PLAN Sonnet 4', seat: 'plan' };
  const buildSpan: SeatLineSpan = { text: 'BUILD Qwen2.5 Coder 7B', seat: 'build' };
  const reviewSpan: SeatLineSpan = { text: 'REVIEW GPT-5 Codex', seat: 'review' };
  const separator: SeatLineSpan = { text: ' · ' };

  it.each([
    {
      name: 'all three named seats',
      input: identities,
      expected: [planSpan, separator, buildSpan, separator, reviewSpan],
    },
    {
      name: 'an inherited reviewer',
      input: { ...identities, review: null },
      expected: [
        planSpan,
        separator,
        buildSpan,
        separator,
        { text: `REVIEW ${PLANNER_INHERITANCE.mark}`, seat: 'review' },
      ],
    },
    {
      name: 'a note on build',
      input: { ...identities, notes: { build: 'resets 17:00' } },
      expected: [
        planSpan,
        separator,
        { text: 'BUILD Qwen2.5 Coder 7B (resets 17:00)', seat: 'build' },
        separator,
        reviewSpan,
      ],
    },
    {
      name: 'an elided reviewer without a dangling separator',
      input: {
        ...identities,
        budget: getTerminalCellWidth('PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B'),
      },
      expected: [planSpan, separator, buildSpan],
    },
    {
      name: 'a budget that names nobody',
      input: { ...identities, budget: 4 },
      expected: [],
    },
  ])('preserves seat tags and string bytes for $name', ({ input, expected }) => {
    const spans = formatCollapsedSeatSpansFromIdentities(input);

    expect(spans).toEqual(expected);
    expect(spans.map((span) => span.text).join('')).toBe(
      seatLineText(formatCollapsedSeatSpansFromIdentities(input)),
    );
  });

  it.each(['dark', 'light'] as const)(
    'routes each seat and separator through its theme token in %s',
    (variant) => {
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const spans = formatCollapsedSeatSpansFromIdentities({ ...identities, review: null });

      expect(
        spans.map((span) =>
          span.seat === undefined ? theme.textDim : theme[CREW_SEAT_ROLES[span.seat]],
        ),
      ).toEqual([theme.planner, theme.textDim, theme.implementer, theme.textDim, theme.reviewer]);
    },
  );
});

describe('formatCollapsedSeatSpans', () => {
  it('shares identity resolution and halted-seat fitting with the string entry point', () => {
    const input = {
      planner,
      build,
      reviewer: undefined,
      displayNames: { plan: 'Claude Sonnet 5', build: 'Qwen 2.5 7B' },
      notes: { build: 'resets 17:00' },
    };

    for (const budget of [80, 45, 34, 19, 4]) {
      const fittedInput = { ...input, budget, haltedSeat: 'build' as const };
      const spans = formatCollapsedSeatSpans(fittedInput);

      expect(spans).toEqual(
        formatCollapsedSeatSpansFromIdentities({
          plan: 'Sonnet 5',
          build: 'Qwen 2.5 7B',
          review: null,
          budget,
          haltedSeat: 'build',
          notes: input.notes,
        }),
      );
      expect(spans.map((span) => span.text).join('')).toBe(
        seatLineText(formatCollapsedSeatSpans(fittedInput)),
      );
    }
  });
});

describe('cutSeatIdentity with a formatted seat', () => {
  it('cuts the full identity to the budget instead of shortening it', () => {
    const fitted = cutSeatIdentity(formatSeatIdentity({ seat: planner }), 10);

    expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(10);
    expect(fitted.startsWith('Claude Co')).toBe(true);
  });

  it('leaves an identity that already fits alone', () => {
    expect(cutSeatIdentity(formatSeatIdentity({ seat: planner }), 80)).toBe(
      formatSeatIdentity({ seat: planner }),
    );
  });

  it('cuts the suffixed identity, keeping the tool name and losing the axis tail', () => {
    const full = formatSeatIdentity({ seat: cursorMultiAxis });
    const fitted = cutSeatIdentity(full, full.length - 8);

    expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(full.length - 8);
    expect(full.startsWith(fitted.replace(/\u2026$/, ''))).toBe(true);
  });

  it('uses the seat displayName', () => {
    expect(
      cutSeatIdentity(formatSeatIdentity({ seat: planner, displayName: 'Claude Sonnet 5' }), 80),
    ).toBe('Claude Code CLI · Claude Sonnet 5');
  });
});

describe('cutSeatIdentity', () => {
  it('takes the trailing space with the cut when the leading segment is the one cut', () => {
    const label = 'Automatic (tool decides)';
    for (let budget = 4; budget < getTerminalCellWidth(label); budget++) {
      const cut = cutSeatIdentity(label, budget);
      expect(cut.endsWith('…')).toBe(true);
      expect(cut).not.toMatch(/[ ·]…$/);
    }
  });

  it('sheds the whole model segment rather than cutting inside its id', () => {
    expect(cutSeatIdentity('Claude Code CLI · Claude Sonnet 4', 32)).toBe('Claude Code CLI');
  });

  it('sheds the mirrored identity from an inherited review row instead of cutting its id', () => {
    const row = `${PLANNER_INHERITANCE.mark} · Claude Code CLI · Claude Sonnet 4`;
    expect(cutSeatIdentity(row, 41)).toBe(`${PLANNER_INHERITANCE.mark} · Claude Code CLI`);
    expect(cutSeatIdentity(row, 20)).toBe(PLANNER_INHERITANCE.mark);
  });

  it('returns an identity that already fits unchanged', () => {
    expect(cutSeatIdentity('Claude Code CLI · Claude Sonnet 4', 100)).toBe(
      'Claude Code CLI · Claude Sonnet 4',
    );
  });

  it('sheds the whole axis segment instead of cutting inside its word', () => {
    const seat: RunnerConfig = {
      kind: 'cli',
      tool: 'claude-code',
      model: 'claude-sonnet-4',
      effort: 'high',
    };
    const identity = formatSeatIdentity({ seat: seat });

    expect(identity).toBe('Claude Code CLI · Claude Sonnet 4 · high');
    for (let budget = 33; budget < getTerminalCellWidth(identity); budget++) {
      const fitted = cutSeatIdentity(identity, budget);

      expect(fitted).toBe('Claude Code CLI · Claude Sonnet 4');
    }
    // Below the model's own budget the model segment goes too: every segment is an atom.
    expect(cutSeatIdentity(identity, 32)).toBe('Claude Code CLI');
  });

  it('never leaves a trailing separator before the ellipsis at any budget', () => {
    const identity = formatSeatIdentity({ seat: planner });
    for (let budget = 4; budget <= identity.length; budget++) {
      expect(cutSeatIdentity(identity, budget)).not.toMatch(/[ ·]…$/);
    }
  });
});

describe('kind-aware seat identity', () => {
  const apiTwin = (provider: string, model?: string): RunnerConfig => ({
    kind: 'api',
    provider,
    service: provider,
    offering: 'payg',
    ...(model !== undefined && { model }),
    apiBase: 'https://my-endpoint.example/v1',
    apiKey: 'sk-inline',
  });

  it('keeps a custom API provider word literal and spells its model pretty when it reuses a CLI tool id', () => {
    expect(formatSeatIdentity({ seat: apiTwin('opencode', 'gpt-5') })).toBe('opencode · GPT-5');
    expect(formatSeatIdentity({ seat: apiTwin('claude-code', 'sonnet') })).toBe(
      'claude-code · Sonnet',
    );
  });

  it('keeps a catalogued API provider under its display name', () => {
    expect(formatSeatIdentity({ seat: build })).toBe('Ollama · Qwen2.5 Coder 7B');
  });

  it('keeps a CLI seat under its catalog display name', () => {
    expect(formatSeatIdentity({ seat: openCodeMax })).toBe(
      `OpenCode CLI · GPT-5.6 Luna · via openai · ${openCodeMax.variant}`,
    );
  });

  it('never reads an API seat model through the CLI tool vocabulary it is named after', () => {
    // `cursor` is a CLI tool id whose model-id channel peels axis words; an API
    // seat that reuses the name spells its model id pretty, never through the cursor peel.
    expect(formatSeatIdentity({ seat: apiTwin('cursor', 'gpt-5.3-codex-high') })).toBe(
      'cursor · GPT-5.3 Codex High',
    );
    expect(formatShortSeatIdentity({ seat: apiTwin('cursor', 'gpt-5.3-codex-high') })).toBe(
      'GPT-5.3 Codex High',
    );
  });

  it('spells a recorded identity with the kind the caller recovered for it', () => {
    const recorded = { tool: 'opencode', model: 'gpt-5' };
    expect(formatSeatIdentity({ seat: recorded })).toBe('OpenCode CLI · GPT-5');
    expect(formatSeatIdentity({ seat: recorded, displayName: undefined, kind: 'api' })).toBe(
      'opencode · GPT-5',
    );
    expect(formatShortSeatIdentity({ seat: recorded, displayName: undefined, kind: 'api' })).toBe(
      'GPT-5',
    );
  });

  it('reads a recorded seat by the kind the record kept for it', () => {
    const recorded = seatIdsOf(apiTwin('opencode', 'gpt-5'));

    expect(recorded.kind).toBe('api');
    expect(formatSeatIdentity({ seat: recorded })).toBe('opencode · GPT-5');
    expect(formatShortSeatIdentity({ seat: recorded })).toBe('GPT-5');
  });

  it('keeps a kind-qualified recorded API provider word literal, with no axis words', () => {
    // The exported union accepts this exact shape: a record that kept its kind but not
    // its axes. It must not be read as a live runner block, which has no tool word.
    const recorded = { tool: 'opencode', model: 'gpt-5', kind: 'api' as const };

    expect(formatSeatIdentity({ seat: recorded })).toBe('opencode · GPT-5');
    expect(formatShortSeatIdentity({ seat: recorded })).toBe('GPT-5');
  });

  it('keeps the tool word literal for a recorded CLI identity whose tool left the catalog', () => {
    // The exported union accepts any tool word: a record may outlive its CLI tool's
    // catalog entry. It must format as a record, not crash the live catalog lookup.
    const recorded = { tool: 'retired-tool', model: 'gpt-5', kind: 'cli' as const };

    expect(formatSeatIdentity({ seat: recorded })).toBe('retired-tool · GPT-5');
    expect(formatShortSeatIdentity({ seat: recorded })).toBe('GPT-5');
  });

  it('keeps the recorded axis words when a recorded CLI seat carries its kind', () => {
    const recorded = seatIdsOf({ kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' });

    expect(formatSeatIdentity({ seat: recorded })).toBe('Claude Code CLI · Opus 5.5 · max');
    expect(formatShortSeatIdentity({ seat: recorded })).toBe('Opus 5.5');
  });

  it('carries the API kind into the collapsed crew line', () => {
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner: apiTwin('cursor', 'gpt-5.3-codex-high'),
        build: apiTwin('my-endpoint', 'gpt-5'),
        reviewer: undefined,
      }),
    );
    expect(line).toContain('GPT-5.3 Codex High');
    expect(line).not.toContain('Cursor Agent CLI');
  });
});

describe('wrapSeatIdentity', () => {
  it('returns an identity that fits as one row', () => {
    expect(wrapSeatIdentity('Ollama · Qwen2.5 Coder 7B', 36)).toEqual([
      'Ollama · Qwen2.5 Coder 7B',
    ]);
  });

  it('puts the tool on the first row and the model with its axes on the second', () => {
    expect(wrapSeatIdentity('OpenAI Codex CLI · GPT-6-Astra · xhigh', 36)).toEqual([
      'OpenAI Codex CLI',
      'GPT-6-Astra · xhigh',
    ]);
    expect(wrapSeatIdentity('Google Antigravity CLI · Gemini 3.8 Flash (High)', 36)).toEqual([
      'Google Antigravity CLI',
      'Gemini 3.8 Flash (High)',
    ]);
  });

  it('cuts each row by the segment rule when a row still overruns', () => {
    const rows = wrapSeatIdentity('OpenAI Codex CLI · GPT-6-Astra · xhigh', 12);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe('GPT-6-Astra');
    for (const row of rows) expect(getTerminalCellWidth(row)).toBeLessThanOrEqual(12);
  });
});

describe('formatCollapsedSeatSpans with a halted seat', () => {
  const input = { planner, build, reviewer: undefined, budget: 34 };

  it('spends another seat before the halted one', () => {
    expect(seatLineText(formatCollapsedSeatSpans(input))).toBe('PLAN Sonnet 4 · REVIEW = PLAN');
    const halted = seatLineText(formatCollapsedSeatSpans({ ...input, haltedSeat: 'build' }));

    expect(halted).toBe('BUILD Qwen2.5 Coder 7B');
    expect(getTerminalCellWidth(halted)).toBeLessThanOrEqual(34);
    expect(halted).not.toContain(ELLIPSIS);
  });

  it('keeps the halted seat when its reset note no longer fits', () => {
    expect(
      seatLineText(
        formatCollapsedSeatSpans({
          ...input,
          haltedSeat: 'build',
          notes: { build: 'resets 17:00' },
        }),
      ),
    ).toBe('BUILD Qwen2.5 Coder 7B');
  });

  it('falls back to the plain rule when the halted name itself cannot fit', () => {
    expect(
      seatLineText(formatCollapsedSeatSpans({ ...input, budget: 19, haltedSeat: 'build' })),
    ).toBe('PLAN Sonnet 4');
  });

  it('falls back to the plain rule when the protected line would name nobody', () => {
    // An inherited review seat is a mark that points at the planner; keeping it alone names no one.
    expect(
      seatLineText(formatCollapsedSeatSpans({ ...input, budget: 20, haltedSeat: 'review' })),
    ).toBe('PLAN Sonnet 4');
  });

  it('protects the halted seat through the identities entry point', () => {
    expect(
      seatLineText(
        formatCollapsedSeatSpansFromIdentities({
          plan: 'Sonnet 4',
          build: 'Qwen2.5 Coder 7B',
          review: null,
          budget: 34,
          haltedSeat: 'build',
        }),
      ),
    ).toBe('BUILD Qwen2.5 Coder 7B');
  });
});

describe('isSeatIdentity', () => {
  const seat = { tool: 'codex', model: 'gpt-5' };

  it('is the seat on the same tool and model, whatever the effort', () => {
    expect(isSeatIdentity(seat, { tool: 'codex', model: 'gpt-5' })).toBe(true);
  });

  it("is the seat on the same tool with no model: that is the tool's own default", () => {
    expect(isSeatIdentity(seat, { tool: 'codex' })).toBe(true);
    expect(isSeatIdentity(seat, { tool: 'codex', model: 'auto' })).toBe(true);
  });

  it('reads auto and an absent model as one model on both sides', () => {
    expect(isSeatIdentity({ tool: 'claude-code', model: 'auto' }, { tool: 'claude-code' })).toBe(
      true,
    );
    expect(isSeatIdentity({ tool: 'claude-code' }, { tool: 'claude-code', model: 'default' })).toBe(
      true,
    );
  });

  it('is a move on another model of the same tool or on another tool', () => {
    expect(isSeatIdentity(seat, { tool: 'codex', model: 'gpt-5-codex' })).toBe(false);
    expect(isSeatIdentity(seat, { tool: 'claude-code', model: 'gpt-5' })).toBe(false);
    expect(isSeatIdentity({ tool: 'claude-code' }, { tool: 'claude-code', model: 'opus' })).toBe(
      false,
    );
  });
});
