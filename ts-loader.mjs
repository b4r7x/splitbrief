export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js')) {
    const tsSpecifier = specifier.slice(0, -3) + '.ts';
    try {
      return await nextResolve(tsSpecifier, context);
    } catch {
      const tsxSpecifier = specifier.slice(0, -3) + '.tsx';
      try {
        return await nextResolve(tsxSpecifier, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.tsx')) {
    const result = await nextLoad(url, { ...context, format: 'module-typescript' });
    return result;
  }
  return nextLoad(url, context);
}
