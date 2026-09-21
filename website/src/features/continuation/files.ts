import { mountTabs } from '../../lib/tabs.js';

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

export function mountFiles(root: HTMLElement, request: (change: () => void) => void) {
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
  return mountTabs(tabs, request, (tab) => {
    const content = tab === tabs[0] ? original : DESCRIPTIONS[tab.dataset.file ?? ''];
    if (!content || !panel || !kind || !title || !description) return;
    panel.setAttribute('aria-labelledby', tab.id);
    [kind.textContent, title.textContent, description.textContent] = content;
  });
}
