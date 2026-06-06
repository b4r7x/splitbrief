import { reviewPacketJsonPath, reviewPacketMarkdownPath } from '../../../../core/paths.js';
import { writeSecureFile } from '../../../../lib/fs.js';
import { buildReviewPacket } from './build.js';
import { stringifyReviewPacket, renderReviewPacketMarkdown } from './render.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';
import type { BuildReviewPacketOptions } from './types.js';

export async function writeReviewPacket(opts: BuildReviewPacketOptions): Promise<ReviewPacket> {
  const packet = await buildReviewPacket(opts);
  writeSecureFile(
    reviewPacketJsonPath(opts.projectDir, opts.sessionId),
    stringifyReviewPacket(packet),
  );
  writeSecureFile(
    reviewPacketMarkdownPath(opts.projectDir, opts.sessionId),
    renderReviewPacketMarkdown(packet),
  );
  return packet;
}
