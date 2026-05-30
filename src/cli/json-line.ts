export function writeJsonLine(value: unknown, out: NodeJS.WritableStream = process.stdout): void {
  out.write(JSON.stringify(value) + '\n');
}

export function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
