import { useHydrated } from '@tanstack/react-router';
import { JackBullet } from '../../components/jack-bullet.js';
import type { DocsNavGroup } from './navigation.js';
import './sidebar.css';

export type DocsSidebarProps = {
  readonly currentPath: string;
  readonly groups: readonly DocsNavGroup[];
};

export function DocsSidebar({ currentPath, groups }: DocsSidebarProps) {
  const hydrated = useHydrated();
  const navigation = (
    <nav className="docs-sidebar" aria-label="Documentation">
      {groups.map((group) => (
        <section className="docs-sidebar__group" key={group.label}>
          <h2 className="docs-sidebar__group-label">{group.label}</h2>
          <ul className="docs-sidebar__list">
            {group.pages.map((page) => {
              const isCurrent = page.href === currentPath;

              return (
                <li key={page.href}>
                  <a
                    className="docs-sidebar__link"
                    href={page.href}
                    aria-current={isCurrent ? 'page' : undefined}
                  >
                    <JackBullet variant={page.role} />
                    <span>{page.title}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );

  return (
    <>
      <div className="docs-index docs-index--desktop">{navigation}</div>
      <details className="docs-index docs-index--mobile" inert={!hydrated}>
        <summary className="docs-index__summary">
          <JackBullet variant="neutral" />
          <span>INDEX</span>
        </summary>
        {navigation}
      </details>
    </>
  );
}
