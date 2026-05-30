export function resolveEditorCommand(): string {
  return process.env.EDITOR ?? 'vi';
}
