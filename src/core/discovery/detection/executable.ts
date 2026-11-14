import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const EXECUTABLE_CONTENT_DIGEST_ALGORITHM = 'sha256';
const EXECUTABLE_CONTENT_DIGEST_HEX_LENGTH = 64;

const AbsoluteExecutablePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, 'Executable path must be absolute');

/**
 * Inode numbers are 64-bit and `fs.Stats` delivers them as doubles: every
 * executable on the macOS Sealed System Volume — all of `/bin` and `/usr/bin` —
 * reports one above `Number.MAX_SAFE_INTEGER`. Demanding a safe integer refused
 * to fingerprint those files at all, so identity binds the integral value the
 * platform actually reports.
 */
const InodeNumberSchema = z
  .number()
  .nonnegative()
  .refine(Number.isInteger, 'Inode number must be an integer');

export const CliExecutableFingerprintSchema = z
  .object({
    dev: z.number().int().nonnegative(),
    ino: InodeNumberSchema,
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().finite().nonnegative(),
  })
  .strict();
export type CliExecutableFingerprint = z.infer<typeof CliExecutableFingerprintSchema>;

export const CliExecutableIdentitySchema = z
  .object({
    path: AbsoluteExecutablePathSchema,
    fingerprint: CliExecutableFingerprintSchema,
  })
  .strict();
export type CliExecutableIdentity = z.infer<typeof CliExecutableIdentitySchema>;

export function parseDigestBoundExecutableFingerprint(
  value: string,
): CliExecutableFingerprint | null {
  const parts = value.split(':');
  if (parts.length !== 6) return null;
  const [dev, ino, size, mtimeMs, algorithm, contentDigest] = parts;
  if (
    dev === undefined ||
    ino === undefined ||
    size === undefined ||
    mtimeMs === undefined ||
    algorithm !== EXECUTABLE_CONTENT_DIGEST_ALGORITHM ||
    contentDigest === undefined ||
    contentDigest.length !== EXECUTABLE_CONTENT_DIGEST_HEX_LENGTH ||
    !/^[a-f0-9]+$/.test(contentDigest)
  ) {
    return null;
  }

  const parsedDev = nonnegativeInteger(dev);
  const parsedIno = nonnegativeInode(ino);
  const parsedSize = nonnegativeInteger(size);
  const parsedMtimeMs = nonnegativeNumber(mtimeMs);
  if (parsedDev === null || parsedIno === null || parsedSize === null || parsedMtimeMs === null) {
    return null;
  }
  return { dev: parsedDev, ino: parsedIno, size: parsedSize, mtimeMs: parsedMtimeMs };
}

function nonnegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Mirrors `InodeNumberSchema`: 64-bit inode values are not safe integers. */
function nonnegativeInode(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nonnegativeNumber(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const DigestBoundExecutableFingerprintSchema = z.string().superRefine((value, ctx) => {
  if (parseDigestBoundExecutableFingerprint(value) !== null) return;
  ctx.addIssue({
    code: 'custom',
    message: 'Executable fingerprint must bind stat metadata to a SHA-256 content digest',
  });
});

export function formatDigestBoundExecutableFingerprint(
  input: Readonly<{ fingerprint: CliExecutableFingerprint; contentDigest: string }>,
): string | null {
  const { fingerprint, contentDigest } = input;
  const value = `${fingerprint.dev}:${fingerprint.ino}:${fingerprint.size}:${fingerprint.mtimeMs}:${EXECUTABLE_CONTENT_DIGEST_ALGORITHM}:${contentDigest}`;
  const result = DigestBoundExecutableFingerprintSchema.safeParse(value);
  return result.success ? result.data : null;
}

export const ExecutableIdentitySchema = z
  .object({
    canonicalPath: AbsoluteExecutablePathSchema,
    realPath: AbsoluteExecutablePathSchema,
    platformFileId: z.string().min(1),
    fingerprint: DigestBoundExecutableFingerprintSchema,
    resolvedAt: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((identity, ctx) => {
    const fingerprint = parseDigestBoundExecutableFingerprint(identity.fingerprint);
    if (fingerprint === null) return;
    if (identity.platformFileId === `${fingerprint.dev}:${fingerprint.ino}`) return;
    ctx.addIssue({
      code: 'custom',
      path: ['platformFileId'],
      message: 'Executable platform file ID must match the digest-bound fingerprint',
    });
  });
export type ExecutableIdentity = z.infer<typeof ExecutableIdentitySchema>;

export const CliExecutableReceiptSchema = z
  .object({
    path: AbsoluteExecutablePathSchema,
    fingerprint: CliExecutableFingerprintSchema,
    executableIdentity: ExecutableIdentitySchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const richFingerprint = parseDigestBoundExecutableFingerprint(
      receipt.executableIdentity.fingerprint,
    );
    if (receipt.path !== receipt.executableIdentity.realPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'Executable receipt path must match its real path',
      });
    }
    if (
      richFingerprint !== null &&
      (receipt.fingerprint.dev !== richFingerprint.dev ||
        receipt.fingerprint.ino !== richFingerprint.ino ||
        receipt.fingerprint.size !== richFingerprint.size ||
        receipt.fingerprint.mtimeMs !== richFingerprint.mtimeMs)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['fingerprint'],
        message: 'Executable receipt stat fingerprint must match its digest-bound fingerprint',
      });
    }
  });
export type CliExecutableReceipt = z.infer<typeof CliExecutableReceiptSchema>;

export const CliExecutableTrustSchema = z.union([
  CliExecutableReceiptSchema,
  CliExecutableIdentitySchema,
]);
export type CliExecutableTrust = z.infer<typeof CliExecutableTrustSchema>;
