import { createSanitizedChildEnv } from '../../../lib/process/spawn/child-env.js';
import { processError } from '../../../lib/process/errors.js';
import type { CliAuthChannelId } from '../../../core/runners/cli-tool-catalog.js';
import { sanitizedRuntimePath } from '../resolve-cli-executable.js';
import { sandboxCredentialValues } from '../sandbox-credential-values.js';

export async function defaultClaudeEnv(
  projectDir: string,
  authChannel: CliAuthChannelId | undefined,
): Promise<NodeJS.ProcessEnv> {
  const preserveKeys = authChannel === 'api-key' ? ['ANTHROPIC_API_KEY'] : [];
  const env = createSanitizedChildEnv(process.env, preserveKeys);
  env.PATH = await sanitizedRuntimePath(projectDir);
  return env;
}

export function claudeCredentialValues(
  authChannel: CliAuthChannelId | undefined,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const apiKey = authChannel === 'api-key' ? env.ANTHROPIC_API_KEY : undefined;
  return [...(apiKey === undefined ? [] : [apiKey]), ...sandboxCredentialValues(env)];
}

function redactClaudeExecutablePath(value: string, executablePath: string): string {
  if (executablePath.length === 0 || !value.includes(executablePath)) return value;
  return value.split(executablePath).join('claude');
}

export function normalizeClaudeProcessOutputError(
  err: unknown,
  executablePath: string | undefined,
  redactCredential?: (value: string) => string,
): unknown {
  if (!processError.isExitCode(err)) return err;

  const knownPaths = [err.data.command, executablePath].filter(
    (path, index, paths): path is string =>
      typeof path === 'string' && path.length > 0 && paths.indexOf(path) === index,
  );
  const redact = (value: string): string =>
    redactCredential?.(
      knownPaths.reduce((current, path) => redactClaudeExecutablePath(current, path), value),
    ) ?? value;
  const stderr = redact(err.data.stderr);
  const output = redact(err.data.output);
  const detailPrefix = ` exited with code ${err.data.code}`;
  const detailStart = err.message.indexOf(detailPrefix);
  const originalDetail =
    detailStart < 0
      ? undefined
      : err.message.slice(detailStart + detailPrefix.length).replace(/^: /, '');

  return processError.exitCode({
    command: 'claude',
    ...(err.data.label !== undefined && { label: redact(err.data.label) }),
    code: err.data.code,
    stderr,
    output,
    ...(originalDetail !== undefined && { detail: redact(originalDetail) }),
  });
}
