import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { PlanningPhaseResult } from '../../../src/engine/orchestrator/planning/types.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { BRIEF_QUALITY_FILE, sessionDir } from '../../../src/core/paths.js';

export function expectBriefQualityBlocked(input: {
  result: PlanningPhaseResult;
  ref: SessionRef;
  events: EngineEvent[];
}) {
  const { result, ref, events } = input;
  expect(result.disposition).toBe('terminal');
  expect(result.state.phase).not.toBe('implementing');
  const reportPath = join(sessionDir(ref.projectDir, ref.sessionId), BRIEF_QUALITY_FILE);
  expect(existsSync(reportPath)).toBe(true);
  const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
  expect(persisted.passed).toBe(false);
  expect(events.find((e) => e.type === 'brief_quality_failed')).toBeDefined();
}
