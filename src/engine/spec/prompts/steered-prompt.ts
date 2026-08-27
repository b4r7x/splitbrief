export function composeSteeredPrompt(primary: string, steer: string | undefined): string {
  if (steer === undefined) return primary;
  return `User interrupted before this call: ${steer}\n\n${primary}`;
}
