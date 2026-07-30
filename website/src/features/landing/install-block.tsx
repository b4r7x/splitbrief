import { useHydrated } from '@tanstack/react-router';
import { BorderedFrame } from '../../components/bordered-frame.js';
import { DOCS_HOME_PATH } from '../../docs-home-path.js';
import { type CopyFeedbackState, useCopyFeedback } from '../../hooks/use-copy-feedback.js';
import { GITHUB_LICENSE_URL, GITHUB_REPOSITORY_URL } from '../../../shared/site-identity.js';
import './install.css';

const INSTALL_COMMANDS = `git clone ${GITHUB_REPOSITORY_URL}.git
cd splitbrief
npm install
npm run build
npm link`;

const COPY_MESSAGES: Record<CopyFeedbackState, string> = {
  idle: '',
  copied: 'Install commands copied.',
  failed: 'Copy failed. Select the commands and copy them manually.',
};

export function InstallBlock() {
  const hydrated = useHydrated();
  const { copyState, copyText } = useCopyFeedback();

  return (
    <BorderedFrame
      actions={
        <button
          className="install-block__copy"
          data-copy-state={copyState}
          disabled={!hydrated}
          type="button"
          onClick={() => void copyText(INSTALL_COMMANDS)}
        >
          Copy install commands
        </button>
      }
      className="install-block"
      label="from source — not yet on npm"
      meta={
        <span className="install-block__chip">
          <span aria-hidden="true" className="install-block__chip-dot" />
          npm: pending
        </span>
      }
    >
      <pre className="install-block__commands">
        <code>
          {INSTALL_COMMANDS.split('\n').map((line, index, lines) => (
            <span className="install-block__line" key={line}>
              {line}
              {index < lines.length - 1 ? '\n' : null}
            </span>
          ))}
        </code>
      </pre>
      <div className="install-block__ordering">
        <dl className="install-block__requirements">
          <div>
            <dt>Runtime</dt>
            <dd>Node 22+</dd>
          </div>
          <div>
            <dt>Operating systems</dt>
            <dd>macOS / Linux</dd>
          </div>
        </dl>
        <ul className="install-block__links" aria-label="Installation references">
          <li>
            <a href={DOCS_HOME_PATH}>[ Documentation ]</a>
          </li>
          <li>
            <a href={GITHUB_REPOSITORY_URL}>[ GitHub ]</a>
          </li>
          <li>
            <a href={GITHUB_LICENSE_URL}>[ MIT License ]</a>
          </li>
        </ul>
      </div>
      <p className="install-block__status" role="status">
        {COPY_MESSAGES[copyState]}
      </p>
    </BorderedFrame>
  );
}

export function InstallCaption() {
  return <p className="install-block__caption">Five commands from the entrance.</p>;
}
