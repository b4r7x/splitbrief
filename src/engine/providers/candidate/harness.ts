import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isRecord } from '../../../utils/type-guards.js';
import { error as createError } from '../../../utils/error.js';
import { CandidateEvidence, sanitizeCandidateOutput } from './evidence.js';

type ConformanceErrorCode = 'credentialed-omit' | 'harness-failure';

function conformanceError(code: ConformanceErrorCode, message: string): Error {
  return createError(code, message);
}

export function hasConformanceCode(value: unknown, code: ConformanceErrorCode): boolean {
  return isRecord(value) && value.kind === code;
}

export function throwConformance(code: ConformanceErrorCode, message: string): never {
  throw conformanceError(code, message);
}

export function redactCredentialOutput(value: string, credentials: readonly string[]): string {
  let redacted = value;
  for (const credential of credentials) {
    if (credential.length > 0) redacted = redacted.replaceAll(credential, '[REDACTED]');
  }
  return sanitizeCandidateOutput(redacted);
}

export async function writeEvidenceFile(recordPath: string, content: string): Promise<void> {
  const path = resolve(recordPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${content}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readRawCaptureRecord(
  recordPath: string,
  options: Readonly<{ label: string; standalone: boolean }>,
): Promise<CandidateEvidence['rawCapture']> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(recordPath), 'utf8'));
  } catch {
    throwConformance(
      'harness-failure',
      `${options.label} evidence record is missing or invalid JSON`,
    );
  }
  if (
    !isRecord(parsed) ||
    !('rawCapture' in parsed) ||
    (options.standalone && Object.keys(parsed).length !== 1)
  ) {
    throwConformance(
      'harness-failure',
      `${options.label} evidence record has no ${options.standalone ? 'standalone ' : ''}rawCapture`,
    );
  }
  const evidence = CandidateEvidence.safeParse({
    rawCapture: parsed.rawCapture,
    productionConformance: null,
    verdict: 'OMIT',
  });
  if (!evidence.success)
    throwConformance('harness-failure', `${options.label} rawCapture is invalid`);
  return evidence.data.rawCapture;
}
