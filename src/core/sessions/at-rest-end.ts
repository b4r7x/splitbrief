/**
 * Where an End taken at rest ends a running stretch: at the latest mark of the stretch dated before
 * that End began (`atRestFrom`), and never before `floor`. Neither the time at rest nor what the End
 * itself writes counts.
 */
export function endBeforeAtRest(
  marks: readonly { ts?: number | undefined }[],
  atRestFrom: number,
  floor: number,
): number {
  return marks.reduce(
    (latest, mark) =>
      mark.ts !== undefined && mark.ts < atRestFrom ? Math.max(latest, mark.ts) : latest,
    floor,
  );
}
