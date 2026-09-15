const DESCRIPTIONS: Record<string, readonly [string, string, string]> = {
  'review.md': [
    'THE REVIEW',
    'The stronger tool’s assessment.',
    'The final review records whether the finished changes satisfy the spec and the briefs, along with findings that need attention.',
  ],
  'session.jsonl': [
    'THE EVENT LOG',
    'The run, in order.',
    'An append-only record of session events. Follow the workflow through planning, execution, validation and review.',
  ],
  'state.json': [
    'THE CHECKPOINT',
    'Where the session stands.',
    'The persisted workflow state lets SPLITBRIEF pick up an unfinished run. The session stays with this repository.',
  ],
};

export function mountFiles(root: HTMLElement, onChange: () => void) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-file]')];
  const panel = root.querySelector<HTMLElement>('#file-description');
  const kind = panel?.querySelector('.file-kind');
  const title = panel?.querySelector('h3');
  const description = panel?.querySelector('p');
  if (!panel || !kind || !title || !description)
    throw new Error('Session file inspector is incomplete');
  const original: readonly [string, string, string] = [
    kind.textContent ?? '',
    title.textContent ?? '',
    description.textContent ?? '',
  ];
  const abort = new AbortController();

  function select(tab: HTMLButtonElement) {
    const content = tab === tabs[0] ? original : DESCRIPTIONS[tab.dataset.file ?? ''];
    if (!content || !panel || !kind || !title || !description) return;
    for (const candidate of tabs) {
      candidate.setAttribute('aria-selected', String(candidate === tab));
      candidate.tabIndex = candidate === tab ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', tab.id);
    [kind.textContent, title.textContent, description.textContent] = content;
    onChange();
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
    [kind.textContent, title.textContent, description.textContent] = original;
    for (const [index, tab] of tabs.entries()) {
      tab.setAttribute('aria-selected', String(index === 0));
      tab.tabIndex = index === 0 ? 0 : -1;
    }
    if (tabs[0]) panel.setAttribute('aria-labelledby', tabs[0].id);
  };
}
