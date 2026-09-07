export function find<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`diagram has no ${selector}`);
  return element;
}
