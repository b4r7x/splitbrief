/**
 * The name of a plan check, one spelling for the transcript and the `--plain` line: `plan check K1`
 * before review, and `T007 check K1` for a brief's own check during the build. An id that already
 * starts with its brief's id names the brief once: `check T007-K1`.
 */
export function planCheckName(check: {
  id?: string | undefined;
  taskId?: string | undefined;
}): string {
  const id = check.id === undefined ? '' : ` ${check.id}`;
  if (check.taskId === undefined) return `plan check${id}`;
  return check.id?.startsWith(`${check.taskId}-`) ? `check${id}` : `${check.taskId} check${id}`;
}
