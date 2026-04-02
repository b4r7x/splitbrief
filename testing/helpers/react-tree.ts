function expand(el: unknown): unknown {
  if (el == null || typeof el !== 'object' || !('type' in (el as object))) return el;
  const node = el as { type: unknown; props: Record<string, unknown> };
  if (typeof node.type === 'function') {
    try {
      return (node.type as (props: Record<string, unknown>) => unknown)(node.props);
    } catch {
      return el;
    }
  }
  return el;
}

export function collectText(el: unknown): string {
  if (el == null || typeof el === 'boolean') return '';
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(collectText).join('');
  if (typeof el === 'object' && el !== null && 'props' in el) {
    const expanded = expand(el);
    if (expanded !== el) return collectText(expanded);
    const props = (el as { props: { children?: unknown } }).props;
    return collectText(props.children);
  }
  return '';
}

export function findText(el: unknown, pred: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (el == null || typeof el !== 'object') return null;
  if (!('props' in (el as object))) return null;
  const node = el as { type: unknown; props: Record<string, unknown> };
  const expanded = expand(el);
  if (expanded !== el) return findText(expanded, pred);
  const typeName = typeof node.type === 'function' ? (node.type as { name?: string }).name : node.type;
  if (typeName === 'Text' && pred(node.props)) return node.props;
  const children = node.props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findText(child, pred);
      if (found) return found;
    }
  } else if (children && typeof children === 'object') {
    return findText(children, pred);
  }
  return null;
}
