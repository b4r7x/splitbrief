export function mountLibrary(root: HTMLElement) {
  const input = root.querySelector<HTMLInputElement>('.docs-search input');
  const clear = root.querySelector<HTMLButtonElement>('.docs-search-clear');
  const groups = [...root.querySelectorAll<HTMLDetailsElement>('.docs-group')];
  const links = [...root.querySelectorAll<HTMLAnchorElement>('.docs-library nav a')];
  const empty = root.querySelector<HTMLElement>('.docs-empty');
  const abort = new AbortController();

  function update() {
    const query = input?.value.trim().toLowerCase() ?? '';
    if (clear) clear.hidden = !input?.value;
    let count = 0;
    for (const link of links) {
      const active = new URL(link.href).pathname === location.pathname;
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
      link.hidden = query !== '' && !link.textContent?.toLowerCase().includes(query);
      if (!link.hidden) count += 1;
    }
    for (const group of groups) {
      group.hidden = ![...group.querySelectorAll('a')].some((link) => !link.hidden);
      group.open = !!query || !!group.querySelector('[aria-current="page"]');
    }
    if (empty) empty.hidden = count > 0;
  }
  input?.addEventListener('input', update, { signal: abort.signal });
  clear?.addEventListener(
    'click',
    () => {
      if (!input) return;
      input.value = '';
      update();
      input.focus();
    },
    { signal: abort.signal },
  );
  update();

  return {
    update,
    destroy() {
      abort.abort();
      for (const group of groups) {
        group.hidden = false;
        group.open = true;
      }
      for (const link of links) link.hidden = false;
      if (empty) empty.hidden = true;
      if (clear) clear.hidden = true;
    },
  };
}
