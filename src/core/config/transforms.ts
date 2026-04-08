export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

export function fromYaml(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(fromYaml);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[snakeToCamel(key)] = fromYaml(value);
    }
    return result;
  }
  return obj;
}

export function toYaml(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(toYaml);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[camelToSnake(key)] = toYaml(value);
    }
    return result;
  }
  return obj;
}
