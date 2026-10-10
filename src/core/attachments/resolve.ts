import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { EXT_TO_MIME, MAX_ATTACHMENT_BYTES, SUPPORTED_IMAGE_EXTS } from '../schemas/attachment.js';
import { truncateTerminalDisplayText } from '../../utils/display-text.js';
import { includes } from '../../utils/type-guards.js';
import type { Attachment } from '../schemas/attachment.js';

export type ResolveAttachmentReason = 'not-image' | 'not-found' | 'too-large';

export type ResolveAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: ResolveAttachmentReason };

export type ResolveRenderAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: ResolveAttachmentReason | 'outside-safe-roots' };

export type AttachmentFailureAction = 'attach' | 'send';

export function formatAttachmentFailure(input: {
  action: AttachmentFailureAction;
  reason: ResolveAttachmentReason;
  imageId?: string | undefined;
}): string {
  const subject = input.action === 'send' ? 'send image' : 'attach image';
  const identifiedSubject =
    input.action === 'send' && input.imageId !== undefined
      ? `send image (${input.imageId})`
      : subject;

  switch (input.reason) {
    case 'not-found':
      return input.action === 'send'
        ? `Cannot ${identifiedSubject}: the file is no longer available. Remove it from the draft and attach it again.`
        : 'Cannot attach image: the file was not found. Check the path and try again.';
    case 'not-image':
      return `Cannot ${subject}: choose a PNG, JPEG, GIF, WebP, or BMP file.`;
    case 'too-large':
      return `Cannot ${subject}: the file is larger than 10 MiB. Choose a smaller image.`;
  }
}

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

  const expanded = trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed;
  const absPath = isAbsolute(expanded) ? normalize(expanded) : resolve(opts.projectDir, expanded);
  const result = inspectAttachment(absPath);
  if (!result.ok) return result;
  try {
    accessSync(result.attachment.path, constants.R_OK);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  return result;
}

export function resolveRenderAttachment(
  opts: ResolveAttachmentOpts,
): ResolveRenderAttachmentResult {
  const trimmed = opts.input.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return { ok: false, reason: 'not-found' };

  const absPath = isAbsolute(trimmed) ? normalize(trimmed) : resolve(opts.projectDir, trimmed);
  const result = inspectAttachment(absPath);
  if (!result.ok) return result;

  const safeRoots = [opts.projectDir, homedir()].map((r) => normalize(r));
  const inSafeRoot = safeRoots.some((root) =>
    isInsideSafeRoot(absPath, result.attachment.path, root),
  );
  if (!inSafeRoot) {
    return { ok: false, reason: 'outside-safe-roots' };
  }
  return result;
}

function inspectAttachment(absPath: string): ResolveAttachmentResult {
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
