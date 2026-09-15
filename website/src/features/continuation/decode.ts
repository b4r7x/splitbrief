export function decodeStage(progress: number) {
  const position = Math.max(0, Math.min(1, progress)) * 3;
  const index = Math.min(2, Math.floor(position));
  const local = position - index;
  const amount = Math.min(1, local / 0.3, index === 2 ? 1 : (1 - local) / 0.15);
  return { index, amount: Math.max(0, amount) };
}
