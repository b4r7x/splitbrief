export function appendMapValue<Key, Value>(options: {
  readonly map: Map<Key, Value[]>;
  readonly key: Key;
  readonly value: Value;
}): void {
  const values = options.map.get(options.key);
  if (values) {
    values.push(options.value);
    return;
  }
  options.map.set(options.key, [options.value]);
}
