import { existsSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { configureLogger, createLogger, resetLoggerForTests } from './logger.js';

describe('logger', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir('logger-test');
  });

  afterEach(() => {
    resetLoggerForTests();
    cleanupTempDir(tmp);
  });

  it('writes nothing before configuration and when disabled', () => {
    const log = createLogger('test');
    log.info('before configuration');

    configureLogger({ projectDir: tmp, relativePath: join('logs', 'debug.log'), enabled: false });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');

    expect(existsSync(join(tmp, 'logs'))).toBe(false);
  });

  it('appends single-line entries with timestamp, level, pid, scope and JSON data', () => {
    const logPath = join(tmp, 'logs', 'debug.log');
    configureLogger({ projectDir: tmp, relativePath: join('logs', 'debug.log'), enabled: true });
    const log = createLogger('bootstrap');

    log.info('stores loaded', { projectDir: '/tmp/p' });
    log.error('boom');

    const lines = readFileSync(logPath, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(
        `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z INFO ${process.pid} \\[bootstrap\\] stores loaded \\{"projectDir":"/tmp/p"\\}$`,
      ),
    );
    expect(lines[1]).toMatch(new RegExp(`ERROR ${process.pid} \\[bootstrap\\] boom$`));
    expect(statSync(join(tmp, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('redacts secrets in message and data before writing', () => {
    const logPath = join(tmp, 'debug.log');
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: true });
    const log = createLogger('engine');

    log.info('using key sk-ant-abcdefghij0123456789xyz');
    log.error('call failed', { API_KEY: 'super-secret-value-123' });

    const content = readFileSync(logPath, 'utf-8');
    expect(content).not.toContain('abcdefghij0123456789xyz');
    expect(content).not.toContain('super-secret-value-123');
    expect(content).toContain('***REDACTED***');
  });

  it('flattens multi-line messages into one line per entry', () => {
    const logPath = join(tmp, 'debug.log');
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: true });

    createLogger('cli').error('fatal\nstack line 1\nstack line 2');

    const lines = readFileSync(logPath, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fatal\\nstack line 1\\nstack line 2');
  });

  it('stops appending when debug.log is swapped for a symlink after the first write', () => {
    const outside = createTempDir('logger-outside');
    const logPath = join(tmp, 'debug.log');
    configureLogger({ projectDir: tmp, relativePath: 'debug.log', enabled: true });
    const log = createLogger('cli');

    log.info('first');
    rmSync(logPath);
    symlinkSync(join(outside, 'target.log'), logPath);
    log.info('second');

    expect(existsSync(join(outside, 'target.log'))).toBe(false);
    cleanupTempDir(outside);
  });

  it('refuses to write through a symlinked logs directory', () => {
    const outside = createTempDir('logger-outside');
    symlinkSync(outside, join(tmp, 'logs'));
    configureLogger({ projectDir: tmp, relativePath: join('logs', 'debug.log'), enabled: true });

    createLogger('cli').info('redirected');

    expect(existsSync(join(outside, 'debug.log'))).toBe(false);
    cleanupTempDir(outside);
  });
});
