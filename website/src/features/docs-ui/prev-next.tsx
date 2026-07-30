import type { DocsNeighbour } from './navigation.js';
import './prev-next.css';

export type DocsPrevNextProps = {
  readonly next: DocsNeighbour | undefined;
  readonly previous: DocsNeighbour | undefined;
};

export function DocsPrevNext({ next, previous }: DocsPrevNextProps) {
  if (!previous && !next) {
    return null;
  }

  return (
    <nav className="docs-prev-next" aria-label="Adjacent documentation">
      {previous ? (
        <a className="docs-prev-next__link docs-prev-next__link--previous" href={previous.href}>
          <span className="docs-prev-next__direction" aria-hidden="true">
            ← Previous
          </span>
          <span>{previous.title}</span>
        </a>
      ) : null}

      {next ? (
        <a className="docs-prev-next__link docs-prev-next__link--next" href={next.href}>
          <span className="docs-prev-next__direction" aria-hidden="true">
            Next →
          </span>
          <span>{next.title}</span>
        </a>
      ) : null}
    </nav>
  );
}
