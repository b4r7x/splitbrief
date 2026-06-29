const ansiStylePattern = new RegExp(`${String.fromCharCode(27)}[[][0-9;]*m`, 'g');

export function stripAnsiStyles(frame: string): string {
  return frame.replace(ansiStylePattern, '');
}
