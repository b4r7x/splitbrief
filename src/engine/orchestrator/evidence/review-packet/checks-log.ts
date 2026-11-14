import type { ReviewPacket } from '../../../../core/schemas/review/packet.js';
import { reusedNote } from '../../../../core/validation/reused-note.js';

export function renderChecksLog(checks: ReviewPacket['checks']): string[] {
  const entryLines = checks.entries.flatMap((entry) => {
    const task = entry.taskId === undefined ? '' : ` ${entry.taskId}`;
    // A check that did not run has no exit code and no output: its text is why it did not run.
    const ran = entry.status === undefined || entry.status === 'pass' || entry.status === 'fail';
    const outcome = !ran
      ? ` (${entry.status})`
      : entry.exitCode === undefined
        ? ''
        : ` (exit ${entry.exitCode})`;
    const command = entry.command === undefined ? '' : `: ${entry.command}`;
    const lines = [`- ${entry.id}${task}${outcome}${command}`];
    if (entry.reusedAt !== undefined) lines.push(`  ${reusedNote(entry.reusedAt)}`);
    for (const line of (entry.output ?? '').split('\n')) {
      if (line.trim() !== '') lines.push(`  ${ran ? 'output' : 'reason'}: ${line}`);
    }
    if (entry.preExisting !== undefined && entry.preExisting.length > 0) {
      lines.push(`  pre-existing (also red at the run base): ${entry.preExisting.join(', ')}`);
    }
    for (const artifact of entry.artifacts ?? []) {
      lines.push(`  artifact: ${artifact.path} sha256 ${artifact.sha256}`);
    }
    if (entry.workspaceSnapshotId !== undefined) {
      lines.push(`  snapshot: ${entry.workspaceSnapshotId}`);
    }
    if (entry.ts !== undefined) lines.push(`  time: ${entry.ts}`);
    return lines;
  });
  const outsideReadLines = checks.outsideReadPaths.map((path) => `- outside read: ${path}`);
  if (entryLines.length === 0 && outsideReadLines.length === 0) return ['- No checks recorded.'];
  return [...entryLines, ...outsideReadLines];
}

export function renderWholeChecksLog(checks: ReviewPacket['checks']): string {
  return renderChecksLog(checks).join('\n');
}

const DETAIL_CHAR_CAP = 800;
const SECTION_CHAR_CAP = 30_000;

function capDetailTail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length <= DETAIL_CHAR_CAP) return trimmed;
  return `…${trimmed.slice(-(DETAIL_CHAR_CAP - 1))}`;
}

export function renderChecksLogForPrompt(
  checks: ReviewPacket['checks'],
  paths: Readonly<{ validation: string; sessionLog: string }>,
): string {
  const latest = new Map<string, { index: number; ts: string | undefined }>();
  checks.entries.forEach((entry, index) => {
    const previous = latest.get(entry.id);
    if (
      previous === undefined ||
      previous.ts === undefined ||
      entry.ts === undefined ||
      entry.ts >= previous.ts
    ) {
      latest.set(entry.id, { index, ts: entry.ts });
    }
  });
  const blocks = [
    ...checks.entries.map((entry, index) => {
      const failed = entry.exitCode !== undefined && entry.exitCode !== 0;
      return {
        priority: latest.get(entry.id)?.index === index ? (failed ? 1 : 2) : failed ? 3 : 4,
        text: renderChecksLog({
          entries: [
            {
              ...entry,
              ...(entry.output !== undefined && { output: capDetailTail(entry.output) }),
            },
          ],
          outsideReadPaths: [],
        }).join('\n'),
      };
    }),
    ...checks.outsideReadPaths.map((path) => ({
      priority: 0,
      text: renderChecksLog({ entries: [], outsideReadPaths: [path] }).join('\n'),
    })),
  ];
  if (blocks.length === 0) return renderWholeChecksLog(checks);
  const whole = blocks.map((block) => block.text).join('\n');
  if (whole.length <= SECTION_CHAR_CAP) return whole;
  const omissionMarker = (omitted: number, outsideReadOmitted: boolean): string =>
    `[… ${omitted} entries omitted for size; the whole log is in ${paths.validation}${
      outsideReadOmitted ? `, the isolation_outside_read warnings in ${paths.sessionLog}` : ''
    } …]`;
  const markerChars = omissionMarker(blocks.length, checks.outsideReadPaths.length > 0).length;
  const byPriority = blocks
    .map((block, index) => ({ ...block, index }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const included = new Set<number>();
  let chars = 0;
  for (const block of byPriority) {
    if (chars + block.text.length + 1 + markerChars > SECTION_CHAR_CAP) continue;
    included.add(block.index);
    chars += block.text.length + 1;
  }
  const lines = blocks.filter((_, index) => included.has(index)).map((block) => block.text);
  if (included.size < blocks.length) {
    const outsideReadOmitted = blocks.some(
      (block, index) => block.priority === 0 && included.has(index) === false,
    );
    lines.push(omissionMarker(blocks.length - included.size, outsideReadOmitted));
  }
  return lines.join('\n');
}
