import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { PlanningPhaseResult } from '../../../src/engine/orchestrator/planning/types.js';
import { BRIEF_QUALITY_FILE, sessionDir } from '../../../src/core/paths.js';

export function expectBriefQualityBlocked(
  result: PlanningPhaseResult,
  projectDir: string,
  sessionId: string,
  events: EngineEvent[],
) {
  expect(result.disposition).toBe('terminal');
  expect(result.state.phase).not.toBe('implementing');
  const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
  expect(existsSync(reportPath)).toBe(true);
  const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
  expect(persisted.passed).toBe(false);
  expect(events.find((e) => e.type === 'brief_quality_failed')).toBeDefined();
}
