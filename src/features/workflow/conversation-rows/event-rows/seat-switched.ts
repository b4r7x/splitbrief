import { CREW_SEAT_LABELS } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { formatSeatSwitchCause } from '../../../../core/recovery/headline.js';
import { arrowSep, SOFT_SEP } from '../../../../core/separators.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { formatRecordedSeatChangeIdentities } from '../../display/recorded-seat-identity.js';
import { compositeBlock, wholeSegmentsBlock } from '../blocks/compose.js';
import { wrapWidthFor } from '../row-format/markers.js';
import type { ConversationRowBlock, ConversationRowSegment } from '../types.js';

export function seatSwitchedRowBlock(
  keyPrefix: string,
  event: EngineEventOf<'seat_switched'>,
  width: number,
  causeInRecovery: boolean | undefined,
): ConversationRowBlock | null {
  const identities = formatRecordedSeatChangeIdentities(
    event.from,
    event.to,
    CREW_SEAT_ROLES[event.seat],
  );
  // The prefix (the seat label, the arrow) never ends a row: an identity that does not fit
  // beside it splits at its ` · ` parts, and the prefix stays with the first part. When the
  // two seats do not share one row, the arrow and the new seat start their own row.
  const budget = wrapWidthFor('message', width);
  const cells = (segments: readonly ConversationRowSegment[]): number =>
    getTerminalCellWidth(segments.map((segment) => segment.text).join(''));
  const parts = (
    identity: string,
    prefix: ConversationRowSegment[],
  ): ConversationRowSegment[][] => {
    const pieces = identity
      .split(SOFT_SEP)
      .map((text, index): ConversationRowSegment[] => [
        ...(index === 0
          ? prefix
          : [{ text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment]),
        { text, tone: CREW_SEAT_ROLES[event.seat] },
      ]);
    return cells(pieces.flat()) <= budget ? [pieces.flat()] : pieces;
  };
  const from = parts(identities.from, [
    { text: CREW_SEAT_LABELS[event.seat], tone: CREW_SEAT_ROLES[event.seat] },
    { text: '  ', tone: 'textDim' },
  ]);
  const to = parts(identities.to, [{ text: arrowSep(), tone: 'textDim' }]);
  const destination = [
    ...to,
    ...(event.auto
      ? [
          [
            { text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment,
            { text: 'automatic fallback', tone: 'textDim' } satisfies ConversationRowSegment,
          ],
        ]
      : []),
    ...(causeInRecovery
      ? []
      : [
          [
            { text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment,
            {
              text: formatSeatSwitchCause(event),
              tone: 'textDim',
            } satisfies ConversationRowSegment,
          ],
        ]),
  ];
  return cells([...from, ...to].flat()) <= budget
    ? wholeSegmentsBlock(keyPrefix, [...from, ...destination], width, 'message')
    : compositeBlock(keyPrefix, [
        wholeSegmentsBlock(`${keyPrefix}-from`, from, width, 'message'),
        wholeSegmentsBlock(`${keyPrefix}-to`, destination, width, 'message'),
      ]);
}
