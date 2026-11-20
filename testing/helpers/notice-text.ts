/** A notice wraps its words between its frame or bar edges (`|` in ASCII), so a test reads them across the rows. */
export function acrossNoticeEdges(text: string): string {
  return text.replace(/[\s|│▌▐]+/gu, ' ');
}
