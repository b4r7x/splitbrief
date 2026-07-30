import { JackBullet } from '../../components/jack-bullet.js';
import { GITHUB_REPOSITORY_URL } from '../../../shared/site-identity.js';
import { SearchDialog } from './search-dialog.js';
import { ThemeToggle } from './theme-toggle.js';
import './docs-header.css';

export function DocsHeader() {
  return (
    <header className="docs-header">
      <div className="docs-header__inner">
        <span aria-hidden="true" className="docs-header__motif" />
        <a className="docs-header__brand" href="/" aria-label="SPLITBRIEF home">
          <JackBullet variant="planner" />
          <span className="docs-header__name">Splitbrief</span>
          <span className="docs-header__division" aria-hidden="true">
            /
          </span>
          <span className="docs-header__edition">Documentation</span>
          <JackBullet variant="implementer" />
        </a>

        <span className="docs-header__rule" aria-hidden="true" />

        <div className="docs-header__actions">
          <SearchDialog />
          <ThemeToggle />
          <a className="docs-header__source" href={GITHUB_REPOSITORY_URL}>
            [ source ]
          </a>
        </div>
      </div>
    </header>
  );
}
