import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { READINESS_DIAGNOSTIC_REMEDIATION } from '../../src/core/readiness/format.js';
import {
  READINESS_DIAGNOSTIC_STATE_IDS,
  type ReadinessDiagnosticStateId,
} from '../../src/core/schemas/readiness.js';
import { runnerOutcome } from '../../src/engine/runners/errors.js';

const projectRoot = join(import.meta.dirname, '../..');
const troubleshootingPath = join(projectRoot, 'docs/TROUBLESHOOTING.md');
const troubleshootingDoc = readFileSync(troubleshootingPath, 'utf8');

const READINESS_TABLE_MARKER = '### Readiness `stateId` index';
const RUNNER_TABLE_MARKER = '### Runner `state` outcomes (workflow commands)';

const RUNNER_WORKFLOW_STATES = ['output-budget-breach', 'no-staged-change'] as const;

function sectionBetween(startMarker: string, endMarker: string): string {
  const start = troubleshootingDoc.indexOf(startMarker);
  expect(start, `missing section ${startMarker}`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + startMarker.length;
  const end = troubleshootingDoc.indexOf(endMarker, bodyStart);
  expect(end, `missing end marker after ${startMarker}`).toBeGreaterThan(bodyStart);
  return troubleshootingDoc.slice(bodyStart, end);
}

function parseDiagnosticTable(section: string): Map<string, string> {
  const rows = new Map<string, string>();
  const tableStart = section.indexOf('| Symptom');
  expect(tableStart, 'missing diagnostic table header').toBeGreaterThanOrEqual(0);
  const lines = section.slice(tableStart).split('\n');
  for (const line of lines) {
    if (!line.trim().startsWith('|')) break;
    if (line.includes('Symptom') || line.includes('---')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const stateCell = cells[1] ?? '';
    const remediation = cells[2] ?? '';
    const match = stateCell.match(/`([^`]+)`/);
    if (match?.[1] !== undefined) {
      rows.set(match[1], remediation);
    }
  }
  return rows;
}

describe('TROUBLESHOOTING diagnostic parity', () => {
  it('documents doctor --json automation output', () => {
    expect(troubleshootingDoc).toContain('splitbrief doctor --json');
    expect(troubleshootingDoc).toContain('"type": "readiness_report"');
    expect(troubleshootingDoc).toContain('stateId');
    expect(troubleshootingDoc).toContain('remediation');
    expect(troubleshootingDoc).toContain('CLI-REFERENCE.md');
  });

  it('links canonical support documentation', () => {
    const support = sectionBetween('### Canonical support documentation', '## Setup and install');
    expect(support).toContain('PLANNERS-AND-IMPLEMENTERS.md');
    expect(support).toContain('CONFIGURATION.md');
    expect(support).toContain('API-KEYS.md');
    expect(support).toContain('CLI-REFERENCE.md');
  });

  it.each(
    READINESS_DIAGNOSTIC_STATE_IDS,
  )('maps readiness stateId %s to the runtime remediation string', (stateId: ReadinessDiagnosticStateId) => {
    const table = parseDiagnosticTable(sectionBetween(READINESS_TABLE_MARKER, RUNNER_TABLE_MARKER));
    expect(table.has(stateId), `missing readiness row for ${stateId}`).toBe(true);
    expect(table.get(stateId)).toBe(READINESS_DIAGNOSTIC_REMEDIATION[stateId]);
  });

  it.each(
    RUNNER_WORKFLOW_STATES,
  )('maps runner state %s to the runtime remediation string', (state) => {
    const table = parseDiagnosticTable(
      sectionBetween(RUNNER_TABLE_MARKER, '### Canonical support documentation'),
    );
    expect(table.has(state), `missing runner row for ${state}`).toBe(true);
    expect(table.get(state)).toBe(runnerOutcome.failure(state).remediation);
  });

  it('indexes every required diagnostic family without decoration-dependent matching', () => {
    const readiness = sectionBetween(READINESS_TABLE_MARKER, RUNNER_TABLE_MARKER).toLowerCase();
    const runner = sectionBetween(
      RUNNER_TABLE_MARKER,
      '### Canonical support documentation',
    ).toLowerCase();
    const combined = `${readiness}\n${runner}`;

    const families: Array<{ needle: string; region?: 'readiness' | 'runner' | 'combined' }> = [
      { needle: 'missing-binary', region: 'readiness' },
      { needle: 'not on `path`', region: 'readiness' },
      { needle: 'untrusted-path', region: 'readiness' },
      { needle: 'incompatible-version', region: 'readiness' },
      { needle: 'unauthenticated', region: 'readiness' },
      { needle: 'auth-unknown', region: 'readiness' },
      { needle: 'endpoint-invalid', region: 'readiness' },
      { needle: 'credential-family-mismatch', region: 'readiness' },
      { needle: 'protocol-failure', region: 'readiness' },
      { needle: 'missing terminal', region: 'readiness' },
      { needle: 'quota-rate-limit', region: 'readiness' },
      { needle: '429', region: 'readiness' },
      { needle: 'conflicting-args', region: 'readiness' },
      { needle: 'output-budget-breach', region: 'runner' },
      { needle: 'no-staged-change', region: 'runner' },
    ];

    for (const { needle, region = 'combined' } of families) {
      const haystack = region === 'readiness' ? readiness : region === 'runner' ? runner : combined;
      expect(haystack.includes(needle), `missing symptom family "${needle}"`).toBe(true);
    }

    expect(readiness).not.toMatch(/^config:/m);
    expect(runner).not.toMatch(/^repository:/m);
  });
});
