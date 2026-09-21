// The transcript's one-cell lead: the empty cell a row's hover bar paints into, ahead of any mark.
// A marked row puts its mark on column 1 and its content on column 3; an unmarked row starts its
// content on column 3 too, with the mark slot empty — column 1 carries centred glyphs (marks,
// connectors, every box stroke) and text never enters it. `rowLeading()` in
// `features/workflow/conversation-rows/row-markers.ts` owns the transcript's own grammar; the
// blocks that paint their own leading — a brief's pinned summary and the closed run's ledger — may
// not import that feature slice, so this is the one shared copy they read, and the workflow
// chrome's gutter is measured off it so box borders land on the same column.
export const ROW_LEADING = ' ';

// The mark and its trailing space: the two cells between the lead and the text column, which a
// marked row fills and an unmarked row leaves blank.
export const MARK_SLOT_CELLS = 2;

export const TEXT_LEADING = ROW_LEADING + ' '.repeat(MARK_SLOT_CELLS);
