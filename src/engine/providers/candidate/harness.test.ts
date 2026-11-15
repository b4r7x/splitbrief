import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_EVIDENCE_OUTPUT_BYTES } from './evidence.js';
import {
  hasConformanceCode,
  readRawCaptureRecord,
  redactCredentialOutput,
  throwConformance,
  writeEvidenceFile,
} from './harness.js';

const rawCapture = {
  candidateId: 'example-provider',
  role: 'implementer' as const,
  contractSha256: 'a'.repeat(64),
  stdout: 'models status=200',
  stderr: '',
};

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'splitbrief-candidate-harness-'));
  directories.push(directory);
  return directory;
}

async function permissions(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function recordFile(value: unknown): Promise<string> {
  const path = join(await temporaryDirectory(), 'evidence.json');
  await writeFile(path, JSON.stringify(value), 'utf8');
  return path;
}

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

describe('writeEvidenceFile', () => {
  it('makes a missing record directory owner-only and writes the record owner-only', async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, 'records', 'evidence.json');

    await writeEvidenceFile(recordPath, '{"rawCapture":{}}');

    expect(await readFile(recordPath, 'utf8')).toBe('{"rawCapture":{}}\n');
    expect(await permissions(join(directory, 'records'))).toBe(0o700);
    expect(await permissions(recordPath)).toBe(0o600);
  });

  it('narrows an existing record that others can read to owner-only', async () => {
    const recordPath = join(await temporaryDirectory(), 'evidence.json');
    await writeFile(recordPath, 'old record\n', { encoding: 'utf8', mode: 0o644 });
    await chmod(recordPath, 0o644);

    await writeEvidenceFile(recordPath, 'new record');

    expect(await readFile(recordPath, 'utf8')).toBe('new record\n');
    expect(await permissions(recordPath)).toBe(0o600);
  });
});

describe('readRawCaptureRecord', () => {
  it('refuses a record with keys beside rawCapture only in standalone mode', async () => {
    const recordPath = await recordFile({
      rawCapture,
      productionConformance: null,
      verdict: 'OMIT',
    });

    await expect(
      readRawCaptureRecord(recordPath, { label: 'CLI', standalone: true }),
    ).rejects.toMatchObject({
      kind: 'harness-failure',
      message: 'CLI evidence record has no standalone rawCapture',
    });
    await expect(
      readRawCaptureRecord(recordPath, { label: 'provider', standalone: false }),
    ).resolves.toEqual(rawCapture);
  });

  it('reads the rawCapture of a standalone record', async () => {
    const recordPath = await recordFile({ rawCapture });

    await expect(
      readRawCaptureRecord(recordPath, { label: 'CLI', standalone: true }),
    ).resolves.toEqual(rawCapture);
  });

  it('names the label in each refusal of a record', async () => {
    const directory = await temporaryDirectory();
    const options = { label: 'provider', standalone: false };

    await expect(
      readRawCaptureRecord(join(directory, 'absent.json'), options),
    ).rejects.toMatchObject({
      kind: 'harness-failure',
      message: 'provider evidence record is missing or invalid JSON',
    });
    await expect(readRawCaptureRecord(await recordFile({}), options)).rejects.toMatchObject({
      kind: 'harness-failure',
      message: 'provider evidence record has no rawCapture',
    });
    await expect(
      readRawCaptureRecord(await recordFile({}), { label: 'CLI', standalone: true }),
    ).rejects.toMatchObject({
      kind: 'harness-failure',
      message: 'CLI evidence record has no standalone rawCapture',
    });
    await expect(
      readRawCaptureRecord(await recordFile({ rawCapture: { candidateId: 'example-provider' } }), {
        ...options,
        label: 'CLI',
      }),
    ).rejects.toMatchObject({ kind: 'harness-failure', message: 'CLI rawCapture is invalid' });
  });
});

describe('conformance errors', () => {
  it('throws an error that carries its conformance code', () => {
    let caught: unknown;
    try {
      throwConformance('credentialed-omit', 'missing credential for EXAMPLE_API_KEY');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ message: 'missing credential for EXAMPLE_API_KEY' });
    expect(hasConformanceCode(caught, 'credentialed-omit')).toBe(true);
    expect(hasConformanceCode(caught, 'harness-failure')).toBe(false);
    expect(hasConformanceCode(new Error('plain'), 'credentialed-omit')).toBe(false);
  });
});

describe('redactCredentialOutput', () => {
  it('redacts each credential, skips an empty one and keeps the evidence budget', () => {
    expect(redactCredentialOutput('sent ex-canary-1 and ex-canary-1', ['ex-canary-1', ''])).toBe(
      'sent [REDACTED] and [REDACTED]',
    );
    const bounded = redactCredentialOutput('x'.repeat(MAX_EVIDENCE_OUTPUT_BYTES + 100), []);
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(MAX_EVIDENCE_OUTPUT_BYTES);
  });
});
