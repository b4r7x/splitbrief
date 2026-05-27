export function addMissing(missing: string[], artifact: string): void {
  if (!missing.includes(artifact)) missing.push(artifact);
}
