import {
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  reviewPacketJsonPath,
  reviewPacketMarkdownPath,
} from '../../../../core/paths.js';
import { writeSecureFile } from '../../../../lib/fs.js';
import { buildReviewPacket, type BuildReviewPacketOptions } from './build.js';
import { stringifyReviewPacket, renderReviewPacketMarkdown } from './render.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';

export { buildReviewPacket, REVIEWER_CHECKLIST, type BuildReviewPacketOptions } from './build.js';
export { stringifyReviewPacket, renderReviewPacketMarkdown } from './render.js';

export async function writeReviewPacket(opts: BuildReviewPacketOptions): Promise<ReviewPacket> {
  const packet = await buildReviewPacket(opts);
  writeSecureFile(reviewPacketJsonPath(opts.projectDir, opts.sessionId), stringifyReviewPacket(packet));
  writeSecureFile(reviewPacketMarkdownPath(opts.projectDir, opts.sessionId), renderReviewPacketMarkdown(packet));
  return packet;
}

export const REVIEW_PACKET_ARTIFACTS = {
  json: REVIEW_PACKET_JSON_FILE,
  markdown: REVIEW_PACKET_MARKDOWN_FILE,
} as const;
