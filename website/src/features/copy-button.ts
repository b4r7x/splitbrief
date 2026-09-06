const COMMAND = 'npm install -g splitbrief';
const NOTICE_MS = 1600;

type Label = Pick<HTMLElement, 'textContent' | 'hidden'>;

type CopyButton = {
  classList: Pick<DOMTokenList, 'add' | 'remove'>;
  querySelector(selectors: string): Label | null;
  addEventListener(type: 'click', listener: () => void): void;
};

type ClipboardWriter = Pick<Clipboard, 'writeText'>;

export function mountCopyButton(
  button: CopyButton,
  clipboard: ClipboardWriter = navigator.clipboard,
): void {
  const idle = button.querySelector('.cta-idle');
  const notice = button.querySelector('.cta-notice');
  if (!idle || !notice) throw new Error('copy button needs .cta-idle and .cta-notice');
  let restore: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', async () => {
    const copied = await clipboard.writeText(COMMAND).then(
      () => true,
      () => false,
    );
    notice.textContent = copied ? 'copied to clipboard' : 'copy failed';
    idle.hidden = true;
    notice.hidden = false;
    if (copied) button.classList.add('copied');
    clearTimeout(restore);
    restore = setTimeout(() => {
      idle.hidden = false;
      notice.hidden = true;
      button.classList.remove('copied');
    }, NOTICE_MS);
  });
}
