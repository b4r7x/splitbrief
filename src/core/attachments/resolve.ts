import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { EXT_TO_MIME, MAX_ATTACHMENT_BYTES, SUPPORTED_IMAGE_EXTS } from '../schemas/attachment.js';
import { truncateTerminalDisplayText } from '../../utils/display-text.js';
import { includes } from '../../utils/type-guards.js';
import type { Attachment } from '../schemas/attachment.js';

export type ResolveAttachmentReason =
  | 'not-image'
  | 'not-found'
  | 'too-large'
  | 'outside-safe-roots';

export type ResolveAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: ResolveAttachmentReason };

interface ResolveAttachmentOpts {
  input: string;
  projectDir: string;
}

function ensureTrailingSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

function isUnderRoot(absPath: string, root: string): boolean {
  const normalizedRoot = ensureTrailingSep(normalize(root));
  const normalizedPath = normalize(absPath);
  return normalizedPath === normalize(root) || normalizedPath.startsWith(normalizedRoot);
}

function realRootOf(root: string): string {
  try {
    return normalize(realpathSync(root));
  } catch {
    return normalize(root);
  }
}

function isInsideSafeRoot(absPath: string, realPath: string, root: string): boolean {
  const lexicalRoot = normalize(root);
  const realRoot = realRootOf(root);
  const pathIsInsideRoot = isUnderRoot(absPath, lexicalRoot) || isUnderRoot(absPath, realRoot);
  return pathIsInsideRoot && isUnderRoot(realPath, realRoot);
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return p.slice(dot + 1).toLowerCase();
}

export function resolveAttachment(opts: ResolveAttachmentOpts): ResolveAttachmentResult {
  const trimmed = opts.input.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return { ok: false, reason: 'not-found' };

  const absPath = isAbsolute(trimmed) ? normalize(trimmed) : resolve(opts.projectDir, trimmed);

  const ext = extOf(absPath);
  if (!includes(SUPPORTED_IMAGE_EXTS, ext)) {
    return { ok: false, reason: 'not-image' };
  }

  let stat: Stats;
  try {
    stat = statSync(absPath);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-found' };

  if (stat.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'too-large' };

  let realPath = absPath;
  try {
    realPath = realpathSync(absPath);
  } catch {
    return { ok: false, reason: 'not-found' };
  }

  const safeRoots = [opts.projectDir, homedir()].map((r) => normalize(r));
  const inSafeRoot = safeRoots.some((root) => isInsideSafeRoot(absPath, realPath, root));
  if (!inSafeRoot) {
    return { ok: false, reason: 'outside-safe-roots' };
  }

  const mimeType = EXT_TO_MIME[ext];
  const id = `att-${randomUUID()}`;

  return {
    ok: true,
    attachment: {
      id,
      kind: 'image',
      path: realPath,
      mimeType,
      sizeBytes: stat.size,
    },
  };
}

const ATTACHMENT_SHORT_NAME_MAX = 24;

export function attachmentShortName(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return truncateTerminalDisplayText(base, ATTACHMENT_SHORT_NAME_MAX);
}
