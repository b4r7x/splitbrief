import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';
import { configureLogger, resetLoggerForTests } from '../../../lib/logger.js';
import { createLoggerSink } from './logger.js';

describe('createLoggerSink', () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = createTempDir('logger-sink-test');
    logPath = join(tmp, 'debug.log');
  });

  afterEach(() => {
    resetLoggerForTests();
    cleanupTempDir(tmp);
  });

  it('mirrors engine events to the log with levels per event type', () => {
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: true });
    const sink = createLoggerSink({ persistTranscript: true });

    sink({ type: 'workflow_started', ts: 100, phase: 'idle', feature: 'x' });
    sink({ type: 'warning', ts: 110, phase: 'planning', message: 'slow provider' });
    sink({ type: 'error', ts: 120, phase: 'planning', message: 'planner exploded' });

    const lines = readFileSync(logPath, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('DEBUG');
    expect(lines[0]).toContain('[engine] workflow_started');
    expect(lines[1]).toContain('WARN');
    expect(lines[1]).toContain('slow provider');
    expect(lines[2]).toContain('ERROR');
    expect(lines[2]).toContain('planner exploded');
  });

  it('redacts secrets carried in event payloads', () => {
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: true });
    const sink = createLoggerSink({ persistTranscript: true });

    sink({
      type: 'error',
      ts: 130,
      phase: 'implementing',
      message: 'auth failed for sk-ant-abcdefghij0123456789xyz',
    });

    const content = readFileSync(logPath, 'utf-8');
    expect(content).not.toContain('abcdefghij0123456789xyz');
    expect(content).toContain('***REDACTED***');
  });

  it('omits oversized event payloads before the diagnostic sink writes', () => {
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: true });
    const sink = createLoggerSink({ persistTranscript: true });
    const oversizedExcerpt = `oversized-payload-canary-${'x'.repeat(70_000)}`;

    sink({
      type: 'artifact_written',
      ts: 150,
      phase: 'planning',
      filename: 'tasks.md',
      path: 'tasks.md',
      lineCount: 8,
      excerpt: Array.from({ length: 8 }, () => oversizedExcerpt),
      omittedCount: 0,
      omittedUnit: 'line',
    });

    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('payload_omitted');
    expect(content).toContain('oversized');
    expect(content).not.toContain(oversizedExcerpt);
    expect(content.length).toBeLessThan(2_000);
  });

  it('strips terminal controls before the diagnostic sink writes', () => {
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: true });
    const sink = createLoggerSink({ persistTranscript: true });

    sink({
      type: 'error',
      ts: 160,
      phase: 'planning',
      message: '\u001b[31mterminal secret\u001b[0m',
    });

    const content = readFileSync(logPath, 'utf-8');
    expect(content).not.toContain('\u001b');
    expect(content).toContain('terminal secret');
  });

  it('drops and strips transcript content when persistTranscript is false', () => {
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: true });
    const sink = createLoggerSink({ persistTranscript: false });

    sink({ type: 'planner_text', ts: 200, phase: 'planning', text: 'secret transcript' });
    sink({ type: 'workflow_started', ts: 210, phase: 'idle', feature: 'secret feature prompt' });
    sink({ type: 'error', ts: 220, phase: 'planning', message: 'secret error detail' });

    const lines = readFileSync(logPath, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('workflow_started');
    expect(lines[0]).not.toContain('secret feature prompt');
    expect(lines[0]).toContain(TRANSCRIPT_OMITTED_MESSAGE);
    expect(lines[1]).toContain('ERROR');
    expect(lines[1]).not.toContain('secret error detail');
    expect(lines[1]).toContain(TRANSCRIPT_OMITTED_MESSAGE);
  });

  it('writes nothing when the logger is disabled', () => {
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: false });
    const sink = createLoggerSink({ persistTranscript: true });

    sink({ type: 'error', ts: 140, phase: 'planning', message: 'boom' });

    expect(existsSync(logPath)).toBe(false);
  });
});
