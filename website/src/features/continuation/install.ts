import { mountTabs } from '../../lib/tabs.js';

export function mountInstall(root: HTMLElement, request: (change: () => void) => void) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-install-tab]')];
  const methods = [...root.querySelectorAll<HTMLElement>('[data-install-method]')];

  function render(tab: HTMLButtonElement) {
    for (const method of methods) {
      const active = method.id === tab.getAttribute('aria-controls');
      method.dataset.active = String(active);
      method.setAttribute('aria-hidden', String(!active));
      method.inert = !active;
      method.toggleAttribute('data-decode-skip', !active);
    }
  }

  if (tabs[0]) render(tabs[0]);
  const unmount = mountTabs(tabs, request, render);
  return () => {
    unmount();
    for (const method of methods) {
      method.inert = false;
      method.removeAttribute('aria-hidden');
      method.removeAttribute('data-decode-skip');
      delete method.dataset.active;
    }
  };
}
