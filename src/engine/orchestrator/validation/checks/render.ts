import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { rendersDir } from '../../../../core/paths.js';
import type { Check } from '../../../../core/schemas/task.js';
import {
  type ProcessOutputCapture,
  processError,
  processOutputCapture,
  captureText,
} from '../../../../lib/process/errors.js';
import { parseShellCommand } from '../../../../utils/parse-shell-command.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { RENDER_ID_PATTERN } from '../../../spec/plan/render-checks.js';
import { failureKeys } from '../extract-failure-keys.js';
import { notRunnableReason, boundedOutputTail } from '../stage.js';
import type { ValidationCommandRunner } from '../types.js';
import type { RunChecksOptions, CheckRunResult, CheckRunArtifact } from './types.js';

export async function runRenderCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
): Promise<CheckRunResult> {
  const template = opts.config.validation.render;
  if (template === undefined) {
    return { checkId: check.id, status: 'not-runnable', output: 'validation.render is not set' };
  }
  if (!RENDER_ID_PATTERN.test(check.value)) {
    return {
      checkId: check.id,
      status: 'refused',
      output: `render id "${check.value}" must match ^[a-z0-9-]+$`,
    };
  }
  const [cmd, ...templateArgs] = parseShellCommand(template);
  if (cmd === undefined) {
    return { checkId: check.id, status: 'refused', output: 'names no program' };
  }
  const executionId = randomUUID();
  const outDir = join(opts.projectDir, '.test-artifacts', 'ui', `render-${executionId}`);
  await mkdir(outDir, { recursive: true });
  const args = templateArgs.map((arg) => {
    if (arg === '{id}') return check.value;
    if (arg === '{out}') return outDir;
    return arg;
  });
  const command = [cmd, ...args].join(' ');
  let exitCode: number;
  let capture: ProcessOutputCapture;
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd: opts.projectDir,
      timeout: opts.config.validation.timeoutMs,
      label: `check ${check.id}`,
      signal: opts.signal,
    });
    exitCode = 0;
    capture = { stdout, stderr, complete: true };
  } catch (err: unknown) {
    const notRunnable = notRunnableReason(err, cmd);
    if (notRunnable !== undefined) {
      return {
        checkId: check.id,
        status: 'not-runnable',
        output: notRunnable,
        command,
        missingProgram: true,
      };
    }
    if (processError.isExitCode(err)) {
      exitCode = err.data.code ?? 1;
      capture = processOutputCapture(err.data);
    } else if (processError.isTimeout(err)) {
      return {
        checkId: check.id,
        status: 'fail',
        output: boundedOutputTail(err.message),
        failure: failureKeys(
          { capture: { stdout: '', stderr: '', complete: true }, timedOut: true },
          opts.projectDir,
        ),
        command,
      };
    } else {
      throw err;
    }
  }
  const destDir =
    opts.checkoutDir !== undefined && opts.sessionId !== undefined
      ? join(
          rendersDir({ projectDir: opts.checkoutDir, sessionId: opts.sessionId }, check.id),
          executionId,
        )
      : undefined;
  const artifacts: CheckRunArtifact[] = [];
  if (destDir !== undefined) {
    await mkdir(destDir, { recursive: true });
    const entries = await readdir(outDir, { recursive: true });
    const pngs = entries.filter((name) => name.toLowerCase().endsWith('.png')).sort();
    for (const rel of pngs) {
      const dest = join(destDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(outDir, rel), dest);
      artifacts.push({ path: dest, sha256: sha256Hex(await readFile(dest)) });
    }
  }
  return {
    checkId: check.id,
    ...(exitCode === 0
      ? { status: 'pass' as const }
      : {
          status: 'fail' as const,
          failure: failureKeys({ capture, exitCode }, opts.projectDir),
        }),
    output: boundedOutputTail(captureText(capture)),
    command,
    exitCode,
    artifacts,
  };
}
