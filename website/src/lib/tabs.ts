export function mountTabs(
  tabs: readonly HTMLButtonElement[],
  request: (change: () => void) => void,
  render: (tab: HTMLButtonElement) => void,
) {
  const abort = new AbortController();
  let requested = tabs[0];

  function select(tab: HTMLButtonElement) {
    if (tab === requested) return;
    requested = tab;
    for (const candidate of tabs) candidate.tabIndex = candidate === tab ? 0 : -1;
    request(() => {
      for (const candidate of tabs)
        candidate.setAttribute('aria-selected', String(candidate === tab));
      render(tab);
    });
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab), { signal: abort.signal });
    tab.addEventListener(
      'keydown',
      (event) => {
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index - 1 + tabs.length) % tabs.length
                  : -1;
        const target = tabs[next];
        if (!target) return;
        event.preventDefault();
        select(target);
        target.focus({ preventScroll: true });
      },
      { signal: abort.signal },
    );
  }

  return () => {
    abort.abort();
    for (const [index, tab] of tabs.entries()) {
      tab.setAttribute('aria-selected', String(index === 0));
      tab.tabIndex = index === 0 ? 0 : -1;
    }
    if (tabs[0]) render(tabs[0]);
  };
}
