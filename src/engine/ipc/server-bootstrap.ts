import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { featureForTranscriptPolicy } from '../../core/sessions/session-id.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { writeLockfile } from './lockfile.js';
import { readIpcServerArgsFileConfined, type IpcServerArgs } from './server-args.js';

function exitInvalidArgs(message: string): never {
  process.stderr.write(`server-entry: ${message}\n`);
  process.exit(1);
}

function readConfinedArgsFileOrExit(argsFile: string): IpcServerArgs {
  try {
    return readIpcServerArgsFileConfined({ argsFile });
  } catch (err) {
    exitInvalidArgs(toErrorMessage(err));
  }
}

export function getArgv(processArgv: string[]): { args: IpcServerArgs; bootstrapDir: string } {
  const argsFile = processArgv[2];
  if (!argsFile) {
    exitInvalidArgs('missing required argv');
  }
  const args = readConfinedArgsFileOrExit(argsFile);
  try {
    unlinkSync(argsFile);
  } catch {
    exitInvalidArgs('could not consume detached bootstrap request');
  }
  return { args, bootstrapDir: dirname(argsFile) };
}

export async function writeStartupLockfile(
  dir: string,
  input: Readonly<{
    argv: IpcServerArgs;
    mode: Parameters<typeof writeLockfile>[1]['mode'];
    persistTranscript: boolean;
  }>,
): Promise<{ authToken: string; startedAt: number }> {
  const now = Date.now();
  const authToken = randomBytes(32).toString('hex');
  await writeLockfile(dir, {
    pid: process.pid,
    startTimeMs: now,
    lastAliveMs: now,
    sessionId: input.argv.candidate.sessionId,
    mode: input.mode,
    // `splitbrief ps` prints this field, so it is a consumer surface: redact it under
    // persistTranscript:false. The raw feature still reaches the planner via argv.feature.
    feature: featureForTranscriptPolicy(input.argv.feature, input.persistTranscript),
    authToken,
  });
  return { authToken, startedAt: now };
}
