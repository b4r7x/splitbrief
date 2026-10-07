function channels(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function hexFromChannels(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

export function relativeLuminance(hex: string): number {
  const [red, green, blue] = channels(hex);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function xterm256Hex(index: number): string {
  if (index >= 232) {
    const channel = 8 + (index - 232) * 10;
    return hexFromChannels(channel, channel, channel);
  }
  const cube = index - 16;
  const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return hexFromChannels(
    level(Math.floor(cube / 36)),
    level(Math.floor((cube % 36) / 6)),
    level(cube % 6),
  );
}

function oklab(hex: string): readonly [number, number, number] {
  const [red, green, blue] = channels(hex);
  const r = linear(red);
  const g = linear(green);
  const b = linear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function minimumContrast(hex: string, grounds: readonly string[]): number {
  return Math.min(...grounds.map((ground) => contrastRatio(hex, ground)));
}

export function nearestReadableIndex(
  target: string,
  candidates: readonly string[],
  grounds: readonly string[],
  minRatio: number,
): number {
  const [targetL, targetA, targetB] = oklab(target);
  let nearest = -1;
  let distance = Number.POSITIVE_INFINITY;
  let fallback = -1;
  let highestContrast = Number.NEGATIVE_INFINITY;
  candidates.forEach((candidate, index) => {
    const contrast = minimumContrast(candidate, grounds);
    if (contrast > highestContrast) {
      highestContrast = contrast;
      fallback = index;
    }
    if (contrast < minRatio) return;
    const [l, a, b] = oklab(candidate);
    const candidateDistance = (l - targetL) ** 2 + (a - targetA) ** 2 + (b - targetB) ** 2;
    if (candidateDistance < distance) {
      distance = candidateDistance;
      nearest = index;
    }
  });
  return nearest < 0 ? fallback : nearest;
}

export function readableHex(target: string, grounds: readonly string[], minRatio: number): string {
  if (minimumContrast(target, grounds) >= minRatio) return target;
  const pole =
    minimumContrast('#ffffff', grounds) >= minimumContrast('#000000', grounds)
      ? '#ffffff'
      : '#000000';
  const [red, green, blue] = channels(target);
  const [poleRed, poleGreen, poleBlue] = channels(pole);
  for (let step = 1; step <= 20; step++) {
    const mix = step / 20;
    const candidate = hexFromChannels(
      red + (poleRed - red) * mix,
      green + (poleGreen - green) * mix,
      blue + (poleBlue - blue) * mix,
    );
    if (minimumContrast(candidate, grounds) >= minRatio) return candidate;
  }
  return pole;
}
