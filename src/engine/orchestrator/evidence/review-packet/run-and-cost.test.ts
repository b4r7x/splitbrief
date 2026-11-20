import { afterEach, describe, it, expect } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../../core/sessions/spec-files.js';
import { writeSeatIdentities } from '../../../../core/state/seats/record.js';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { createInitialState } from '../../../../core/state/machine.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { buildRun } from './run.js';
import { renderReviewPacketMarkdown } from './render.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { NULL_CACHE } from '../../../providers/model/runtime-snapshot.js';

describe('buildRun seat identity kinds', () => {
  function makeRun(summary: Parameters<typeof buildRun>[0]['summary'], state: WorkflowState) {
    return buildRun(
      {
        projectDir: '/tmp/project',
        workspaceDir: '/tmp/project',
        sessionId: 's',
        summary,
        state,
        finalReviewStatus: 'written',
      },
      [],
    );
  }

  it('fills the reviewer from the recorded summary seat without mixing state fields', () => {
    const run = makeRun(
      makeSummary({
        reviewerTool: 'codex',
        reviewerModel: 'gpt-6.1-sol',
        reviewerKind: 'cli',
      }),
      {
        ...createInitialState('feat'),
        reviewerTool: 'old-endpoint',
        reviewerModel: 'old-model',
        reviewerKind: 'api',
      },
    );

    expect(run.reviewer).toEqual({ tool: 'codex', model: 'gpt-6.1-sol', kind: 'cli' });
  });

  it('takes the recorded reviewer from state when the summary names none', () => {
    const run = makeRun(makeSummary(), {
      ...createInitialState('feat'),
      reviewerTool: 'codex',
      reviewerModel: 'gpt-6.1-sol',
      reviewerKind: 'cli',
    });

    expect(run.reviewer).toEqual({ tool: 'codex', model: 'gpt-6.1-sol', kind: 'cli' });
  });

  it('keeps the reviewer model and kind unknown when the summary names only its tool', () => {
    const run = makeRun(makeSummary({ reviewerTool: 'codex' }), {
      ...createInitialState('feat'),
      reviewerTool: 'old-endpoint',
      reviewerModel: 'old-model',
      reviewerKind: 'api',
    });

    expect(run.reviewer).toEqual({ tool: 'codex', model: null, kind: null });
  });

  it('names the planner that holds REVIEW when no separate reviewer is recorded', () => {
    const run = makeRun(
      makeSummary({
        plannerTool: 'claude-code',
        plannerModel: 'sonnet',
        plannerKind: 'cli',
      }),
      createInitialState('feat'),
    );

    expect(run.reviewer).toEqual({ tool: 'claude-code', model: 'sonnet', kind: 'cli' });
    expect(renderReviewPacketMarkdown(makeReviewPacket({ run }), NULL_CACHE)).toContain(
      '- Reviewer: Claude Code CLI · Sonnet 5',
    );
  });

  it.each(['complete', 'tool-only'])(
    'uses the planner after switching a configured reviewer to inheritance before resume, with %s planner details',
    (details) => {
      const plannerModel = details === 'complete' ? 'sonnet' : undefined;
      const plannerKind = details === 'complete' ? 'cli' : undefined;
      const run = makeRun(makeSummary({ plannerTool: 'claude-code', plannerModel, plannerKind }), {
        ...createInitialState('feat'),
        plannerTool: 'old-planner',
        plannerModel: 'old-planner-model',
        plannerKind: 'shell',
        reviewerTool: 'old-endpoint',
        reviewerModel: 'old-reviewer-model',
        reviewerKind: 'api',
      });

      expect(run.reviewer).toEqual({
        tool: 'claude-code',
        model: plannerModel ?? null,
        kind: plannerKind ?? null,
      });
      const markdown = renderReviewPacketMarkdown(makeReviewPacket({ run }), NULL_CACHE);
      expect(markdown).toContain('- Reviewer: Claude Code CLI');
      expect(markdown).not.toContain('old-endpoint');
    },
  );

  it('keeps REVIEW unknown when neither seat is recorded', () => {
    const run = makeRun(makeSummary(), createInitialState('feat'));

    expect(run.reviewer).toEqual({ tool: null, model: null, kind: null });
    expect(renderReviewPacketMarkdown(makeReviewPacket({ run }), NULL_CACHE)).toContain(
      '- Reviewer: n/a\n',
    );
  });

  it('carries each seat kind from the summary record that named its tool', () => {
    const run = makeRun(
      makeSummary({
        feature: 'feat',
        plannerTool: 'opencode',
        plannerKind: 'api',
        implementerTool: 'claude-code',
        implementerKind: 'cli',
      }),
      createInitialState('feat'),
    );

    expect(run.planner).toEqual({ tool: 'opencode', model: null, kind: 'api' });
    expect(run.implementer).toEqual({ tool: 'claude-code', model: null, kind: 'cli' });
  });

  it('takes a whole legacy seat from the state when the summary names none', () => {
    const run = makeRun(makeSummary({ feature: 'feat' }), {
      ...createInitialState('feat'),
      plannerTool: 'claude-code',
      plannerKind: 'cli',
    });

    expect(run.planner).toEqual({ tool: 'claude-code', model: null, kind: 'cli' });
    expect(run.implementer).toEqual({ tool: null, model: null, kind: null });
  });

  it('keeps a legacy summary tool unknown rather than borrowing another record kind', () => {
    const run = makeRun(makeSummary({ feature: 'feat', plannerTool: 'claude-code' }), {
      ...createInitialState('feat'),
      plannerTool: 'retired-tool',
      plannerKind: 'shell',
    });

    expect(run.planner).toEqual({ tool: 'claude-code', model: null, kind: null });
  });

  it('keeps the planner model unknown when the summary names the tool without a model', () => {
    const run = makeRun(
      makeSummary({ feature: 'feat', plannerTool: 'new-shell', plannerKind: 'shell' }),
      {
        ...createInitialState('feat'),
        plannerTool: 'old-api',
        plannerModel: 'old-model',
        plannerKind: 'api',
      },
    );

    expect(run.planner).toEqual({ tool: 'new-shell', model: null, kind: 'shell' });
  });

  it('keeps the implementer model unknown when the summary names the tool without a model', () => {
    const run = makeRun(
      makeSummary({ feature: 'feat', implementerTool: 'new-shell', implementerKind: 'shell' }),
      {
        ...createInitialState('feat'),
        implementerTool: 'old-api',
        implementerModel: 'old-model',
        implementerKind: 'api',
      },
    );

    expect(run.implementer).toEqual({ tool: 'new-shell', model: null, kind: 'shell' });
  });
});

describe('buildRun recorded axes', () => {
  let projectDir: string;
  afterEach(() => cleanupTempDir(projectDir));

  function recordedRun(summary: Parameters<typeof buildRun>[0]['summary']) {
    projectDir = createTempDir('packet-seat-axes');
    const ref = { projectDir, sessionId: 's' };
    ensureSessionDir(projectDir, ref.sessionId);
    writeSeatIdentities(ref, {
      plan: 'plan',
      build: 'build',
      review: 'review',
      ids: {
        plan: { tool: 'codex', model: 'gpt-5', kind: 'cli', axes: ['xhigh'] },
        build: {
          tool: 'opencode',
          model: 'opencode-go/deepseek-v4.1-flash',
          kind: 'cli',
          axes: ['high'],
        },
        review: { tool: 'codex', model: 'gpt-5', kind: 'cli', axes: ['high'] },
      },
    });
    return buildRun(
      {
        ...ref,
        workspaceDir: ref.projectDir,
        summary,
        state: createInitialState('feat'),
        finalReviewStatus: 'written',
      },
      [],
    );
  }

  it('keeps matching recorded axes on all packet seats', () => {
    const run = recordedRun(
      makeSummary({
        plannerTool: 'codex',
        plannerModel: 'gpt-5',
        plannerKind: 'cli',
        implementerTool: 'opencode',
        implementerModel: 'opencode-go/deepseek-v4.1-flash',
        implementerKind: 'cli',
        reviewerTool: 'codex',
        reviewerModel: 'gpt-5',
        reviewerKind: 'cli',
      }),
    );

    expect(run.implementer.axes).toEqual(['high']);
    expect(run.planner.axes).toEqual(['xhigh']);
    expect(run.reviewer?.axes).toEqual(['high']);
  });

  it('leaves axes unknown for a different summary seat or kind', () => {
    const run = recordedRun(
      makeSummary({
        plannerTool: 'codex',
        plannerModel: 'gpt-5',
        plannerKind: 'api',
        implementerTool: 'opencode',
        implementerModel: 'deepseek/deepseek-flash',
        implementerKind: 'cli',
        reviewerTool: 'other-reviewer',
        reviewerModel: 'gpt-5',
        reviewerKind: 'cli',
      }),
    );

    expect(run.implementer.axes).toBeUndefined();
    expect(run.planner.axes).toBeUndefined();
    expect(run.reviewer?.axes).toBeUndefined();
  });
});
