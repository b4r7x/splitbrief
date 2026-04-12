function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

function transformKeys(obj: unknown, keyFn: (key: string) => string): unknown {
  if (Array.isArray(obj)) return obj.map(item => transformKeys(item, keyFn));
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[keyFn(key)] = transformKeys(value, keyFn);
    }
    return result;
  }
  return obj;
}

export function fromYaml(obj: unknown): Record<string, unknown> {
  return transformKeys(obj, snakeToCamel) as Record<string, unknown>;
}

export function toYaml(obj: Record<string, unknown>): Record<string, unknown> {
  return transformKeys(obj, camelToSnake) as Record<string, unknown>;
}
