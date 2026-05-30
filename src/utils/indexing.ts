export const clampIndex = (current: number, length: number): number => {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, current), length - 1);
};

export const navigateIndex = (
  direction: 'up' | 'down',
  current: number,
  length: number,
): number => {
  const safeCurrent = clampIndex(current, length);
  if (direction === 'up') {
    return safeCurrent > 0 ? safeCurrent - 1 : Math.max(0, length - 1);
  }
  return safeCurrent < length - 1 ? safeCurrent + 1 : 0;
};
