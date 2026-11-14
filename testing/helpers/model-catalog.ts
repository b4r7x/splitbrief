import { expect } from 'vitest';

export function uniqueModelIds(models: readonly { id: string }[]): string[] {
  const ids = models.map((model) => model.id);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}
