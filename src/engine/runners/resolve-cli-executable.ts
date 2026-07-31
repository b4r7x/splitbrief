import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import { error } from '../../utils/error.js';

export type CliExecutableTrust = CliExecutableIdentity | null | undefined;

type DiagnosticIdentity = Readonly<{
  fingerprint: CliExecutableIdentity['fingerprint'];
}>;

/**
 * Keep executable diagnostics useful without putting a machine-local path in
 * an error message or serialized error payload. Internal identity checks keep
 * using the full path and fingerprint; this label is only for display/data.
 */
function diagnosticCommand(command: string): string {
  const normalized = command.trim().replaceAll('\\', '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const safe = [...basename]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? '?' : character;
    })
    .join('');
  return safe.length > 0 ? safe : '<executable>';
}

function diagnosticIdentity(identity: CliExecutableIdentity): DiagnosticIdentity {
  return { fingerprint: { ...identity.fingerprint } };
}

function isWithin(path: string, parent: string): boolean {
  const pathFromParent = relative(parent, path);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function fingerprintsEqual(
  left: CliExecutableIdentity['fingerprint'],
  right: CliExecutableIdentity['fingerprint'],
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

async function executableIdentity(candidate: string): Promise<CliExecutableIdentity | null> {
  try {
    await access(candidate, constants.X_OK);
    const path = await realpath(candidate);
    const info = await stat(path);
    if (!info.isFile()) return null;
    return {
      path,
      fingerprint: {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
      },
    };
  } catch {
    return null;
  }
}

function exactTrustMatches(identity: CliExecutableIdentity, trust: CliExecutableTrust): boolean {
  return (
    trust !== null &&
    trust !== undefined &&
    trust.path === identity.path &&
    fingerprintsEqual(trust.fingerprint, identity.fingerprint)
  );
}

function assertTrustedIdentity(
  command: string,
  identity: CliExecutableIdentity,
  trust: CliExecutableTrust,
  requiresExactTrust: boolean,
): void {
  if (trust !== null && trust !== undefined) {
    if (
      trust.path !== identity.path ||
      !fingerprintsEqual(trust.fingerprint, identity.fingerprint)
    ) {
      throw error(
        'cli-executable-identity-drift',
        `Executable identity changed for ${diagnosticCommand(command)}; run readiness checks again before execution.`,
        {
          command: diagnosticCommand(command),
          expectedIdentity: diagnosticIdentity(trust),
          actualIdentity: diagnosticIdentity(identity),
        },
      );
    }
    return;
  }
  if (requiresExactTrust) {
    throw error(
      'cli-executable-untrusted',
      `Refusing untrusted executable for ${diagnosticCommand(command)}. Trust this exact executable identity before execution.`,
      { command: diagnosticCommand(command), identity: diagnosticIdentity(identity) },
    );
  }
}

async function canonicalProjectDir(projectDir: string): Promise<string> {
  try {
    return await realpath(projectDir);
  } catch {
    return resolve(projectDir);
  }
}

function executableNames(command: string): string[] {
  if (process.platform !== 'win32' || command.includes('.')) return [command];
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension.length > 0);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

async function firstExecutable(
  directory: string,
  command: string,
): Promise<CliExecutableIdentity | null> {
  for (const name of executableNames(command)) {
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
    } catch {}
  }

  const nodeDirectory = await realpath(dirname(process.execPath));
  if (!isWithin(nodeDirectory, realProjectPath) && !seen.has(nodeDirectory)) {
    directories.push(nodeDirectory);
  }
  return directories.join(delimiter);
}

export async function resolveCliExecutable(
  command: string,
  projectDir: string,
  trust?: CliExecutableTrust,
): Promise<CliExecutableIdentity> {
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
    assertTrustedIdentity(command, identity, trust, requiresExactTrust);
    return identity;
  }

  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const unsafeEntry = entry.length === 0 || !isAbsolute(entry);
    const directory = unsafeEntry ? resolve(projectDir, entry || '.') : resolve(entry);
    const identity = await firstExecutable(directory, command);
    if (!identity) continue;

    const requiresExactTrust =
      unsafeEntry || isWithin(directory, projectPath) || isWithin(identity.path, realProjectPath);
    assertTrustedIdentity(command, identity, trust, requiresExactTrust);
    return identity;
  }

  if (trust !== null && trust !== undefined) {
    const identity = await executableIdentity(trust.path);
    if (identity && exactTrustMatches(identity, trust)) return identity;
    if (identity) assertTrustedIdentity(command, identity, trust, true);
  }

  throw error(
    'cli-executable-unavailable',
    `CLI executable not found on trusted PATH: ${diagnosticCommand(command)}`,
    {
      command: diagnosticCommand(command),
    },
  );
}
