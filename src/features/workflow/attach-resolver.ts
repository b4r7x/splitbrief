import type { Stats } from 'node:fs';
import { resolve, isAbsolute, sep, normalize } from 'node:path';
import { statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  EXT_TO_MIME,
  MAX_ATTACHMENT_BYTES,
  SUPPORTED_IMAGE_EXTS,
} from '../../core/schemas/attachment.js';
import type { Attachment } from '../../core/schemas/attachment.js';

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
  if (!(SUPPORTED_IMAGE_EXTS as readonly string[]).includes(ext)) {
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

  const safeRoots = [opts.projectDir, homedir()].map(r => normalize(r));
  const inSafeRoot = safeRoots.some(root => isUnderRoot(absPath, root) && isUnderRoot(realPath, root));
  if (!inSafeRoot) {
    return { ok: false, reason: 'outside-safe-roots' };
  }

  const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
  const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    ok: true,
    attachment: {
      id,
      kind: 'image',
      path: realPath,
      mimeType,
      sizeBytes: stat.size,
      addedAt: Date.now(),
    },
  };
}

export function basenameShort(p: string, max = 24): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.length > max ? base.slice(0, max - 3) + '...' : base;
}
