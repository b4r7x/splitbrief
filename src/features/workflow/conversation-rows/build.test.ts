import { describe, expect, it } from 'vitest';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { groupEventsIntoSections, type Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { makePlannerHeartbeat, makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { makeTaskComplete, makeTaskStart, makeTaskTokens } from '#testing/helpers/events/task.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../display/activity-label-display.js';
import { activityBatchKey } from './activity-batch-key.js';
import { resetEventBlockCache } from './block-cache.js';
import { buildConversationRows, buildConversationRowsProjection } from './build.js';
import { materializeConversationRowsWindow } from './materialize-window.js';
import { wrappedTextBlock } from './row-block-compose.js';
import { rowText } from './row-format/rows.js';
import { wrapWidthFor } from './row-markers.js';
import type { ConversationRow } from './types.js';
import { taskId } from '../../../core/schemas/task.js';
import { arrowSep, SOFT_SEP } from '../../../core/separators.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { buildCheckoutChangedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };
const CODEX_LABEL = 'OpenAI Codex CLI';
const CLAUDE_CODE_LABEL = 'Claude Code CLI';

function activityLine(label: Parameters<typeof displayActivityLabel>[0], value: string): string {
  return `${displayActivityLabel(label).padEnd(ACTIVITY_LABEL_PAD)}  ${value}`;
}

function activity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return makeRunnerCallActivity({
    ts: 0,
    phase: 'researching',
    role: 'planner',
    runnerName: 'codex',
    sequence: 1,
    activityId: 'activity-1',
    stage: 'updated',
    kind: 'unknown',
    label: 'checking project',
    ...overrides,
  });
}

describe('buildConversationRows', () => {
  it('strips the planner H1 that echoes the user prompt so the title renders once', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          { type: 'user_message', ts: 0, phase: 'idle', text: 'Add dark-mode toggle' },
          {
            type: 'planner_text',
            ts: 1,
            phase: 'analyzing',
            content: 'markdown',
            text: '# Add dark-mode toggle\n\nLooking into the request now.',
          },
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');
    const occurrences = text.split('Add dark-mode toggle').length - 1;

    expect(occurrences).toBe(1);
    expect(text).toContain('Looking into the request now.');
  });

  it('batches repeated runner activity from one call into one renderable block', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'call-1:tool:sed-start',
            kind: 'command',
            label:
              'running "sed -n \'1,240p\' CLAUDE.md" /bin/zsh -lc "sed -n \'1,240p\' CLAUDE.md"',
            target: '"sed -n \'1,240p\' CLAUDE.md" /bin/zsh -lc "sed -n \'1,240p\' CLAUDE.md"',
          }),
          activity({
            sequence: 2,
            activityId: 'call-1:tool:sed-done',
            kind: 'command',
            label: '/bin/zsh -lc "sed -n \'1,240p\' CLAUDE.md"',
          }),
          activity({
            sequence: 3,
            activityId: 'call-1:tool:wc',
            kind: 'command',
            label: 'running wc -l CLAUDE.md',
            target: 'wc -l CLAUDE.md',
          }),
          activity({
            sequence: 4,
            activityId: 'call-1:plan:rg',
            kind: 'plan',
            label: 'planning /bin/zsh -lc "rg -n \\"Task Brief|brief|tasks\\\\.md\\""',
          }),
        ],
      },
    ];

    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(renderableCount).toBe(3);
    expect(text).toContain(`${CREW_SEAT_LABELS.plan} activity  3 updates  [${CODEX_LABEL}]`);
    expect(text).not.toContain('sed -n');
    expect(text).toContain(activityLine('READ', 'CLAUDE.md :1-240'));
    expect(text).toContain(activityLine('RUN', 'wc -l CLAUDE.md'));
    expect(text).toContain(activityLine('PLAN', 'rg -n \\'));
    expect(text).not.toContain('/bin/zsh -lc');
    expect(text).not.toContain('activity:');
  });

  it('counts duplicate raw activity events by normalized visible activity', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'run-start',
            kind: 'command',
            label: 'running /bin/zsh -lc "npm run typecheck"',
            target: '/bin/zsh -lc "npm run typecheck"',
          }),
          activity({
            sequence: 2,
            activityId: 'run-done',
            kind: 'command',
            label: '/bin/zsh -lc "npm run typecheck"',
          }),
          activity({
            sequence: 3,
            activityId: 'run-repeat',
            kind: 'command',
            label: 'running npm run typecheck',
            target: 'npm run typecheck',
          }),
          activity({
            sequence: 4,
            activityId: 'read',
            kind: 'read',
            label: 'reading src/app.ts',
          }),
        ],
      },
    ];

    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(renderableCount).toBe(2);
    expect(text).toContain(`${CREW_SEAT_LABELS.plan} activity  2 updates  [${CODEX_LABEL}]`);
    expect(text.match(/npm run typecheck/g)).toHaveLength(1);
    expect(text).toContain(activityLine('READ', 'src/app.ts'));
    expect(text).not.toContain('+  ');
  });

  it('keeps recent activity rows with a +N more affordance', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
        ],
      },
    ];

    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(renderableCount).toBe(4);
    expect(text).toContain(`${CREW_SEAT_LABELS.plan} activity  4 updates  [${CODEX_LABEL}]`);
    expect(text).not.toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('c.ts');
    expect(text).toContain('d.ts');
    expect(text).toContain('+1 more · ctrl+a');
    expect(text).not.toContain('/activity');
    expect(text).not.toContain('Ctrl+A');
    expect(text).not.toContain('┌─');
    expect(text).not.toContain('└');

    const expanded = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set([activityBatchKey(0, 'call-1')]),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const expandedText = expanded.rows.map(rowText).join('\n');

    expect(expandedText).toContain('collapse');
    expect(expandedText).toContain('a.ts');
  });

  it('keeps a collapsed activity block in event order, the warning counted in its header', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'warning',
            kind: 'warning',
            label: 'warning stderr',
          }),
          activity({ sequence: 2, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          activity({ sequence: 3, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          activity({ sequence: 4, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          activity({ sequence: 5, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain(
      `${CREW_SEAT_LABELS.plan} activity  5 updates  1 warn  [${CODEX_LABEL}]`,
    );
    const warnLine = activityLine('WARN', 'stderr');
    expect(text).not.toContain(warnLine);
    expect(text).not.toContain(activityLine('READ', 'a.ts'));
    expect(text).toContain(activityLine('READ', 'b.ts'));
    expect(text.indexOf(activityLine('READ', 'b.ts'))).toBeLessThan(
      text.indexOf(activityLine('READ', 'c.ts')),
    );
    expect(text.indexOf(activityLine('READ', 'c.ts'))).toBeLessThan(
      text.indexOf(activityLine('READ', 'd.ts')),
    );

    const expanded = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set([activityBatchKey(0, 'call-1')]),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const expandedText = expanded.rows.map(rowText).join('\n');

    expect(expandedText).toContain('collapse');
    expect(expandedText).toContain(activityLine('READ', 'a.ts'));
    expect(expandedText).toContain(activityLine('READ', 'b.ts'));
    expect(expandedText.indexOf(warnLine)).toBeLessThan(
      expandedText.indexOf(activityLine('READ', 'a.ts')),
    );
    expect(expandedText.indexOf(activityLine('READ', 'a.ts'))).toBeLessThan(
      expandedText.indexOf(activityLine('READ', 'b.ts')),
    );
    expect(expandedText.indexOf(activityLine('READ', 'b.ts'))).toBeLessThan(
      expandedText.indexOf(activityLine('READ', 'c.ts')),
    );
    expect(expandedText.indexOf(activityLine('READ', 'c.ts'))).toBeLessThan(
      expandedText.indexOf(activityLine('READ', 'd.ts')),
    );
  });

  it('sanitizes runner metadata in compact activity batch headers', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'a',
            kind: 'read',
            label: 'reading a.ts',
            runnerName: `runner ${jwt}`,
            model: 'model sk-abcdefghijklmnopqrstuvwxyz',
          }),
          activity({
            sequence: 2,
            activityId: 'b',
            kind: 'read',
            label: 'reading b.ts',
            runnerName: `runner ${jwt}`,
            model: 'model sk-abcdefghijklmnopqrstuvwxyz',
          }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('runner ***REDACTED***');
    expect(text).toContain('Model sk ***REDACTED***');
    expect(text).not.toContain('eyJhbGci');
    expect(text.toLowerCase()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('renders user interruption as warning copy without internal runner codes', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            stage: 'aborted',
            kind: 'error',
            label: 'aborted runner_interrupted',
            diagnosticPartial: 'Claude stream interrupted',
          }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain(activityLine('WARN', 'current turn interrupted'));
    expect(text).not.toContain('runner_interrupted');
  });

  it('shows sanitized warning and error diagnostics in the compact transcript', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'warning',
            stage: 'warning',
            kind: 'warning',
            label: 'warning stderr',
            diagnosticPartial: 'npm deprecated package token sk-abcdefghijklmnopqrstuvwxyz',
            redacted: true,
          }),
          activity({
            sequence: 2,
            activityId: 'error',
            stage: 'failed',
            kind: 'error',
            label: 'failed exit_code_1',
            diagnosticPartial: 'Command failed: npm test',
          }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 96,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain(
      activityLine('WARN', 'stderr: npm deprecated package token sk-***REDACTED***'),
    );
    expect(text).toContain(activityLine('ERR', 'exit_code_1: Command failed: npm test'));
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('row-less events never split an activity batch', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          makePlannerHeartbeat({ ts: 1 }),
          activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          makePlannerStatus({ ts: 2, phase: 'researching' }),
          activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          makeTaskTokens({ ts: 3 }),
          activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
        ],
      },
    ];

    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(renderableCount).toBe(4);
    expect(text.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(1);
    expect(text).toContain(`${CREW_SEAT_LABELS.plan} activity  4 updates  [${CODEX_LABEL}]`);
    expect(text).not.toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('c.ts');
    expect(text).toContain('d.ts');
  });

  it('a visible foreign row closes the activity batch', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
          { type: 'planner_text', ts: 5, phase: 'researching', text: 'Status update.' },
          activity({ sequence: 5, activityId: 'e', kind: 'read', label: 'reading e.ts' }),
          activity({ sequence: 6, activityId: 'f', kind: 'read', label: 'reading f.ts' }),
          activity({ sequence: 7, activityId: 'g', kind: 'read', label: 'reading g.ts' }),
          activity({ sequence: 8, activityId: 'h', kind: 'read', label: 'reading h.ts' }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(2);
    expect(text).toContain('Status update.');
    expect(text).not.toContain('a.ts');
    expect(text).toContain('d.ts');
    expect(text).not.toContain('e.ts');
    expect(text).toContain('h.ts');
  });

  it('a long runner call with interleaved heartbeats yields one coalescing ledger', () => {
    const longCall: EngineEvent[] = [
      activity({ sequence: 1, activityId: 'read-app', kind: 'read', label: 'reading src/app.ts' }),
      makePlannerHeartbeat({ ts: 1 }),
      activity({
        sequence: 2,
        activityId: 'typecheck',
        kind: 'command',
        label: 'running npm run typecheck',
        target: 'npm run typecheck',
      }),
      makePlannerStatus({ ts: 2, phase: 'researching' }),
      activity({
        sequence: 3,
        activityId: 'read-config',
        kind: 'read',
        label: 'reading src/config.ts',
      }),
      makePlannerHeartbeat({ ts: 3 }),
      makeTaskTokens({ ts: 4 }),
      activity({
        sequence: 4,
        activityId: 'search-store',
        kind: 'search',
        label: 'searching createStore',
      }),
      makePlannerHeartbeat({ ts: 5 }),
      activity({
        sequence: 5,
        activityId: 'read-store',
        kind: 'read',
        label: 'reading src/stores/create-store.ts',
      }),
      makePlannerStatus({ ts: 6, phase: 'researching' }),
      activity({
        sequence: 6,
        activityId: 'plan-briefs',
        kind: 'plan',
        label: 'planning task briefs',
      }),
      makePlannerHeartbeat({ ts: 7 }),
      makeTaskTokens({ ts: 8 }),
      activity({
        sequence: 7,
        activityId: 'read-docs',
        kind: 'read',
        label: 'reading docs/STORES.md',
      }),
      makePlannerHeartbeat({ ts: 9 }),
      activity({
        sequence: 8,
        activityId: 'run-tests',
        kind: 'command',
        label: 'running npm test',
        target: 'npm test',
      }),
    ];

    const single = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items: longCall }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const singleText = single.rows.map(rowText).join('\n');

    expect(singleText.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(1);
    expect(singleText).toContain(`${CREW_SEAT_LABELS.plan} activity  8 updates  [${CODEX_LABEL}]`);
    expect(single.renderableCount).toBe(8);

    const continued: EngineEvent[] = [
      ...longCall,
      { type: 'planner_text', ts: 10, phase: 'researching', text: 'Draft plan ready.' },
      activity({
        sequence: 9,
        activityId: 'read-router',
        kind: 'read',
        label: 'reading src/router.ts',
      }),
      activity({
        callId: 'call-2',
        sequence: 1,
        activityId: 'read-verify',
        kind: 'read',
        label: 'reading src/verify.ts',
      }),
    ];

    const resumed = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items: continued }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const resumedText = resumed.rows.map(rowText).join('\n');

    expect(resumedText).toContain('Draft plan ready.');
    expect(resumedText.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(3);
  });

  it('planner and implementer calls coalesce identically', () => {
    const read = (
      role: 'planner' | 'implementer',
      runnerName: string,
      sequence: number,
      file: string,
    ) =>
      activity({
        role,
        runnerName,
        sequence,
        activityId: file,
        kind: 'read',
        label: `reading ${file}`,
      });
    const callEvents = (role: 'planner' | 'implementer', runnerName: string): EngineEvent[] => [
      read(role, runnerName, 1, 'a.ts'),
      makePlannerHeartbeat({ ts: 1 }),
      read(role, runnerName, 2, 'b.ts'),
      makePlannerStatus({ ts: 2, phase: 'researching' }),
      read(role, runnerName, 3, 'c.ts'),
      makeTaskTokens({ ts: 3 }),
      read(role, runnerName, 4, 'd.ts'),
      makePlannerHeartbeat({ ts: 4 }),
      read(role, runnerName, 5, 'e.ts'),
      read(role, runnerName, 6, 'f.ts'),
    ];
    const buildFor = (items: EngineEvent[]) =>
      buildConversationRows({
        sections: [{ type: 'events', startIndex: 0, items }],
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 88,
        viewportHeight: 20,
        streaming,
      });

    const planner = buildFor(callEvents('planner', 'codex'));
    const implementer = buildFor(callEvents('implementer', 'claude-code'));
    const plannerText = planner.rows.map(rowText).join('\n');
    const implementerText = implementer.rows.map(rowText).join('\n');

    expect(plannerText.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(1);
    expect(
      implementerText.match(new RegExp(`${CREW_SEAT_LABELS.build} activity`, 'g')),
    ).toHaveLength(1);
    expect(plannerText).toContain(`${CREW_SEAT_LABELS.plan} activity  6 updates  [${CODEX_LABEL}]`);
    expect(implementerText).toContain(
      `${CREW_SEAT_LABELS.build} activity  6 updates  [${CLAUDE_CODE_LABEL}]`,
    );
    expect(plannerText).toContain('+3 more');
    expect(implementerText).toContain('+3 more');
    expect(implementer.renderableCount).toBe(planner.renderableCount);
    expect(implementer.rows).toHaveLength(planner.rows.length);
  });

  it('names each batch after the tool and model its own call ran, as the seat identity spells them', () => {
    // The Claude runner names a plan call by its command and a build call by its tool id, both on
    // the `opus` alias. The Codex call is the plan seat after a swap; the Claude batches keep theirs.
    const call = (input: {
      callId: string;
      role: 'planner' | 'implementer';
      runnerName: string;
      model: string;
      sequence: number;
    }) =>
      activity({
        callId: input.callId,
        role: input.role,
        runnerName: input.runnerName,
        model: input.model,
        sequence: input.sequence,
        activityId: input.callId,
        kind: 'read',
        label: `reading ${input.callId}.ts`,
      });
    const { rows } = buildConversationRows({
      sections: [
        {
          type: 'events',
          startIndex: 0,
          items: [
            call({
              callId: 'plan-claude',
              role: 'planner',
              runnerName: 'claude',
              model: 'opus',
              sequence: 1,
            }),
            call({
              callId: 'build-claude',
              role: 'implementer',
              runnerName: 'claude-code',
              model: 'opus',
              sequence: 2,
            }),
            call({
              callId: 'plan-codex',
              role: 'planner',
              runnerName: 'codex',
              model: 'gpt-5.5',
              sequence: 3,
            }),
          ],
        },
      ],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });

    expect(rows.filter((row) => row.kind === 'activity').map(rowText)).toEqual([
      `${CREW_SEAT_LABELS.plan} activity  1 update  [${CLAUDE_CODE_LABEL} · Opus 5.5]`,
      `${CREW_SEAT_LABELS.build} activity  1 update  [${CLAUDE_CODE_LABEL} · Opus 5.5]`,
      `${CREW_SEAT_LABELS.plan} activity  1 update  [${CODEX_LABEL} · GPT-5.5]`,
    ]);
  });

  it('sheds the model, then the whole runner, before a narrow header would cut a name', () => {
    const items = [
      activity({ runnerName: 'claude', model: 'opus', kind: 'read', label: 'reading a.ts' }),
      activity({
        runnerName: 'claude',
        model: 'opus',
        sequence: 2,
        activityId: 'warning',
        stage: 'warning',
        kind: 'warning',
        label: 'warning stderr',
      }),
    ];
    const headerAt = (cols: number): string | undefined => {
      const [header] = buildConversationRows({
        sections: [{ type: 'events', startIndex: 0, items }],
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols,
        viewportHeight: 20,
        streaming,
      }).rows;
      return header === undefined ? undefined : rowText(header);
    };
    const summary = `${CREW_SEAT_LABELS.plan} activity  2 updates  1 warn`;

    expect(headerAt(88)).toBe(`${summary}  [${CLAUDE_CODE_LABEL} · Opus 5.5]`);
    expect(headerAt(60)).toBe(`${summary}  [${CLAUDE_CODE_LABEL}]`);
    expect(headerAt(48)).toBe(summary);
  });

  it('expands two same-timestamp diffs independently', () => {
    const ts = 1234;
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          makeImplementerGenerate({ status: 'done', file: 'a.ts', diff: '+ first line', ts }),
          makeImplementerGenerate({ status: 'done', file: 'b.ts', diff: '+ second line', ts }),
        ],
      },
    ];
    const inputs = {
      sections,
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    };

    const firstExpanded = buildConversationRows({
      ...inputs,
      expandedDiffs: new Set(['implementer_generate_done:0']),
    });
    const firstText = firstExpanded.rows.map(rowText).join('\n');
    expect(firstText).toContain('first line');
    expect(firstText).not.toContain('second line');

    const secondExpanded = buildConversationRows({
      ...inputs,
      expandedDiffs: new Set(['implementer_generate_done:1']),
    });
    const secondText = secondExpanded.rows.map(rowText).join('\n');
    expect(secondText).toContain('second line');
    expect(secondText).not.toContain('first line');
  });
});

// S11 run 3: the run-start warning, `T004 also changed …` and the `Batch suite · …` rows sat above
// the live brief for the rest of the run. Once the next brief starts they collapse with a brief.
describe('rows no brief owns collapse with the completed briefs', () => {
  const runStartWarning: EngineEventOf<'warning'> = {
    type: 'warning',
    ts: 2,
    phase: 'implementing',
    message: 'The test stage of the full suite timed out after 600s at the run-start baseline',
  };
  const boundarySuite: EngineEventOf<'full_suite'> = {
    type: 'full_suite',
    ts: 4,
    phase: 'implementing',
    status: 'done',
    stage: 'typecheck',
    command: 'npm run typecheck',
    moment: 'boundary',
    passed: true,
    duration: 16003,
  };
  const touched: EngineEventOf<'task_touched_not_suggested'> = {
    type: 'task_touched_not_suggested',
    ts: 3,
    phase: 'implementing',
    taskId: taskId('T001'),
    files: ['skills/splitbrief-run/references/tool-recipes.md'],
  };

  it('shows none of them once the next brief runs', () => {
    const events: EngineEvent[] = [
      {
        type: 'tasks_planned',
        ts: 1,
        phase: 'implementing',
        tasks: [],
        total: 2,
      },
      runStartWarning,
      makeTaskStart({ taskId: taskId('T001'), title: 'First brief', index: 0 }),
      makeTaskComplete({ taskId: taskId('T001') }),
      touched,
      boundarySuite,
      makeTaskStart({ taskId: taskId('T002'), title: 'Second brief', index: 1 }),
    ];

    const { rows } = buildConversationRows({
      sections: groupEventsIntoSections(events),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 30,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('Second brief');
    expect(text).not.toContain('timed out');
    expect(text).not.toContain('tool-recipes.md');
    expect(text).not.toContain('npm run typecheck');
  });
});

describe('wrappedTextBlock', () => {
  it('wraps message rows at width minus their leading so nothing clips at the right edge', () => {
    const width = 20;
    const text = 'x'.repeat(width);
    const block = wrappedTextBlock({ keyPrefix: 'k', text, width, tone: 'text' });
    expect(block?.rowCount).toBe(2);
    const rows = block?.createRows(0, 2) ?? [];
    for (const row of rows) {
      const line = row.segments.map((segment) => segment.text).join('');
      expect(line.length).toBeLessThanOrEqual(wrapWidthFor('message', width));
    }
  });
});

describe('buildConversationRowsProjection section spacers', () => {
  it('inserts exactly one renderableUnits-0 one-row blank spacer between adjacent sections, none at the edges', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          makeImplementerGenerate({ status: 'done', file: 'a.ts', diff: '+ a', ts: 1 }),
          makeImplementerGenerate({ status: 'done', file: 'b.ts', diff: '+ b', ts: 2 }),
        ],
      },
    ];

    const projection = buildConversationRowsProjection({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });

    const spacerIndexes = projection.blocks
      .map((block, index) => (block.key.startsWith('spacer-') ? index : -1))
      .filter((index) => index >= 0);

    // Exactly one spacer, sitting strictly between the two section blocks — never first, never last,
    // so no dangling blank hangs above the input.
    expect(spacerIndexes).toHaveLength(1);
    const spacerIndex = spacerIndexes[0] ?? -1;
    expect(spacerIndex).toBeGreaterThan(0);
    expect(spacerIndex).toBeLessThan(projection.blocks.length - 1);

    const spacer = projection.blocks[spacerIndex];
    // One blank row gives the transcript a calmer one-row rhythm between sections.
    expect(spacer?.rowCount).toBe(1);
    // renderableUnits 0 keeps the spacer out of the new-event count and the auto-scroll math.
    expect(spacer?.renderableUnits).toBe(0);
  });
});

describe('buildConversationRowsProjection event block cache', () => {
  it('reuses prior event blocks by identity on append', () => {
    resetEventBlockCache();

    const userMessage: EngineEventOf<'user_message'> = {
      type: 'user_message',
      ts: 0,
      phase: 'idle',
      text: 'Add dark-mode toggle',
    };
    const firstPlannerText: EngineEventOf<'planner_text'> = {
      type: 'planner_text',
      ts: 1,
      phase: 'analyzing',
      content: 'markdown',
      text: 'Looking into the request now.',
    };
    const secondPlannerText: EngineEventOf<'planner_text'> = {
      type: 'planner_text',
      ts: 2,
      phase: 'analyzing',
      content: 'markdown',
      text: 'Second update landed.',
    };

    const projectionFor = (items: EngineEvent[]) => {
      const sections: Section<EngineEvent>[] = [{ type: 'events', startIndex: 0, items }];
      return buildConversationRowsProjection({
        sections,
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 88,
        viewportHeight: 20,
        streaming,
      });
    };

    const first = projectionFor([userMessage, firstPlannerText]);
    const firstEventBlocks = first.blocks.filter((block) => !block.key.startsWith('spacer-'));

    const second = projectionFor([userMessage, firstPlannerText, secondPlannerText]);
    const secondEventBlocks = second.blocks.filter((block) => !block.key.startsWith('spacer-'));

    expect(secondEventBlocks[0]).toBe(firstEventBlocks[0]);
    expect(secondEventBlocks[1]).toBe(firstEventBlocks[1]);

    const incrementalText = materializeConversationRowsWindow({
      projection: second,
      windowStart: 0,
      windowEnd: second.totalRows,
    })
      .map(rowText)
      .join('\n');

    resetEventBlockCache();
    const fresh = projectionFor([userMessage, firstPlannerText, secondPlannerText]);
    const freshText = materializeConversationRowsWindow({
      projection: fresh,
      windowStart: 0,
      windowEnd: fresh.totalRows,
    })
      .map(rowText)
      .join('\n');

    expect(incrementalText).toBe(freshText);
  });
});

describe('one recovery reads as one block', () => {
  const at = { ts: 0, phase: 'implementing' } as const;
  const recovery = { ...at, issueId: 'issue-1', reason: 'checkout-changed' } as const;
  const halt: EngineEvent = {
    ...at,
    type: 'error',
    message: 'Your checkout changed under T002 — branch cli-budget-behaviour-fixes',
  };
  const prompted: EngineEvent = {
    ...recovery,
    type: 'recovery_prompted',
    taskId: taskId('T002'),
    files: [],
    affectedTaskIds: [],
    availableActions: ['retry-same-worker'],
    recommendedAction: 'retry-same-worker',
    headline: 'Your checkout changed under T002',
    resumeCommand: 'splitbrief continue',
  };
  const selected: EngineEvent = {
    ...recovery,
    type: 'recovery_action_selected',
    action: 'retry-same-worker',
    seat: 'build',
  };
  const reset: EngineEvent = { ...at, type: 'task_reset', taskId: taskId('T002') };
  const resolved: EngineEvent = {
    ...recovery,
    type: 'recovery_resolved',
    action: 'retry-same-worker',
    seat: 'build',
    outcome: 'retry-current-task',
    implementerProfile: 'default',
  };

  function transcript(items: EngineEvent[]): { lines: string[]; rows: ConversationRow[] } {
    const { rows } = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 100,
      viewportHeight: 30,
      streaming,
    });
    return { lines: rows.map((row) => rowText(row).trim()).filter((line) => line !== ''), rows };
  }

  it('gives the halt its error and folds selection, reset and outcome into one Recovery row', () => {
    const { lines } = transcript([halt, prompted, selected, reset, resolved]);

    expect(lines).toEqual([
      'Error',
      'Your checkout changed under T002 — branch cli-budget-behaviour-fixes',
      `Recovery  Try again${arrowSep()}T002 back to pending, retried`,
    ]);
  });

  it('folds a checkout halt whose headline carries its changes under the error that names them', () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T002' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } }).implementer,
      toolMessage: 'branch fix/implementer-never-runs-gates',
      attempts: 0,
      maxAttempts: 2,
      createdAt: '2026-10-07T05:54:04.413Z',
    });
    const { lines } = transcript([
      { ...halt, message: issue.message },
      { ...prompted, headline: formatRecoveryHeadline(issue) },
      selected,
      reset,
      resolved,
    ]);

    expect(lines).toEqual([
      'Error',
      'Repository changed under T002 · branch fix/implementer-never-runs-gates',
      `Recovery  Try again${arrowSep()}T002 back to pending, retried`,
    ]);
  });

  it('shows a recovery still being applied as its action alone', () => {
    const { lines } = transcript([halt, prompted, selected]);

    expect(lines.at(-1)).toBe('Recovery  Try again');
  });

  it('keeps the prompted card as one quiet row when no error before it names the halt', () => {
    const { lines, rows } = transcript([prompted]);

    expect(lines).toEqual(['Recovery  Your checkout changed under T002']);
    const [row] = rows.filter((candidate) => rowText(candidate).trim() !== '');
    expect(row?.kind).toBe('card');
    expect(row?.segments[0]?.tone).toBe('textDim');
  });

  it('folds a halt no error row names, and what was done about it, into one row', () => {
    const { lines } = transcript([prompted, prompted, selected, reset, resolved]);

    expect(lines).toEqual([
      `Recovery  Your checkout changed under T002${SOFT_SEP}Try again${arrowSep()}T002 back to pending, retried`,
    ]);
  });

  it('keeps a blocked action as its own error row', () => {
    const failed: EngineEvent = {
      ...recovery,
      type: 'recovery_action_failed',
      action: 'retry-same-worker',
      seat: 'build',
      message: 'worker unavailable',
    };
    const { lines, rows } = transcript([selected, failed]);

    expect(lines).toEqual([
      'Recovery  Try again',
      'Recovery  Try again blocked: worker unavailable',
    ]);
    const blocked = rows.find((row) => rowText(row).includes('blocked'));
    expect(blocked?.segments[0]?.tone).toBe('error');
  });

  it('heads a brief restarted by its recovery once', () => {
    const start: EngineEvent = {
      ...at,
      type: 'task_started',
      taskId: taskId('T002'),
      title: 'Wire the login route',
      index: 1,
      total: 3,
      file: 'src/login.ts',
      action: 'modify',
    };
    const { lines } = transcript([start, halt, prompted, selected, reset, resolved, start]);

    expect(lines.filter((line) => line.includes('Wire the login route'))).toHaveLength(1);
    expect(lines.at(-1)).toBe(`Recovery  Try again${arrowSep()}T002 back to pending, retried`);
  });

  it('heads a brief again when its recovery restarted it on another tool', () => {
    const start: EngineEvent = {
      ...at,
      type: 'task_started',
      taskId: taskId('T002'),
      title: 'Wire the login route',
      index: 1,
      total: 3,
      file: 'src/login.ts',
      action: 'modify',
      tool: 'opencode',
    };
    const { lines } = transcript([
      start,
      halt,
      prompted,
      selected,
      reset,
      resolved,
      { ...start, tool: 'codex' },
    ]);

    expect(lines.filter((line) => line.includes('Wire the login route'))).toHaveLength(2);
  });

  it.each([
    ['continued', 'continued', 'success'],
    ['retry-current-task', 'retried', 'success'],
    ['skipped-current-task', 'skipped', 'textDim'],
    ['aborted', 'run ended', 'error'],
  ] as const)('tones an outcome %s as %s', (outcome, outcomeWords, tone) => {
    const { lines, rows } = transcript([
      { ...recovery, type: 'recovery_resolved', action: 'retry-same-worker', outcome },
    ]);

    expect(lines).toEqual([`Recovery  Try again${arrowSep()}${outcomeWords}`]);
    expect(rows[0]?.segments[0]?.tone).toBe(tone);
  });

  it('does not call a brief the planner stopped early one that failed', () => {
    const { lines } = transcript([
      { ...selected, reason: 'retry-exhausted', phase: 'escalating' } as EngineEvent,
    ]);

    expect(lines).toEqual(['Recovery  Try again']);
    expect(lines.join('\n')).not.toMatch(/exhausted/i);
  });

  describe('a seat swap names the seat the halt stopped', () => {
    function swapLines(seat: 'plan' | 'build' | 'review' | undefined): string[] {
      const base = {
        ...at,
        phase: 'planning',
        issueId: 'issue-1',
        reason: 'runner-usage-limit',
        action: 'switch-seat',
        ...(seat !== undefined && { seat }),
      } as const;
      return transcript([
        { type: 'recovery_action_selected', ...base },
        { type: 'recovery_action_failed', ...base, message: 'codex is not ready' },
        { type: 'recovery_resolved', ...base, outcome: 'continued' },
      ]).lines;
    }

    it.each([
      ['plan', 'Change PLAN tool'],
      ['build', 'Change BUILD tool'],
      ['review', 'Change REVIEW tool'],
    ] as const)('on the %s seat', (seat, label) => {
      expect(swapLines(seat)).toEqual([
        `Recovery  ${label}`,
        `Recovery  ${label} blocked: codex is not ready`,
        `Recovery  ${label}${arrowSep()}continued`,
      ]);
    });

    it('names no seat on an event recorded before the seat was', () => {
      expect(swapLines(undefined)).toEqual([
        'Recovery  Change tool',
        'Recovery  Change tool blocked: codex is not ready',
        `Recovery  Change tool${arrowSep()}continued`,
      ]);
    });
  });

  it('names a reset outside a recovery in one row', () => {
    const { lines } = transcript([reset]);

    expect(lines).toEqual(['Task reset  T002 back to pending']);
  });
});
