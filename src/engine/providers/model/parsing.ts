export function areExactModelSelectionIdsEqual(
  input: Readonly<{ left: string; right: string }>,
): boolean {
  return input.left === input.right;
}
