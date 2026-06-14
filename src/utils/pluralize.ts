export function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

export function countNoun(n: number, singular: string, plural?: string): string {
  return `${n} ${pluralize(n, singular, plural)}`;
}
