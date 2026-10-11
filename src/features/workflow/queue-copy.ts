import { CREW_SEAT_LABELS, type CrewSeatId } from '../../core/crew/identity.js';
import { pluralize } from '../../utils/pluralize.js';

export function queueCopy(input: {
  seat: CrewSeatId | null;
  taskId?: string | null | undefined;
  count?: number | undefined;
  steerable?: boolean | undefined;
  via?: 'mid-call' | undefined;
}) {
  const label = input.seat === null ? null : CREW_SEAT_LABELS[input.seat];
  const taskId = input.seat === 'build' ? input.taskId : null;
  const target = taskId ? `${label} on ${taskId}` : label;
  const count = input.count ?? 1;
  const shortByline = `${count} queued`;
  const timing = input.steerable
    ? 'read after this tool'
    : input.seat === 'build'
      ? 'read when its call ends'
      : input.seat === 'review'
        ? 'read at its verdict call'
        : 'read at its next call';
  const byline = target === null ? shortByline : `${shortByline} for ${target}`;
  return {
    placeholder: target === null ? '' : `Message ${target} · ${timing}…`,
    byline,
    shortByline,
    summary: count === 0 ? 'Queue is empty' : byline,
    clearFeedback:
      count > 0
        ? `Cleared ${count} queued ${pluralize(count, 'message')}`
        : 'Queue is already empty',
    cleared: {
      label: 'Queue cleared',
      value: `${count} pending ${pluralize(count, 'message')} removed`,
    },
    feedback:
      target === null
        ? ''
        : input.steerable
          ? `Sent to ${target} · ${timing} · ctrl+⏎ interrupts`
          : `Queued for ${target} · ctrl+⏎ sends now`,
    queued: { label: 'Queued', value: target === null ? undefined : `for ${target} · ${timing}` },
    delivered: {
      label: 'Delivered',
      value:
        target === null
          ? undefined
          : `${count > 1 ? `${count} messages ` : ''}${input.via === 'mid-call' ? 'mid-call ' : ''}to ${target}`,
    },
    imagesAsPaths: {
      label: 'Images',
      value: `${count} ${pluralize(count, 'image')} went to ${target} as paths · this seat takes no images`,
    },
  };
}
