import { describe, expect, it } from 'vitest';
import { processError } from '../../../lib/process/errors.js';
import { boundedOutputTail, runValidationStep } from './stage.js';
import type { ValidationCommandRunner } from './types.js';

const ESC = '\u001b';
const colored = `password: ${ESC}[32m'CANARYa CANARYb'${ESC}[39m`;

function passingRun(stdout: string): ValidationCommandRunner {
  return async () => ({ stdout, stderr: '', code: 0 });
}

describe('output of a passing check', () => {
  it('masks a colored value', () => {
    const tail = boundedOutputTail(`config ${colored}\n`);
    expect(tail).not.toContain('CANARY');
    expect(tail).not.toContain(ESC);
  });

  it('masks a value the character limit cuts', () => {
    const tail = boundedOutputTail(`password: 'CANARYa ${'x '.repeat(3000)}CANARYb'\n`);
    expect(tail).not.toContain('CANARY');
  });

  it('masks a private key the character limit cuts', () => {
    const body = Array.from({ length: 200 }, () => `CANARY${'k'.repeat(58)}`).join('\n');
    const tail = boundedOutputTail(
      `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    );
    expect(tail).not.toContain('CANARY');
  });

  it('masks a value the line limit of a test run cuts', async () => {
    const lines = Array.from({ length: 80 }, () => `CANARY${'k'.repeat(58)}`).join('\n');
    const step = await runValidationStep({
      cmd: 'test',
      args: [],
      cwd: '/repo',
      timeout: 1000,
      command: 'test',
      runCommand: passingRun(`-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`),
    });
    expect(step.passed).toBe(true);
    expect(step.output).not.toContain('CANARY');
  });

  it('keeps the last lines of a test run', async () => {
    const body = Array.from({ length: 80 }, (_, line) => `line ${line}`).join('\n');
    const step = await runValidationStep({
      cmd: 'test',
      args: [],
      cwd: '/repo',
      timeout: 1000,
      command: 'test',
      runCommand: passingRun(body),
    });
    expect(step.output).toBe(
      Array.from({ length: 40 }, (_, line) => `line ${line + 40}`).join('\n'),
    );
  });

  it('keeps the last lines of a failed test run', async () => {
    const output = Array.from({ length: 80 }, (_, line) => `line ${line}`).join('\n');
    const step = await runValidationStep({
      cmd: 'test',
      args: [],
      cwd: '/repo',
      timeout: 1000,
      command: 'test',
      runCommand: async () => {
        throw processError.exitCode({ command: 'test', code: 1, stderr: '', output });
      },
    });
    expect(step.output).toBe(
      Array.from({ length: 40 }, (_, line) => `line ${line + 40}`).join('\n'),
    );
  });
});
