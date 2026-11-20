import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { taskId } from '../../../core/schemas/task.js';
import { glyph } from '../../../lib/glyphs.js';
import { buildRequiredChecksUnrunnableRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/checks.js';
import { buildCheckoutChangedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/isolation.js';
import { buildReviewFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/review-failed.js';
import { buildRunnerCheckFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/runner-defect.js';
import { buildApplyPartialRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/apply.js';
import { formatTruncatedList } from '../../../core/formatting.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { elidePathMiddle } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { oneLineDisplayText } from '../../../utils/display-text/sanitize.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { PromptBody } from '../components/prompt-body.js';
import { countPromptBodyRows, promptBodyRows } from '../prompt-rows/body.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import {
  apiContextIssue,
  baseIssue,
  recoveryMenuText,
  usageLimitIssue,
} from '#testing/helpers/recovery-prompt.js';
import {
  formatMiddotList,
  formatRecoveryPrompt,
  passHeadlinePrefix,
  recoveryPromptSummaryRows,
} from './prompt-text.js';
import {
  getRecoveryPromptActions,
  parseRecoveryActionAnswer,
  recommendedRecoveryAction,
} from './actions.js';

async function renderPromptBody(prompt: string): Promise<string> {
  const ui = renderFeature(createElement(PromptBody, { prompt, height: 40, width: 120 }));
  await tick(20);
  const text = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return text;
}

it('builds a context cause from its recorded seat, with dim separators', () => {
  const issue = makeRecoveryIssue({
    reason: 'planner-call-failed',
    seat: 'review',
    facts: {
      apiContextCode: 'insufficient-context',
      apiContextSeat: 'review',
      apiContextCause: 'input-budget',
    },
  });
  expect(recoveryPromptSummaryRows(issue, 120)[0]).toMatchObject({
    parts: [
      { text: 'Seat down', tone: 'warning' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Nothing was sent to ', tone: 'text' },
      { text: 'REVIEW', tone: 'reviewer' },
      { text: ' · ', tone: 'textDim' },
      { text: 'larger than the context window', tone: 'text' },
    ],
  });
});

it('paints the REVIEW seat of a review its seat could not see as the byline does', () => {
  const issue = buildReviewFailedRecoveryIssue({
    createdAt: '2026-04-29T12:00:00.000Z',
    blocking: 0,
    unverified: 2,
    reviewSeatNoImages: true,
    acceptAsIs: true,
    scope: 'final',
  });
  expect(recoveryPromptSummaryRows(issue, 120)[0]).toMatchObject({
    parts: [
      { text: 'Needs you' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Final review needs a ', tone: 'text' },
      { text: 'REVIEW', tone: 'reviewer' },
      { text: ' seat that reads images', tone: 'text' },
    ],
  });
});

it('keeps the default summary at seven rows at width 30 and five at width 120', () => {
  const issue = makeRecoveryIssue();
  const rows = recoveryPromptSummaryRows(issue, 30);
  expect(rows.at(-1)?.kind).toBe('facts');
  expect(countPromptBodyRows(rows, 30)).toBe(7);
  expect(countPromptBodyRows(recoveryPromptSummaryRows(issue, 120), 120)).toBe(5);
  expect(
    promptBodyRows(rows, 30)
      .filter((row) => row.kind === 'facts-line')
      .map((row) => row.text),
  ).toEqual([
    '  Brief T001 · Fix login ',
    '  validation',
    '  Files src/auth/session.ts',
    '  npm test failed in ',
    '  src/auth/session.test.ts',
  ]);
});

const LONG_PATHS = [
  'src/features/workflow/conversation-rows/row-format/recovery-detail.ts',
  'src/features/workflow/conversation-rows/row-format/recovery-header.ts',
  'src/features/workflow/conversation-rows/row-format/recovery-legend.ts',
  'src/features/workflow/conversation-rows/row-format/recovery-prompt.ts',
  'src/features/workflow/conversation-rows/row-format/recovery-scroll.ts',
];

it.each([
  [
    76,
    ['src/auth/session.ts', 'src/auth/session.test.ts', 'src/auth/token-store.ts'],
    '  Files src/auth/session.ts · src/auth/session.test.ts · +1 more',
  ],
  [
    30,
    ['src/auth/session.ts', 'src/auth/session.test.ts', 'src/auth/token-store.ts'],
    '  Files …/session.ts · +2 more',
  ],
  [76, LONG_PATHS, '  Files src/…/conversation-rows/row-format/recovery-detail.ts · +4 more'],
  [116, LONG_PATHS, `  Files ${LONG_PATHS[0]} · +4 more`],
])('keeps the Files row on one row at width %s', (width, files, filesRow) => {
  const issue = makeRecoveryIssue({ files });
  const rows = promptBodyRows(recoveryPromptSummaryRows(issue, width), width);
  const facts = rows.flatMap((row) => (row.kind === 'facts-line' ? [row.text] : []));
  expect(facts.filter((text) => text.includes('Files') || text.includes('more'))).toEqual([
    filesRow,
  ]);
  expect(rows).toHaveLength(
    countPromptBodyRows(recoveryPromptSummaryRows(makeRecoveryIssue(), width), width),
  );
});

it('names every file in the question-mode prompt, which has no panel width', () => {
  expect(formatRecoveryPrompt(makeRecoveryIssue({ files: LONG_PATHS }))).toContain(
    `Files ${LONG_PATHS.join(' · ')}\n`,
  );
});

/** The Files row fit as it was first written: it builds and measures the whole row for each count. */
function rowPerCountFit(files: string[], room: number): string {
  for (let shown = files.length; shown >= 1; shown--) {
    const text = formatTruncatedList(files, shown);
    if (getTerminalCellWidth(text) <= room) return text;
  }
  const tail = files.length > 1 ? `${SOFT_SEP}+${files.length - 1} more` : '';
  return `${elidePathMiddle(files[0] ?? '', room - getTerminalCellWidth(tail))}${tail}`;
}

function filesRow(issue: RecoveryIssue, width: number): string | undefined {
  return recoveryPromptSummaryRows(issue, width)
    .flatMap((row) => (row.kind === 'facts' ? row.items : []))
    .find((item) => item.startsWith('Files '));
}

it('fits the Files row the same way as a fit that measures the whole row for each count', () => {
  const parts = ['src', 'lib', 'データ', 'über', '📁 assets', 'a', 'item-0042.json', 'widget.tsx'];
  let seed = 7;
  const next = (bound: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % bound;
  };
  for (let sample = 0; sample < 300; sample++) {
    const files = Array.from({ length: 1 + next(40) }, () =>
      Array.from({ length: 1 + next(5) }, () => parts[next(parts.length)]).join('/'),
    );
    const width = 12 + next(130);
    const room = width - getTerminalCellWidth('  Files ');
    expect(filesRow(makeRecoveryIssue({ files }), width)).toBe(
      `Files ${rowPerCountFit(files, room)}`,
    );
  }
});

it('fits the Files row of an Apply cut off with 2000 files left in well under a second', () => {
  const files = Array.from(
    { length: 2001 },
    (_, index) =>
      `data/set-${String(Math.floor(index / 50)).padStart(2, '0')}/item-${String(index % 50).padStart(3, '0')}.json`,
  );
  const issue = buildApplyPartialRecoveryIssue({
    backupId: 'backup-1',
    backupDir: '/tmp/backup-1',
    createdAt: '2026-10-19T09:30:33.000Z',
    written: [files[0] ?? ''],
    files,
    failedFile: files[1] ?? '',
    cause: 'interrupted',
  });
  const started = performance.now();
  const row = filesRow(issue, 128);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(row).toBe(
    'Files data/set-00/item-001.json · data/set-00/item-002.json · data/set-00/item-003.json · +1997 more',
  );
});

it.each([
  `Question: Read ${'src/feature/'.repeat(40)}greet.ts?`,
  `Question: ${'世界の言語を読む、'.repeat(30)}`,
  'Question: Should the deploy use token: abc_def_ghi for the build or wait for the owner?',
])('keeps the complete masked question at every summary budget', (asked) => {
  const issue = makeRecoveryIssue({ details: [asked] });
  for (const width of [24, 60, 100]) {
    for (const rows of [1, 2, 5]) {
      const facts = recoveryPromptSummaryRows(issue, width, rows).find(
        (row) => row.kind === 'facts',
      );
      expect(facts?.items[0]).toBe(oneLineDisplayText(asked));
    }
  }
});

it('keeps the blank row above an asked row that fits whole', () => {
  const issue = makeRecoveryIssue({
    details: ['Question: Which file holds the locales?'],
    taskId: undefined,
    taskTitle: undefined,
    files: [],
    affectedTaskIds: [],
  });
  for (const askedRows of [1, 3]) {
    const summary = recoveryPromptSummaryRows(issue, 120, askedRows);
    expect(summary[1], `${askedRows}`).toEqual({ kind: 'blank' });
    const facts = summary[2];
    expect(facts?.kind === 'facts' ? facts.items[0] : '', `${askedRows}`).toBe(
      'Question: Which file holds the locales?',
    );
  }
  // The unbounded form and the question-mode prompt keep the blank row too.
  expect(recoveryPromptSummaryRows(issue, 120)[1]).toEqual({ kind: 'blank' });
  expect(promptBodyRows(recoveryPromptSummaryRows(issue, 120, 1), 120)[1]).toEqual({
    kind: 'blank',
  });
  expect(formatRecoveryPrompt(issue).split('\n')[1]).toBe('');
});

it('keeps the blank row above a full question with task, file and later facts', () => {
  const issue = makeRecoveryIssue({
    details: [
      `Question: ${'Which file holds the locales? '.repeat(4)}`.trimEnd(),
      'Last error: blocked',
    ],
  });
  const summary = recoveryPromptSummaryRows(issue, 40, 1);
  expect(summary[1]).toEqual({ kind: 'blank' });
  const factsRow = summary[2];
  expect(factsRow?.kind === 'facts' ? factsRow.items : []).toEqual([
    issue.details[0],
    'Brief T001 · Fix login validation',
    'Files src/auth/session.ts',
    'Last error: blocked',
  ]);
});

it('keeps the blank row when an asked row with task and file facts fits whole', () => {
  const issue = makeRecoveryIssue({
    details: ['Question: Which file holds the locales?', 'Last error: blocked'],
  });
  for (const askedRows of [1, 3]) {
    const summary = recoveryPromptSummaryRows(issue, 120, askedRows);
    expect(summary[1], `${askedRows}`).toEqual({ kind: 'blank' });
    const facts = summary[2];
    expect(facts?.kind === 'facts' ? facts.items[0] : '', `${askedRows}`).toBe(
      'Question: Which file holds the locales?',
    );
  }
  expect(recoveryPromptSummaryRows(issue, 120)[1]).toEqual({ kind: 'blank' });
});

it('still cuts a planner reason to the available rows', () => {
  const reason = `Planner said: ${'More context. '.repeat(20)}`;
  const issue = makeRecoveryIssue({ details: [reason] });
  const facts = recoveryPromptSummaryRows(issue, 40, 1).find((row) => row.kind === 'facts');
  expect(facts?.items[0]).toBe('Planner said: More context. More cont…');
});

it('preserves the canonical retry cause when an old message starts with its seat', () => {
  const issue = makeRecoveryIssue({
    reason: 'retry-exhausted',
    seat: 'build',
    message: 'BUILD exhausted recovery retries',
    facts: {},
  });
  expect(recoveryPromptSummaryRows(issue, 120)[0]).toMatchObject({
    text: 'Needs you · T001 failed',
    parts: [
      { text: 'Needs you', tone: 'warning' },
      { text: ' · ', tone: 'textDim' },
      { text: 'T001 failed', tone: 'text' },
    ],
  });
});

describe('recovery prompt', () => {
  beforeEach(() => {
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  it('names a spent balance in the panel title, not a usage limit', async () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'claude-code' }]),
      message: 'Balance spent on OpenCode CLI. Add credit or change the BUILD tool, then continue.',
      details: ['OpenCode CLI reported: provider.quota: Insufficient Balance'],
      facts: { tool: 'OpenCode CLI', cause: 'balance' },
      resetAt: undefined,
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Seat down · Balance spent on OpenCode CLI');
    expect(visible).not.toContain('Usage limit');
  });

  it('keeps the install advice of a halt with six checks that miss a program', async () => {
    const issue = buildRequiredChecksUnrunnableRecoveryIssue({
      phase: 'final-review',
      checks: ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'].map((checkId) => ({
        checkId,
        output: 'sh: vitest: command not found',
        missingProgram: true as const,
      })),
      createdAt: '2026-10-05T00:00:00.000Z',
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Install what is missing, then run the checks again.');
  });

  it('states a quota halt once, in the clock the header uses', async () => {
    const resetAt = new Date();
    resetAt.setHours(17, 0, 0, 0);
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      message:
        'Ollama hit its usage limit. The limit resets at Jan 1, 2026, 5:00 PM; wait for it, switch the seat to another tool, or end the run.',
      facts: { tool: 'Ollama' },
      resetAt: resetAt.toISOString(),
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Seat down · Usage limit on Ollama · resets 17:00');
    expect(visible).not.toContain('5:00 PM');
    expect(visible.match(/resets 17:00/g)).toHaveLength(1);
  });

  it("drops codex's own reset clause from its quote, keeping the rest of its words", async () => {
    const resetAt = new Date();
    resetAt.setHours(17, 0, 0, 0);
    const quote = (when: string): RecoveryIssue => ({
      ...usageLimitIssue([{ tool: 'claude-code' }]),
      details: [
        `OpenAI Codex CLI reported: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again ${when}.`,
      ],
      facts: { tool: 'OpenAI Codex CLI' },
      resetAt: resetAt.toISOString(),
    });

    for (const when of ['at 5:00 PM', 'at Oct 3rd, 2026 5:00 PM', 'in 7.66s']) {
      const visible = (await renderPromptBody(formatRecoveryPrompt(quote(when)))).replace(
        /\s+/g,
        ' ',
      );

      expect(visible).toContain('Usage limit on OpenAI Codex CLI · resets 17:00');
      expect(visible).toContain('to purchase more credits.');
      expect(visible).not.toMatch(/\bWorker\b/);
      expect(visible).not.toContain('try again');
    }
  });

  it('reads a usage-limit halt as seat down with its actions and no pause', async () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      facts: { tool: 'Ollama' },
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Seat down · Usage limit on Ollama');
    expect(visible).not.toContain('pause');
    expect(
      getRecoveryPromptActions(issue).map((action) => recoveryMenuText(action, issue)),
    ).toEqual(['Try again', 'Change BUILD tool · continues this brief', 'Skip brief', 'End run']);
  });

  it('builds a compact retry-exhausted summary with only available actions', async () => {
    const prompt = formatRecoveryPrompt(baseIssue);
    const visible = await renderPromptBody(prompt);

    expect(visible).toContain('Needs you · T003 failed');
    expect(visible).not.toContain('after 3 attempts');
    expect(visible).toContain('Brief T003 · Patch auth validation');
    expect(visible).toContain('Files src/auth/session.ts · src/auth/session.test.ts');
    expect(visible).toContain(
      'Last check test failed: npm test -- auth failed in src/auth/session.test.ts',
    );
    expect(visible).not.toMatch(/\bWorker\b/);
    expect(visible).not.toContain('continue');
    expect(getRecoveryPromptActions(baseIssue)).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'end-run',
    ]);
    expect(recommendedRecoveryAction(baseIssue)).toBe('retry-same-worker');
  });

  it.each(['default', 'local-fixture'])(
    'states no Worker row for the %s profile, saved detail or not',
    async (profile) => {
      const visible = await renderPromptBody(
        formatRecoveryPrompt({
          ...baseIssue,
          details: [...baseIssue.details, `Worker profile: ${profile}`],
          selectedImplementerProfile: profile,
          facts: { contextLength: 32_768 },
        }),
      );

      expect(visible).not.toMatch(/\bWorker\b/);
    },
  );

  it.each([
    ['plan-questions-exhausted', 'Needs you · Planner still asks questions after 2 rounds'],
    ['plan-checks-failed', 'Needs you · Plan still fails its checks after one repair'],
  ] as const)('names a %s halt by its headline, not a second wording of it', (reason, header) => {
    const prompt = formatRecoveryPrompt({
      ...baseIssue,
      reason,
      taskId: undefined,
      message: 'The plan failed its checks again after one repair.',
    });

    expect(prompt).toContain(header);
    expect(prompt).not.toContain('again after one repair.');
  });

  it('serializes the headline and facts into a flat prompt with no action row', () => {
    const prompt = formatRecoveryPrompt(baseIssue);

    expect(prompt.split('\n')[0]).toBe('Needs you · T003 failed');
    expect(prompt).toContain('Brief T003 · Patch auth validation');
    expect(prompt).not.toMatch(/^\S* ?\[/m);
  });

  it('offers only the actions the issue carries, with its details under the headline', async () => {
    const issue: RecoveryIssue = {
      id: 'rec_overflow',
      reason: 'context-overflow',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'Context overflowed on T004',
      files: [],
      affectedTaskIds: [],
      details: ['Blocked step: before T004'],
      availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Seat down · Context overflowed on T004');
    expect(visible).toContain('Blocked step: before T004');
    expect(visible).not.toContain('continue');
    expect(getRecoveryPromptActions(issue)).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'end-run',
    ]);
    expect(recommendedRecoveryAction(issue)).toBe('retry-same-worker');
    expect(parseRecoveryActionAnswer('c', issue)).toBeNull();
  });

  // In a real run, the panel blamed the checkout and listed T004's own file as a Files row,
  // although only a branch another session created had changed.
  it('heads a checkout-changed halt with the ref that changed and lists no brief file', async () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({
        id: 'T004',
        suggestedFiles: ['src/engine/runners/cli-tools/final-group.ts'],
      }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } }).implementer,
      toolMessage: 'branch fix/implementer-never-runs-gates',
      attempts: 0,
      createdAt: '2026-10-07T05:54:04.413Z',
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain(
      'Needs you · Repository changed under T004 · branch fix/implementer-never-runs-gates',
    );
    expect(visible).not.toContain('Your checkout changed');
    expect(visible).not.toContain('Files ');
    expect(visible).not.toContain('final-group.ts');
    expect(visible.match(/fix\/implementer-never-runs-gates/g)).toHaveLength(1);
  });

  it('uses the shared truncated-list spelling', () => {
    expect(formatMiddotList(['a', 'b', 'c', 'd'], 3)).toBe('a · b · c · +1 more');
  });

  it('uses the ascii pass-headline prefix when the glyph tier is ascii', () => {
    const prev = process.env.TERM;
    process.env.TERM = 'dumb';
    try {
      expect(passHeadlinePrefix()).toBe(`${glyph('check', 'ascii')} `);
    } finally {
      process.env.TERM = prev;
    }
  });

  it('quotes a tool diagnostic without repeating the reset the headline already carries', async () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      facts: { tool: 'Ollama' },
      details: ['Ollama reported: quota exhausted · resets 5pm'],
      resetAt: new Date(Date.parse('2026-01-01T17:00:00.000Z')).toISOString(),
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Ollama reported: quota exhausted');
    expect(visible.match(/resets/g)).toHaveLength(1);
  });

  it('names the plan seat that was never called, and the sections it never got', async () => {
    const issue = apiContextIssue();
    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain(
      'Seat down · Nothing was sent to PLAN · required evidence was missing',
    );
    expect(visible).toContain('Missing: evidence.json, drift-report.json');
    expect(visible).toContain(
      'Pick a plan seat with a larger context in /crew plan, then choose Try again.',
    );
    expect(recoveryMenuText('retry-same-worker', issue)).toBe('Try again');
    expect(recommendedRecoveryAction(issue)).toBe('retry-same-worker');
    expect(getRecoveryPromptActions(issue)).toEqual(['retry-same-worker', 'end-run']);
    // The figures are the details view's; the panel states the cause and nothing numeric.
    expect(visible).not.toMatch(/148,?000|156,?000|32,?768/);
    expect(visible).not.toMatch(/blocking|0 finding/i);
    // The boundary's sentence repeats the list the detail row already carries.
    expect(visible.match(/evidence\.json/g)).toHaveLength(1);
  });

  it('gives the cause and required and available tokens in the context-window halt', async () => {
    const issue = apiContextIssue({
      id: 'rec_api_context_review',
      reason: 'review-failed',
      seat: 'review',
      phase: 'final-review',
      message: 'The review seat was not given the context this call needs.',
      details: ['Pick a review seat with a larger context in /crew review, then choose Try again.'],
      facts: {
        apiContextCode: 'insufficient-context',
        apiContextSeat: 'review',
        apiContextCause: 'input-budget',
        apiContextMissingSectionsJson: '[]',
        reviewFailureKind: 'insufficient-context',
        apiContextRequiredTokens: 412_000,
        apiContextAvailableTokens: 32_768,
      },
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('REVIEW · larger than the context window');
    expect(recoveryMenuText('retry-same-worker', issue)).toBe('Try again');
    expect(visible).toContain('/crew review');
    expect(visible).not.toMatch(/blocking/i);
    expect(visible).toMatch(/needs\s+412,000\s+tokens[\s\S]*at most\s+32,768/);
    expect(visible).not.toMatch(/review fix|repair/i);
  });

  it('keeps the ordinary headline and the retry key on a review call that never landed', async () => {
    const issue = apiContextIssue({
      id: 'rec_review_call_failed',
      reason: 'review-failed',
      seat: 'review',
      phase: 'final-review',
      message: 'The review call did not land: socket hang up',
      details: [],
      facts: { reviewFailureKind: 'call-failed' },
      recommendedAction: 'retry-same-worker',
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    // No context diagnosis, so the halt keeps the ordinary headline — only the retry is seat-level.
    expect(visible).toContain('Needs you · The review call did not land: socket hang up');
    expect(visible).not.toContain('/crew');
    expect(recoveryMenuText('retry-same-worker', issue)).toBe('Try again');
    expect(parseRecoveryActionAnswer('r', issue)).toBe('retry-same-worker');
    expect(parseRecoveryActionAnswer('retry', issue)).toBe('retry-same-worker');
  });

  // At its widest the retry-exhausted builder ends on the two voices and the verdict: the evidence
  // the halt is for.
  it('keeps both voices and the verdict on the widest retry-exhausted halt', async () => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      reason: 'retry-exhausted',
      phase: 'escalating',
      message: 'T003: the planner found the brief wrong',
      details: [
        'Last error: test failed: npm test -- auth failed in src/auth/session.test.ts',
        'Attempts: 4 (3 local, then 1 with planner hints)',
        'Worker profile: local-qwen',
        'Implementer said: the session type has no expiry field, so I stopped.',
        'Planner said: Add expiry to the session type in its own brief first.',
        'Planner verdict: the brief itself is wrong — the brief names a field the type never had',
      ],
      facts: { ...baseIssue.facts, plannerVerdict: 'brief' },
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Implementer said: the session type has no expiry field');
    expect(visible).toContain('Planner said: Add expiry');
    expect(visible).toContain('Planner verdict: the brief itself is wrong');
    expect(visible).not.toContain('VERDICT:');
  });

  it('formats headers reading headline cause', () => {
    const verdictIssue: RecoveryIssue = {
      ...baseIssue,
      reason: 'retry-exhausted',
      taskId: taskId('T003'),
      facts: { plannerVerdict: 'brief' },
    };
    expect(formatRecoveryPrompt(verdictIssue).split('\n')[0]).toBe(
      'Needs you · T003: the planner found the brief wrong',
    );

    const retryIssue: RecoveryIssue = {
      ...baseIssue,
      reason: 'retry-exhausted',
      taskId: taskId('T005'),
      facts: {},
    };
    expect(formatRecoveryPrompt(retryIssue).split('\n')[0]).toBe('Needs you · T005 failed');

    const legacyWords = 'exhausted recovery' + ' retries';
    const legacyIssue: RecoveryIssue = {
      ...retryIssue,
      message: `T005 ${legacyWords}`,
    };
    expect(formatRecoveryPrompt(legacyIssue).split('\n')[0]).toBe('Needs you · T005 failed');
    expect(formatRecoveryPrompt(legacyIssue)).not.toContain(legacyWords);
  });

  it('heads a changed-tool check halt with the cause the Recovery row reads', () => {
    const issue = buildRunnerCheckFailedRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: 'OpenAI Codex CLI is not installed. Install OpenAI Codex CLI, then try again.',
      attempts: 1,
      createdAt: '2026-04-28T12:00:00.000Z',
    });

    expect(formatRecoveryPrompt(issue).split('\n')[0]).toBe(
      'Seat down · OpenAI Codex CLI changed and failed its check',
    );
  });

  it('leaves a substantive review failure on the words it earned', async () => {
    const issue: RecoveryIssue = {
      id: 'rec_review_blocking',
      reason: 'review-failed',
      seat: 'build',
      phase: 'final-review',
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: [],
      message: 'Final review failed with 2 blocking findings',
      details: ['See review.md'],
      facts: { blocking: 2 },
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Needs you · Final review failed with 2 blocking findings');
    expect(visible).not.toContain('Nothing was sent');
    expect(visible).not.toContain('retry');
    expect(recoveryMenuText('revise', issue)).toBe(
      'Review again · sends your note to the reviewer',
    );
  });

  it('offers the Apply halts a re-run of Apply, never a brief or a retry of a worker', async () => {
    const conflict: RecoveryIssue = {
      id: 'rec_apply_conflict',
      reason: 'apply-conflict',
      phase: 'complete',
      status: 'awaiting-user',
      files: ['a.txt', 'gone.txt'],
      affectedTaskIds: [],
      message: 'Apply found 2 conflicting files',
      details: [
        'a.txt · both sides changed the same lines',
        'gone.txt · deleted on one side, changed on the other',
      ],
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: '2026-10-04T09:00:00.000Z',
    };
    const partial: RecoveryIssue = {
      ...conflict,
      id: 'rec_apply_partial',
      reason: 'apply-partial',
      message: 'Apply stopped part way',
      details: ['Wrote 1 of 2 files; b.txt failed: disk full'],
    };

    expect(recoveryMenuText('retry-same-worker', conflict)).toBe(
      'Re-run Apply · after you resolve the files in the workspace',
    );
    expect(recoveryMenuText('retry-same-worker', partial)).toBe(
      'Re-run Apply · writes the files still missing',
    );
    const offered: RecoveryIssue = {
      ...partial,
      availableActions: ['retry-same-worker', 'restore-backup', 'end-run'],
      recommendedAction: 'retry-same-worker',
    };
    expect(recoveryMenuText('restore-backup', offered)).toBe(
      'Restore backup · puts back the files Apply replaced and removes the ones it created',
    );
    expect(getRecoveryPromptActions(offered)).toContain('restore-backup');
    expect(parseRecoveryActionAnswer('u', offered)).toBe('restore-backup');
    expect(parseRecoveryActionAnswer('u', conflict)).toBeNull();
    const reconciled: RecoveryIssue = {
      ...offered,
      details: [
        'Apply was cut off: wrote 3 of 9 files',
        ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((name) => `${name}.txt · not written`),
        'Backup of the replaced files: /tmp/backup',
      ],
    };
    const wide = formatRecoveryPrompt(reconciled);
    expect(wide).toContain('i.txt · not written');
    expect(wide).toContain('Backup of the replaced files: /tmp/backup');
    const visible = await renderPromptBody(formatRecoveryPrompt(conflict));
    expect(visible).toContain('Needs you · Apply found 2 conflicting files');
    expect(visible).toContain('a.txt · both sides changed the same lines');
  });

  it('lists every file of a wide Apply conflict with the place to resolve it', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt'];
    const issue: RecoveryIssue = {
      id: 'rec_apply_wide',
      reason: 'apply-conflict',
      phase: 'complete',
      status: 'awaiting-user',
      files,
      affectedTaskIds: [],
      message: 'Apply found 7 conflicting files',
      details: [
        "Resolve each file in /tmp/ws: keep the run's version, copy your checkout's version over it, or edit it; then choose Re-run Apply.",
        ...files.map((file) => `${file} · both sides changed the same lines`),
      ],
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: '2026-10-04T09:00:00.000Z',
    };

    const prompt = formatRecoveryPrompt(issue);

    for (const file of files)
      expect(prompt).toContain(`${file} · both sides changed the same lines`);
    expect(prompt).toContain('Resolve each file in /tmp/ws');
  });
});
