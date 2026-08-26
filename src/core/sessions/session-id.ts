import { randomUUID } from 'node:crypto';
import { sessionsRoot } from '../paths.js';
import { slugify } from '../../utils/slugify.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../transcript-policy.js';
import { sessionError } from './errors.js';
import { findUnusedId } from './find-unused-id.js';

export const MAX_SLUG_LENGTH = 50;
const MAX_COLLISION_ATTEMPTS = 999;
const OPAQUE_ID_LENGTH = 12;
const OPAQUE_SESSION_PATTERN = /^\d{4}-\d{2}-\d{2}-session-[a-f0-9]{12}(?:-\d+)?$/;
export const TRANSCRIPT_OMITTED_FEATURE = TRANSCRIPT_OMITTED_MESSAGE;

export interface GenerateSessionIdInput {
  projectDir: string;
  feature: string;
  now?: Date | undefined;
  persistTranscript?: boolean | undefined;
}

function findUniqueId(projectDir: string, base: string): string {
  const root = sessionsRoot(projectDir);
  const id = findUnusedId({
    root,
    base,
    suffixer: (candidateBase, collisionIndex) => `${candidateBase}-${collisionIndex + 1}`,
    maxCollisionAttempts: MAX_COLLISION_ATTEMPTS - 1,
  });
  if (id !== null) return id;
  throw sessionError.idCollision(base, MAX_COLLISION_ATTEMPTS);
}

export function generateSessionId(input: GenerateSessionIdInput): string {
  const now = input.now ?? new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  if (input.persistTranscript === false) {
    return findUniqueId(input.projectDir, `${date}-${generateOpaqueSessionSlug()}`);
  }
  const slug = slugify(input.feature, MAX_SLUG_LENGTH) || 'unknown';
  return findUniqueId(input.projectDir, `${date}-${slug}`);
}

export function generateOpaqueSessionSlug(): string {
  return `session-${randomUUID().replaceAll('-', '').slice(0, OPAQUE_ID_LENGTH)}`;
}

export function isOpaqueSessionId(sessionId: string): boolean {
  return OPAQUE_SESSION_PATTERN.test(sessionId);
}

export function featureForTranscriptPolicy(feature: string, persistTranscript: boolean): string {
  return persistTranscript ? feature : TRANSCRIPT_OMITTED_FEATURE;
}
