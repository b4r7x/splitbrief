import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CliExecutableReceiptSchema,
  EXECUTABLE_CONTENT_DIGEST_ALGORITHM,
  formatDigestBoundExecutableFingerprint,
} from '../../core/discovery/detection.js';
import type {
  CliExecutableIdentity,
  CliExecutableReceipt,
  ExecutableIdentity,
} from '../../core/discovery/detection.js';
import type * as Detection from '../../core/discovery/detection.js';
import { isENOENT } from '../../lib/process/errors.js';
import { error, matches } from '../../utils/error.js';

export type CliExecutableTrust = Detection.CliExecutableTrust | null | undefined;

export type CliExecutableResolver = (
  command: string,
  projectDir: string,
  trust?: CliExecutableTrust,
) => Promise<CliExecutableIdentity>;

export type ResolvedCliExecutable = Readonly<{
  /** The catalog candidate whose exact identity was selected. */
  command: string;
  executable: CliExecutableIdentity;
  /** `true` only when every earlier catalog candidate was absent. */
  usedFallback: boolean;
}>;

export type ResolveCliExecutableAliasesOptions = Readonly<{
  commands: readonly string[];
  projectDir: string;
  trust?: CliExecutableTrust;
  resolveExecutable?: CliExecutableResolver;
}>;

export type CustomExecutableResolution =
  | Readonly<{ kind: 'resolved'; executable: CliExecutableReceipt }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'non-executable' }>
  | Readonly<{ kind: 'identity-drifted' }>
  | Readonly<{ kind: 'invalid' }>;

export type ResolveCustomExecutableOptions = Readonly<{
  command: string;
  projectDir: string;
  expected?: CliExecutableReceipt | undefined;
  pathEnv?: string | undefined;
  pathExt?: string | undefined;
}>;

type DiagnosticIdentity = Readonly<{
  fingerprint: CliExecutableIdentity['fingerprint'];
}>;

const EXECUTABLE_CONTENT_DIGEST_CHUNK_BYTES = 64 * 1024;

type DigestBoundExecutableFingerprint = Readonly<{
  fingerprint: CliExecutableIdentity['fingerprint'];
  contentDigest: string;
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

export function fingerprintsEqual(
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

function receiptFromTrust(
  identity: Detection.CliExecutableTrust,
): CliExecutableReceipt | null | undefined {
  if (!('executableIdentity' in identity)) return undefined;
  const result = CliExecutableReceiptSchema.safeParse(identity);
  return result.success ? result.data : null;
}

function executionIdentitiesEqual({
  expected,
  actual,
}: Readonly<{ expected: ExecutableIdentity; actual: ExecutableIdentity }>): boolean {
  return (
    expected.canonicalPath === actual.canonicalPath &&
    expected.realPath === actual.realPath &&
    expected.platformFileId === actual.platformFileId &&
    expected.fingerprint === actual.fingerprint
  );
}

function executableReceiptsEqual(
  expected: CliExecutableReceipt,
  actual: CliExecutableReceipt,
): boolean {
  return (
    expected.path === actual.path &&
    fingerprintsEqual(expected.fingerprint, actual.fingerprint) &&
    executionIdentitiesEqual({
      expected: expected.executableIdentity,
      actual: actual.executableIdentity,
    })
  );
}

function fingerprintFromStats(
  stats: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  }>,
): CliExecutableIdentity['fingerprint'] {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
}

async function digestExecutable(
  realPath: string,
): Promise<DigestBoundExecutableFingerprint | null> {
  const handle = await open(realPath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) return null;
    const fingerprint = fingerprintFromStats(before);
    const digest = createHash(EXECUTABLE_CONTENT_DIGEST_ALGORITHM);
    const buffer = Buffer.allocUnsafe(EXECUTABLE_CONTENT_DIGEST_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (!fingerprintsEqual(fingerprint, fingerprintFromStats(after))) return null;
    return { fingerprint, contentDigest: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function readExecutableIdentity(candidate: string): Promise<CliExecutableReceipt | null> {
  const canonicalPath = resolve(candidate);
  await access(canonicalPath, constants.X_OK);
  const realPath = await realpath(canonicalPath);
  const digested = await digestExecutable(realPath);
  if (digested === null) return null;
  const confirmedRealPath = await realpath(canonicalPath);
  const confirmed = await stat(realPath);
  if (
    confirmedRealPath !== realPath ||
    !confirmed.isFile() ||
    !fingerprintsEqual(digested.fingerprint, fingerprintFromStats(confirmed))
  ) {
    return null;
  }
  const fingerprint = formatDigestBoundExecutableFingerprint(digested);
  if (fingerprint === null) return null;
  const receipt = CliExecutableReceiptSchema.safeParse({
    path: realPath,
    fingerprint: digested.fingerprint,
    executableIdentity: {
      canonicalPath,
      realPath,
      platformFileId: `${digested.fingerprint.dev}:${digested.fingerprint.ino}`,
      fingerprint,
      resolvedAt: Date.now(),
    },
  });
  return receipt.success ? receipt.data : null;
}

async function executableIdentity(candidate: string): Promise<CliExecutableReceipt | null> {
  try {
    return await readExecutableIdentity(candidate);
  } catch {
    return null;
  }
}

function exactTrustMatches(identity: CliExecutableReceipt, trust: CliExecutableTrust): boolean {
  if (
    trust === null ||
    trust === undefined ||
    trust.path !== identity.path ||
    !fingerprintsEqual(trust.fingerprint, identity.fingerprint)
  ) {
    return false;
  }
  const trustedReceipt = receiptFromTrust(trust);
  return (
    trustedReceipt === undefined ||
    (trustedReceipt !== null &&
      executionIdentitiesEqual({
        expected: trustedReceipt.executableIdentity,
        actual: identity.executableIdentity,
      }))
  );
}

/**
 * Re-reads the admitted executable immediately before a probe or spawn.
 * Bare legacy identities remain a metadata-only compatibility shape; fresh
 * start admission never creates one.
 */
export async function revalidateCliExecutableIdentity(
  identity: Detection.CliExecutableTrust,
): Promise<'match' | 'missing' | 'drift'> {
  const trustedReceipt = receiptFromTrust(identity);
  if (trustedReceipt === null) return 'drift';
  try {
    const actual = await readExecutableIdentity(
      trustedReceipt?.executableIdentity.canonicalPath ?? identity.path,
    );
    if (actual === null) return 'drift';
    if (
      actual.path !== identity.path ||
      !fingerprintsEqual(actual.fingerprint, identity.fingerprint)
    ) {
      return 'drift';
    }
    if (
      trustedReceipt !== undefined &&
      !executionIdentitiesEqual({
        expected: trustedReceipt.executableIdentity,
        actual: actual.executableIdentity,
      })
    ) {
      return 'drift';
    }
    return 'match';
  } catch (cause) {
    return isENOENT(cause) ? 'missing' : 'drift';
  }
}

function assertTrustedIdentity(
  command: string,
  identity: CliExecutableReceipt,
  trust: CliExecutableTrust,
  requiresExactTrust: boolean,
): void {
  if (trust !== null && trust !== undefined) {
    if (!exactTrustMatches(identity, trust)) {
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

function customExecutableNames(command: string, pathExt: string | undefined): string[] {
  if (process.platform !== 'win32' || command.includes('.')) return [command];
  const extensions = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code;
}

async function inspectCustomExecutableCandidate(
  candidate: string,
): Promise<CustomExecutableResolution> {
  const canonicalPath = resolve(candidate);
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile()) return { kind: 'non-executable' };
  } catch (cause) {
    return hasNodeErrorCode(cause, 'ENOENT') ? { kind: 'missing' } : { kind: 'invalid' };
  }

  try {
    await access(canonicalPath, constants.X_OK);
  } catch (cause) {
    return hasNodeErrorCode(cause, 'ENOENT') ? { kind: 'missing' } : { kind: 'non-executable' };
  }

  try {
    const executable = await readExecutableIdentity(canonicalPath);
    return executable === null ? { kind: 'invalid' } : { kind: 'resolved', executable };
  } catch (cause) {
    if (hasNodeErrorCode(cause, 'ENOENT')) return { kind: 'missing' };
    if (hasNodeErrorCode(cause, 'EACCES')) return { kind: 'non-executable' };
    return { kind: 'invalid' };
  }
}

function withExpectedCustomExecutable(
  resolution: CustomExecutableResolution,
  expected: CliExecutableReceipt | undefined,
): CustomExecutableResolution {
  if (expected === undefined) return resolution;
  if (resolution.kind === 'resolved' && executableReceiptsEqual(expected, resolution.executable)) {
    return resolution;
  }
  return { kind: 'identity-drifted' };
}

/**
 * Resolves a custom executable using filesystem metadata only. It never starts
 * the candidate or treats finding it as authorization to execute it.
 */
export async function resolveCustomExecutable(
  options: ResolveCustomExecutableOptions,
): Promise<CustomExecutableResolution> {
  const { command, projectDir } = options;
  if (
    command.length === 0 ||
    command.trim() !== command ||
    [...command].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0 || (code < 32 && character !== '\t') || (code >= 127 && code <= 159);
    })
  ) {
    return { kind: 'invalid' };
  }

  const pathLike = isAbsolute(command) || command.includes('/') || command.includes('\\');
  if (pathLike) {
    const candidate = isAbsolute(command) ? command : resolve(projectDir, command);
    return withExpectedCustomExecutable(
      await inspectCustomExecutableCandidate(candidate),
      options.expected,
    );
  }

  for (const entry of (options.pathEnv ?? process.env.PATH ?? '').split(delimiter)) {
    const directory = isAbsolute(entry) ? resolve(entry) : resolve(projectDir, entry || '.');
    for (const name of customExecutableNames(command, options.pathExt ?? process.env.PATHEXT)) {
      const resolution = await inspectCustomExecutableCandidate(join(directory, name));
      if (resolution.kind === 'missing') continue;
      return withExpectedCustomExecutable(resolution, options.expected);
    }
  }

  return options.expected === undefined ? { kind: 'missing' } : { kind: 'identity-drifted' };
}

async function firstExecutable(
  directory: string,
  command: string,
): Promise<CliExecutableReceipt | null> {
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
    throw error(
      'cli-executable-identity-drift',
      `Executable identity changed for ${diagnosticCommand(command)}; run readiness checks again before execution.`,
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
        await resolveExecutable(command, options.projectDir);
      } catch (cause) {
        if (matches('cli-executable-unavailable')(cause)) {
          lastUnavailable = cause;
          continue;
        }
        throw cause;
      }
    }

    try {
      const executable = await resolveExecutable(command, options.projectDir, options.trust);
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
