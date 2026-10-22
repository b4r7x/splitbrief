import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  runnerAvailabilityCheck,
  type RunnerAvailabilityVerdict,
} from '../../core/readiness/checks/availability.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { approvalPromptStore, openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { ApprovalPrompt } from '../workflow/components/approval-prompt.js';
import { formatCustomRunnerDisclosure } from '../../engine/runners/custom-runner-disclosure.js';
import { escapeTrustLiteral } from '../../core/trust/literal.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { SOFT_SEP } from '../../core/separators.js';
import { overlayRect } from '../../core/navigation/overlay-rect.js';
import { confirmPanelMinRows } from '../workflow/prompt-rows/approval.js';
import { StartPreparationPanel, type StartPreparationPanelProps } from './panel.js';

const ESC = '\x1b';
const DOWN = '\x1b[B';

function report(checks: ReadinessCheck[]): ReadinessReport {
  const blockers = checks.filter((check) => check.severity === 'blocker').length;
  const warnings = checks.filter((check) => check.severity === 'warning').length;
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir: '/project',
    status: blockers > 0 ? 'blocked' : 'ready-with-warnings',
    counts: { ok: 0, info: 0, warning: warnings, blocker: blockers },
    nextAction: {
      kind: blockers > 0 ? 'prepare-runner' : 'continue',
      label: blockers > 0 ? 'Prepare the runner' : 'Continue',
      reason: blockers > 0 ? 'Resolve the blockers.' : 'Tools are ready.',
    },
    sections: [{ id: 'runners', title: 'Runners', checks }],
    metadata: {},
  };
}

function check(id: string, severity: 'blocker' | 'warning'): ReadinessCheck {
  return { id, severity, summary: `${id} summary`, fix: `${id} fix` };
}

/** The real readiness copy for one seat's connection, so the panel is judged on what ships. */
function availability(
  verdict: RunnerAvailabilityVerdict,
  endpoint: string | null = 'http://localhost:11434',
): ReadinessCheck {
  return runnerAvailabilityCheck({
    fact: {
      slot: { role: 'planner' },
      provider: 'ollama',
      ...(endpoint !== null && { endpoint }),
      verdict,
    },
    label: 'Planner Ollama · Qwen3 Coder 30B',
    isDefaultImplementer: false,
  });
}

const TRUST_BOUNDARY: ReadinessCheck = {
  id: 'runners.planner.trust-boundary',
  severity: 'warning',
  summary: 'Planner Claude Code CLI · auto can execute commands on this machine.',
  details: [
    'Plan approval: none.',
    'SPLITBRIEF approval gates review the plan and declared/promoted file writes; they do not sandbox shell commands or network access inside external runners.',
  ],
};

/** The disclosure the visual fixture shows: the real formatter's output for a project command. */
const TRUST_DISCLOSURE = formatCustomRunnerDisclosure({
  executable: '"tools/review-bot"',
  argv: ['"--diff"'],
  contract: 'direct',
  cwd: 'Project directory',
  stage: 'None',
  environment: ['"REVIEW_BOT_TOKEN"'],
  environmentAccess: 'Declared environment references only',
  filesystem: 'Not an OS sandbox; the process can access files available to the current user',
  network: 'Network access is not restricted',
  result: 'Reviewed workspace diff; it writes directly into the project directory',
});
const TRUST_LABEL = 'runner command from the project config';
const TRUST_RECEIPT = 'Exact confirmation stores an owner-only reusable receipt.';

function renderPanel(
  props: Partial<StartPreparationPanelProps> & Pick<StartPreparationPanelProps, 'state'>,
  viewport = { cols: 120, rows: 40 },
) {
  terminalSizeStore.__testReset({ ...viewport, isSmall: viewport.cols < 120 });
  return renderFeature(
    <StartPreparationPanel
      onRetry={vi.fn()}
      onBack={vi.fn()}
      onOpenSettings={vi.fn()}
      {...props}
    />,
    viewport,
  );
}

describe('StartPreparationPanel', () => {
  beforeEach(() => resetAllStores());
  afterEach(() => resetAllStores());

  it('leads a failure with the error it raised, never with a blocker count of zero', async () => {
    const readiness = report([TRUST_BOUNDARY, check('repo.worktree.dirty', 'warning')]);
    expect(readiness.counts.blocker).toBe(0);
    const ui = renderPanel({
      state: {
        kind: 'failed',
        report: readiness,
        error: new Error('Session ownership could not be taken over: 20260804-a91f is held.'),
      },
    });

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Session ownership could not be taken over');
    // The warnings are still reported, and still under the error rather than in place of it.
    expect(frame.indexOf('Session ownership')).toBeLessThan(frame.indexOf('Warnings'));
    expect(frame.indexOf('Warnings')).toBeLessThan(frame.indexOf('can execute commands'));
    // The counter is not the diagnosis: no "0 blockers" anywhere, and an action is offered.
    expect(frame).not.toMatch(/\d+ blockers?/);
    expect(frame).toContain('Retry the check, or open settings to change the crew.');
    expect(frame).toContain('r retry');
    ui.unmount();
  });

  it('leads a blocked check with the blocking fact and that blocker’s own fix', async () => {
    const ui = renderPanel({
      state: {
        kind: 'blocked',
        report: report([availability({ state: 'no-models' }, null), TRUST_BOUNDARY]),
      },
    });

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Planner Ollama · Qwen3 Coder 30B answered but offers no models.');
    expect(frame).toContain('Install a model for ollama');
    expect(frame).not.toMatch(/\d+ blockers?/);
    expect(frame.indexOf('offers no models')).toBeLessThan(frame.indexOf('Warnings'));
    ui.unmount();
  });

  it('gives an unreachable local server its address, its start instruction and retry', async () => {
    const ui = renderPanel({
      state: {
        kind: 'blocked',
        report: report([
          availability({ state: 'unavailable', diagnostic: 'connection refused' }),
          TRUST_BOUNDARY,
        ]),
      },
    });

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('http://localhost:11434');
    expect(frame).toContain('Run `ollama serve`');
    expect(frame).toContain('r retry');
    // An offline server is not an auth problem: nothing here asks for a credential or a sign-in.
    expect(frame.toLowerCase()).not.toContain('sign in');
    expect(frame.toLowerCase()).not.toContain('credential');
    ui.unmount();
  });

  it('gives offline, unauthorized and a missing selected model their own precise action', async () => {
    const verdicts: RunnerAvailabilityVerdict[] = [
      { state: 'unavailable', diagnostic: 'connection refused' },
      { state: 'unauthorized', diagnostic: 'HTTP 401' },
      { state: 'missing-model', selectionId: 'qwen3-coder:30b' },
      { state: 'timeout', diagnostic: 'Request timed out' },
    ];
    const leads: string[] = [];
    for (const verdict of verdicts) {
      const ui = renderPanel({
        state: { kind: 'blocked', report: report([availability(verdict)]) },
      });
      await flushEffects();
      const frame = ui.lastFrame() ?? '';
      leads.push(frame);
      ui.unmount();
      resetAllStores();
    }
    const [offline, unauthorized, missingModel, timeout] = leads;

    expect(offline).toContain('Planner Ollama · Qwen3 Coder 30B is not reachable at');
    expect(offline).toContain('http://localhost:11434.');
    expect(offline).toContain('Run `ollama serve`');

    expect(unauthorized).toContain(
      'Planner Ollama · Qwen3 Coder 30B rejected the configured credential at',
    );
    expect(unauthorized).toContain('http://localhost:11434.');
    expect(unauthorized).toContain('Check the credential for ollama');
    expect(unauthorized).not.toContain('Run `ollama serve`');

    expect(missingModel).toContain('serve "qwen3-coder:30b"');
    expect(missingModel).toContain('Select a model ollama serves');
    expect(missingModel).not.toContain('is not reachable');

    expect(timeout).toContain('did not answer in time');
    expect(timeout).not.toContain('rejected');
  });

  it('keeps check IDs and trust-boundary prose out of the summaries and under Details', async () => {
    // Tall enough that nothing is below the fold: the claim is about placement, not scrolling.
    const ui = renderPanel({
      state: {
        kind: 'blocked',
        report: report([
          availability({ state: 'unavailable', diagnostic: 'connection refused' }),
          TRUST_BOUNDARY,
        ]),
      },
    });

    await flushEffects();
    const rows = (ui.lastFrame() ?? '').split('\n');
    const summaryRow = rows.findIndex((row) => row.includes('is not reachable at'));
    const detailsRow = rows.findIndex((row) => row.includes('Details'));
    const idRow = rows.findIndex((row) => row.includes('runners.availability.planner'));
    const proseRow = rows.findIndex((row) => row.includes('do not sandbox shell'));

    expect(summaryRow).toBeGreaterThanOrEqual(0);
    expect(rows[summaryRow]).not.toContain('runners.availability.planner');
    expect(detailsRow).toBeGreaterThan(summaryRow);
    expect(idRow).toBeGreaterThan(detailsRow);
    expect(proseRow).toBeGreaterThan(detailsRow);
    expect(rows[idRow]).toContain('blocker');
    ui.unmount();
  });

  it.each([
    { cols: 80, rows: 24 },
    { cols: 60, rows: 18 },
  ])('keeps a command in a fix on one row at $cols columns', async (viewport) => {
    const blocker: ReadinessCheck = {
      id: 'runners.preparation.planner',
      severity: 'blocker',
      summary: 'PLAN could not start.',
      fix: 'Use a system-installed command, or continue the run from the command line with `splitbrief continue --allow-repo-runners`.',
    };
    const ui = renderPanel({ state: { kind: 'blocked', report: report([blocker]) } }, viewport);

    await flushEffects();
    expect(ui.lastFrame()).toContain('`splitbrief continue --allow-repo-runners`.');
    ui.unmount();
  });

  it('breaks a command wider than the row at its spaces, never inside the flag', async () => {
    const blocker: ReadinessCheck = {
      id: 'runners.preparation.planner',
      severity: 'blocker',
      summary: 'PLAN could not start.',
      fix: 'Use a system-installed command, or continue the run from the command line with `splitbrief continue --allow-repo-runners`.',
    };
    const ui = renderPanel(
      { state: { kind: 'blocked', report: report([blocker]) } },
      { cols: 44, rows: 18 },
    );

    await flushEffects();
    expect(ui.lastFrame()).toContain('--allow-repo-runners`.');
    ui.unmount();
  });

  it('keeps the repair keys whole at 60x18 and scrolls the copy that does not fit', async () => {
    const readiness = report([
      availability({ state: 'unavailable', diagnostic: 'connection refused' }),
      TRUST_BOUNDARY,
      check('repo.worktree.dirty', 'warning'),
    ]);
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    const ui = renderPanel(
      { state: { kind: 'blocked', report: readiness }, onRetry, onBack, onOpenSettings },
      { cols: 60, rows: 18 },
    );

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    const hint = frame.split('\n').find((row) => row.includes('r retry')) ?? '';
    expect(hint).toContain('r retry');
    expect(hint).toContain('esc back');
    expect(hint).toContain('s settings');
    expect(hint).toContain('scroll');
    expect(
      stripAnsiStyles(frame)
        .split('\n')
        .every((row) => row.length <= 60),
    ).toBe(true);

    ui.stdin.write(DOWN);
    await flushEffects();
    const scrolled = ui.lastFrame() ?? '';
    expect(scrolled).not.toBe(frame);
    // Scrolling never costs the keys: the hint row is chrome, not part of the document.
    expect(scrolled.split('\n').find((row) => row.includes('r retry'))).toBe(hint);

    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write(ESC);
    await tick();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it('gives a blocked card that does not fit every row of the terminal, with no gutter rows', async () => {
    const readiness = report([
      availability({ state: 'unavailable', diagnostic: 'connection refused' }),
      TRUST_BOUNDARY,
      ...Array.from({ length: 8 }, (_, index) => check(`repo.check-${index}`, 'warning')),
    ]);
    const ui = renderPanel(
      { state: { kind: 'blocked', report: readiness } },
      { cols: 80, rows: 24 },
    );

    await flushEffects();
    const lines = stripAnsiStyles(ui.lastFrame()).replace(/\n$/, '').split('\n');
    expect(lines.find((row) => row.includes('r retry'))).toContain('scroll');
    // The card is the page while it shows, so its border sits on the first and the last row.
    expect(lines).toHaveLength(24);
    expect(lines[0]?.trim()).toMatch(/^\+-+\+$/);
    expect(lines[23]?.trim()).toMatch(/^\+-+\+$/);
    ui.unmount();
  });

  it('sanitizes diagnostic and failure text before rendering it', async () => {
    const esc = '\u001b';
    const bel = '\u0007';
    const readiness = report([
      {
        id: `visible-id${esc}]0;hidden-id${bel}`,
        severity: 'blocker',
        summary: `visible-summary${esc}]0;hidden-summary${bel}`,
        fix: `visible-fix${esc}]0;hidden-fix${bel}`,
        details: [`visible-detail${esc}]0;hidden-detail${bel}`],
      },
    ]);
    const ui = renderPanel({
      state: {
        kind: 'failed',
        report: readiness,
        error: new Error(`visible-error${esc}]0;hidden-error${bel}`),
      },
    });

    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('visible-summary');
    expect(frame).toContain('visible-error');
    expect(frame).not.toContain('hidden-id');
    expect(frame).not.toContain('hidden-summary');
    expect(frame).not.toContain('hidden-fix');
    expect(frame).not.toContain('hidden-detail');
    expect(frame).not.toContain('hidden-error');
    ui.unmount();
  });

  it('keeps preparation actions inactive behind an overlay', async () => {
    overlayStore.open('settings');
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    const ui = renderPanel({
      state: { kind: 'blocked', report: report([check('runner', 'blocker')]) },
      onRetry,
      onBack,
      onOpenSettings,
    });

    await flushEffects();
    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write(ESC);
    await tick();

    expect(onRetry).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
    ui.unmount();
  });

  // Before the card, the question painted in its own box; the card must never cut a line that box
  // keeps. A real disclosure names the executable by its absolute path.
  const disclosures = [
    { name: 'a relative path', disclosure: TRUST_DISCLOSURE },
    ...['/Users/someone/work/app/tools/review-bot', '/Users/someone/.local/bin/review-bot'].map(
      (path) => ({
        name: path,
        disclosure: TRUST_DISCLOSURE.replace('"tools/review-bot"', escapeTrustLiteral(path)),
      }),
    ),
  ];
  // A narrow card sheds legend keys and wraps its title where the wider box does not.
  const sizes = [30, 34, 36, 37, 38, 40, 41, 42, 50, 60, 70, 80, 100, 120].flatMap((cols) =>
    [18, 19, 20, 21, 22, 23, 24, 30, 36, 40, 45, 50].map((rows) => ({ cols, rows })),
  );
  it.each(
    disclosures.flatMap(({ name, disclosure }) =>
      sizes.map((size) => ({ name, disclosure, ...size })),
    ),
  )(
    'shows every runner trust line in the card or keeps its own box at $cols x $rows ($name)',
    async ({ disclosure, cols, rows }) => {
      const actionDescription = `${disclosure}\n\n${TRUST_RECEIPT}`;
      const paint = async (card: boolean) => {
        void openApprovalPrompt({
          tier: 'confirm',
          actionClass: 'runner_trust',
          actionDescription,
          phase: 'planning',
        });
        const ui = renderPanel(
          {
            state: { kind: 'preparing' },
            approvalPrompt: (given) => <ApprovalPrompt {...(card && { card: given })} />,
          },
          { cols, rows },
        );
        await flushEffects();
        const frame = stripAnsiStyles(ui.lastFrame()).replace(/\n$/, '');
        ui.unmount();
        approvalPromptStore.__testReset();
        return frame;
      };
      const carded = await paint(true);
      const ownBox = await paint(false);

      expect(carded.split('\n').length).toBeLessThanOrEqual(rows);
      if (!carded.includes(`Tool preparation${SOFT_SEP}Needs you`)) {
        expect(carded).toBe(ownBox);
        return;
      }
      // The rows inside the border, rejoined without white space, because a long fact wraps onto a
      // second row, a path after its separator.
      const text = carded
        .split('\n')
        .map((row) => row.replace(/^\s*[|│]|[|│]\s*$/g, ''))
        .join('')
        .replace(/\s+/g, '');
      for (const line of [
        'Trust and run a configured runner:',
        TRUST_LABEL,
        ...disclosure.split('\n'),
        TRUST_RECEIPT,
        'Confirm',
        'Deny',
        'esc deny',
      ]) {
        expect(text).toContain(line.replace(/\s+/g, ''));
      }
      expect(carded.split('\n').filter((row) => /^\s*\+-+\+\s*$/.test(row))).toHaveLength(2);
    },
  );

  it.each([{ cols: 120 }, { cols: 80 }, { cols: 42 }])(
    'opens the runner trust question in the card from the first row that keeps all of it, at $cols columns',
    async ({ cols }) => {
      const request = {
        actionClass: 'runner_trust',
        actionDescription: `${TRUST_DISCLOSURE}\n\n${TRUST_RECEIPT}`,
      } as const;
      const card = { title: `Tool preparation${SOFT_SEP}Needs you`, density: 'roomy' } as const;
      const minRows = confirmPanelMinRows(request, {
        width: overlayRect({ cols, rows: 40, density: card.density }).innerWidth,
        kind: 'card',
        card,
      });
      for (const [rows, carded] of [
        [minRows, true],
        [minRows - 1, false],
      ] as const) {
        void openApprovalPrompt({ tier: 'confirm', phase: 'planning', ...request });
        const ui = renderPanel(
          {
            state: { kind: 'preparing' },
            approvalPrompt: (given) => <ApprovalPrompt card={given} />,
          },
          { cols, rows },
        );
        await flushEffects();
        expect(stripAnsiStyles(ui.lastFrame()).includes(card.title)).toBe(carded);
        ui.unmount();
        approvalPromptStore.__testReset();
      }
    },
  );

  it.each([{ cols: 120 }, { cols: 80 }])(
    'keeps one blank row above the runner trust legend at every height the card adds, at $cols columns',
    async ({ cols }) => {
      const request = {
        actionClass: 'runner_trust',
        actionDescription: `${TRUST_DISCLOSURE}\n\n${TRUST_RECEIPT}`,
      } as const;
      const card = { title: `Tool preparation${SOFT_SEP}Needs you`, density: 'roomy' } as const;
      const minRows = confirmPanelMinRows(request, {
        width: overlayRect({ cols, rows: 40, density: card.density }).innerWidth,
        kind: 'card',
        card,
      });
      for (let rows = minRows + 2; rows <= minRows + 7; rows += 1) {
        void openApprovalPrompt({ tier: 'confirm', phase: 'planning', ...request });
        const ui = renderPanel(
          {
            state: { kind: 'preparing' },
            approvalPrompt: (given) => <ApprovalPrompt card={given} />,
          },
          { cols, rows },
        );
        await flushEffects();
        const inner = stripAnsiStyles(ui.lastFrame())
          .split('\n')
          .map((row) => row.replace(/^\s*[|│]|[|│]\s*$/g, '').trim());
        const legend = inner.findIndex((row) => row.includes('esc deny'));
        expect({ rows, above: inner.slice(legend - 2, legend) }).toEqual({
          rows,
          above: [expect.stringContaining('Deny'), ''],
        });
        ui.unmount();
        approvalPromptStore.__testReset();
      }
    },
  );

  it.each([
    { cols: 120, rows: 40 },
    { cols: 80, rows: 24 },
  ])('opens the runner trust question in the card at $cols x $rows', async ({ cols, rows }) => {
    for (const { disclosure } of disclosures) {
      void openApprovalPrompt({
        tier: 'confirm',
        actionClass: 'runner_trust',
        actionDescription: `${disclosure}\n\n${TRUST_RECEIPT}`,
        phase: 'planning',
      });
      const ui = renderPanel(
        {
          state: { kind: 'preparing' },
          approvalPrompt: (card) => <ApprovalPrompt card={card} />,
        },
        { cols, rows },
      );
      await flushEffects();
      expect(stripAnsiStyles(ui.lastFrame())).toContain(`Tool preparation${SOFT_SEP}Needs you`);
      ui.unmount();
      approvalPromptStore.__testReset();
    }
  });

  it('paints the caller-supplied tiered approval into the card instead of generic actions', async () => {
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    const approvalPrompt = vi.fn(() => <Text>Tiered approval</Text>);
    const ui = renderPanel({
      state: { kind: 'preparing' },
      onRetry,
      onBack,
      onOpenSettings,
      approvalPrompt,
    });

    await flushEffects();
    // The question paints the card, so it can give back the card's blank rows on a short terminal.
    expect(approvalPrompt).toHaveBeenLastCalledWith({
      title: `Tool preparation${SOFT_SEP}Needs you`,
      density: 'roomy',
    });
    expect(ui.lastFrame()).toContain('Tiered approval');
    expect(ui.lastFrame()).not.toContain('r retry');

    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write(ESC);
    await tick();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
    ui.unmount();
  });
});
