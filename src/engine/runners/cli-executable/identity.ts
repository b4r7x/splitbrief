import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type * as Detection from '../../../core/discovery/detection/executable.js';
import {
  type CliExecutableIdentity,
  type CliExecutableReceipt,
  CliExecutableReceiptSchema,
  EXECUTABLE_CONTENT_DIGEST_ALGORITHM,
  formatDigestBoundExecutableFingerprint,
} from '../../../core/discovery/detection/executable.js';
import type { ExecutableIdentity } from '../../../core/discovery/runner-evidence.js';
import { cliExecutableTrustRemediation } from '../../../core/readiness/cli-remediation.js';
import {
  cliToolIdForExecutable,
  CLI_TOOL_CATALOG,
} from '../../../core/runners/cli-tool/catalog.js';
import { isENOENT } from '../../../utils/errno.js';
import { error } from '../../../utils/error.js';
import type { DiagnosticIdentity, CliExecutableTrust } from './types.js';

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
export function diagnosticCommand(command: string): string {
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

/**
 * The words for a run call whose executable no longer matches the one SPLITBRIEF checked, most
 * often after the tool updated itself. Try again checks the tool again for every seat on it.
 */
export function executableChangedMessage(toolName: string): string {
  return `${toolName} changed after SPLITBRIEF checked it, for example in an update. Try again checks it again.`;
}

/** The tool a catalog executable name starts, by its display name; any other name stays as given. */
export function executableToolName(command: string): string {
  const name = diagnosticCommand(command);
  const tool = cliToolIdForExecutable(name);
  return tool === undefined ? name : CLI_TOOL_CATALOG[tool].displayName;
}

export function diagnosticIdentity(identity: CliExecutableIdentity): DiagnosticIdentity {
  return { fingerprint: { ...identity.fingerprint } };
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

export function executableReceiptsEqual(
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

export async function readExecutableIdentity(
  candidate: string,
): Promise<CliExecutableReceipt | null> {
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

export async function executableIdentity(candidate: string): Promise<CliExecutableReceipt | null> {
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
 * Re-reads the admitted real file immediately before a probe or spawn. The
 * PATH entry that led to it is not read again: a symlink moved to a new
 * release leaves the admitted file the one that runs. Bare legacy identities
 * remain a metadata-only compatibility shape; fresh start admission never
 * creates one.
 */
export async function revalidateCliExecutableIdentity(
  identity: Detection.CliExecutableTrust,
): Promise<'match' | 'missing' | 'drift'> {
  const trustedReceipt = receiptFromTrust(identity);
  if (trustedReceipt === null) return 'drift';
  try {
    const actual = await readExecutableIdentity(identity.path);
    if (actual === null) return 'drift';
    if (
      actual.path !== identity.path ||
      !fingerprintsEqual(actual.fingerprint, identity.fingerprint)
    ) {
      return 'drift';
    }
    const expected = trustedReceipt?.executableIdentity;
    if (
      expected !== undefined &&
      (actual.executableIdentity.realPath !== expected.realPath ||
        actual.executableIdentity.platformFileId !== expected.platformFileId ||
        actual.executableIdentity.fingerprint !== expected.fingerprint)
    ) {
      return 'drift';
    }
    return 'match';
  } catch (cause) {
    return isENOENT(cause) ? 'missing' : 'drift';
  }
}

export function assertTrustedIdentity(
  options: Readonly<{
    command: string;
    identity: CliExecutableReceipt;
    trust: CliExecutableTrust;
    requiresExactTrust: boolean;
  }>,
): void {
  const { command, identity, trust, requiresExactTrust } = options;
  if (trust !== null && trust !== undefined) {
    if (!exactTrustMatches(identity, trust)) {
      throw error(
        'cli-executable-identity-drift',
        executableChangedMessage(executableToolName(command)),
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
      `Refusing untrusted executable for ${diagnosticCommand(command)}. ${cliExecutableTrustRemediation('the CLI', 'doctor')}`,
      { command: diagnosticCommand(command), identity: diagnosticIdentity(identity) },
    );
  }
}
