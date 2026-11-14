import { realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  CliExecutableReceipt,
  CliExecutableIdentity,
} from '../../../core/discovery/detection/executable.js';
import { error, matches } from '../../../utils/error.js';
import { customExecutableNames, canonicalProjectDir } from './custom.js';
import {
  executableIdentity,
  isWithin,
  diagnosticCommand,
  assertTrustedIdentity,
  executableChangedMessage,
  executableToolName,
  diagnosticIdentity,
} from './identity.js';
import type {
  CliExecutableTrust,
  ResolveCliExecutableAliasesOptions,
  ResolvedCliExecutable,
} from './types.js';

async function firstExecutable(
  directory: string,
  command: string,
): Promise<CliExecutableReceipt | null> {
  for (const name of customExecutableNames(command, process.env.PATHEXT)) {
    const identity = await executableIdentity(join(directory, name));
    if (identity) return identity;
  }
  return null;
}

export async function sanitizedRuntimePath(projectDir: string): Promise<string> {
  const projectPath = resolve(projectDir);
  const realProjectPath = await canonicalProjectDir(projectDir);
  const directories: string[] = [];
  const seen = new Set<string>();

  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry) || isWithin(resolve(entry), projectPath)) continue;
    try {
      const path = await realpath(entry);
      const info = await stat(path);
      if (!info.isDirectory() || isWithin(path, realProjectPath) || seen.has(path)) continue;
      seen.add(path);
      directories.push(path);
    } catch {
      // An unreadable or missing PATH entry is not a usable runtime directory.
    }
  }

  const nodeDirectory = await realpath(dirname(process.execPath));
  if (!isWithin(nodeDirectory, realProjectPath) && !seen.has(nodeDirectory)) {
    directories.push(nodeDirectory);
  }
  return directories.join(delimiter);
}

export async function resolveCliExecutable(
  options: Readonly<{ command: string; projectDir: string; trust?: CliExecutableTrust }>,
): Promise<CliExecutableIdentity> {
  const { command, projectDir, trust } = options;
  if (command.length === 0 || command.trim() !== command) {
    throw error('cli-executable-unavailable', 'CLI executable command must be non-empty.', {
      command: diagnosticCommand(command),
    });
  }

  const projectPath = resolve(projectDir);
  const realProjectPath = await canonicalProjectDir(projectDir);
  const pathLike = isAbsolute(command) || command.includes('/') || command.includes('\\');

  if (pathLike) {
    const candidate = isAbsolute(command) ? command : resolve(projectDir, command);
    const identity = await executableIdentity(candidate);
    if (!identity) {
      throw error(
        'cli-executable-unavailable',
        `CLI executable not found: ${diagnosticCommand(command)}`,
        { command: diagnosticCommand(command) },
      );
    }
    const requiresExactTrust =
      !isAbsolute(command) ||
      isWithin(resolve(candidate), projectPath) ||
      isWithin(identity.path, realProjectPath);
    assertTrustedIdentity({ command, identity, trust, requiresExactTrust });
    return identity;
  }

  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const unsafeEntry = entry.length === 0 || !isAbsolute(entry);
    const directory = unsafeEntry ? resolve(projectDir, entry || '.') : resolve(entry);
    const identity = await firstExecutable(directory, command);
    if (!identity) continue;

    const requiresExactTrust =
      unsafeEntry || isWithin(directory, projectPath) || isWithin(identity.path, realProjectPath);
    assertTrustedIdentity({ command, identity, trust, requiresExactTrust });
    return identity;
  }

  if (trust !== null && trust !== undefined) {
    throw error(
      'cli-executable-identity-drift',
      executableChangedMessage(executableToolName(command)),
      {
        command: diagnosticCommand(command),
        expectedIdentity: diagnosticIdentity(trust),
      },
    );
  }

  throw error(
    'cli-executable-unavailable',
    `CLI executable not found on trusted PATH: ${diagnosticCommand(command)}`,
    {
      command: diagnosticCommand(command),
    },
  );
}

/**
 * Resolves an ordered command family without treating a broken primary as a
 * reason to run a differently named executable.  A fallback is eligible only
 * when its predecessor is absent; an untrusted, drifted, or otherwise failed
 * primary is deliberately terminal.
 *
 * Trusted calls first establish whether each candidate exists without the
 * receipt. `resolveCliExecutable` reports a missing trusted primary as
 * identity drift, which is correct for a single command but would otherwise
 * hide an admitted legacy alias that is actually present.
 */
export async function resolveCliExecutableAliases(
  options: ResolveCliExecutableAliasesOptions,
): Promise<ResolvedCliExecutable> {
  const commands = options.commands;
  const primary = commands[0];
  if (primary === undefined) {
    throw error('cli-executable-unavailable', 'CLI executable command list must be non-empty.');
  }

  const resolveExecutable = options.resolveExecutable ?? resolveCliExecutable;
  const hasTrust = options.trust !== undefined && options.trust !== null;
  let lastUnavailable: unknown;

  for (const [index, command] of commands.entries()) {
    if (hasTrust) {
      try {
        await resolveExecutable({ command, projectDir: options.projectDir });
      } catch (cause) {
        if (matches('cli-executable-unavailable')(cause)) {
          lastUnavailable = cause;
          continue;
        }
        throw cause;
      }
    }

    try {
      const executable = await resolveExecutable({
        command,
        projectDir: options.projectDir,
        trust: options.trust,
      });
      return { command, executable, usedFallback: index > 0 };
    } catch (cause) {
      // With no receipt, this is the one safe condition that admits the next
      // catalog alias. Any other resolver failure proves the primary is not a
      // cleanly absent candidate and must not silently change binaries.
      if (!hasTrust && matches('cli-executable-unavailable')(cause)) {
        lastUnavailable = cause;
        continue;
      }
      throw cause;
    }
  }

  // All candidates were cleanly absent. Preserve the resolver's redacted
  // unavailable diagnostic rather than misreporting an identity mismatch.
  if (lastUnavailable !== undefined) throw lastUnavailable;
  throw error(
    'cli-executable-unavailable',
    'CLI executable command resolution unexpectedly returned.',
  );
}
