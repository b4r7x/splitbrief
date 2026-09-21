const RESPONSE_MS = 120;
const REVERSE_MS = 60;

export function createScrub() {
  let from = 0;
  let target = 0;
  let started = 0;
  let duration = RESPONSE_MS;
  let direction = 0;

  function read(now: number) {
    const elapsed = Math.max(0, now - started);
    if (elapsed >= duration || from === target) return target;
    return target + (from - target) * (1 - elapsed / duration) ** 3;
  }

  function set(next: number, now: number, immediate = false) {
    if (immediate) {
      from = next;
      target = next;
      direction = 0;
      return;
    }
    if (next === target) return;
    const nextDirection = Math.sign(next - target);
    from = read(now);
    duration = direction && nextDirection !== direction ? REVERSE_MS : RESPONSE_MS;
    direction = nextDirection;
    target = next;
    started = now;
  }

  return { set, read };
}
