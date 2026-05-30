import wrapAnsi from 'wrap-ansi';

export function wrapHard(text: string, width: number): string {
  return wrapAnsi(text, width, { trim: false, hard: true });
}
