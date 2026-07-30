import { DOCS_HOME_PATH } from '../../docs-home-path.js';
import { GITHUB_LICENSE_URL, GITHUB_REPOSITORY_URL } from '../../../shared/site-identity.js';
import './site-footer.css';

const FOOTER_LINKS = [
  { href: DOCS_HOME_PATH, label: 'Docs' },
  { href: GITHUB_REPOSITORY_URL, label: 'GitHub' },
  { href: GITHUB_LICENSE_URL, label: 'MIT' },
  { href: '/llms.txt', label: 'llms.txt' },
] as const;

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="site-footer__legend">Project references</p>
      <ul className="site-footer__links">
        {FOOTER_LINKS.map((link) => (
          <li key={link.href}>
            <a href={link.href}>{link.label}</a>
          </li>
        ))}
      </ul>
    </footer>
  );
}
