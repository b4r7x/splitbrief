export const navigateIndex = (direction: 'up' | 'down', current: number, length: number): number =>
  direction === 'up'
    ? (current > 0 ? current - 1 : length - 1)
    : (current < length - 1 ? current + 1 : 0);
