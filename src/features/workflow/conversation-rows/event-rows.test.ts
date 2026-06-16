import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { eventRows } from './event-rows.js';
import { rowText } from './row-format.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

describe('eventRows', () => {
  it.each([
    'researching',
    'specifying',
    'escalating',
  ] as const)('does not promise resume for %s cancellation events', (phase) => {
    const event: EngineEvent = {
      type: 'workflow_cancelled',
      ts: 0,
      phase,
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('Workflow cancelled');
    expect(text).not.toContain('Resume');
    expect(text).not.toContain('diptych continue');
  });
});
