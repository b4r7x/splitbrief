import { DOCS_HOME_PATH } from '../../docs-home-path.js';
import { Wordmark } from './wordmark.js';
import './metadata-surfaces.css';

const MATRIX_AXIS_SIZE = 6;
const SELECTED_ROW = 2;
const SELECTED_COLUMN = 3;

const OG_MATRIX_CELLS = Array.from({ length: MATRIX_AXIS_SIZE ** 2 }, (_, index) => {
  const row = Math.floor(index / MATRIX_AXIS_SIZE);
  const column = index % MATRIX_AXIS_SIZE;

  return {
    id: `${row}-${column}`,
    isColumnActive: column === SELECTED_COLUMN,
    isRowActive: row === SELECTED_ROW,
    isSelected: row === SELECTED_ROW && column === SELECTED_COLUMN,
  };
});

export function NotFoundSurface() {
  return (
    <main className="landing-shell metadata-surface metadata-not-found" data-theme="dark">
      <div className="metadata-not-found__face">
        <header className="metadata-face-rail">
          <span>Open circuit</span>
          <span className="metadata-face-rail__rule" aria-hidden="true" />
          <span>HTTP 404</span>
        </header>

        <section className="metadata-not-found__body" aria-labelledby="not-found-title">
          <div className="metadata-not-found__copy">
            <Wordmark />
            <p className="metadata-eyebrow">Route / unpatched</p>
            <h1 id="not-found-title">No signal at this address.</h1>
            <p className="metadata-not-found__description">
              This path does not resolve to a published SPLITBRIEF page. Return to the patch field
              or open the documentation.
            </p>
            <nav aria-label="Recovery" className="metadata-not-found__links">
              <a className="inline-link" href="/">
                [ home ]
              </a>
              <a className="inline-link" href={DOCS_HOME_PATH}>
                [ docs ]
              </a>
            </nav>
          </div>

          <div className="metadata-open-circuit" aria-hidden="true">
            <span className="metadata-open-circuit__label metadata-open-circuit__label--planner">
              Planner
            </span>
            <span className="metadata-open-circuit__jack metadata-open-circuit__jack--planner" />
            <span className="metadata-open-circuit__lead metadata-open-circuit__lead--planner" />
            <span className="metadata-open-circuit__gap" />
            <span className="metadata-open-circuit__lead metadata-open-circuit__lead--implementer" />
            <span className="metadata-open-circuit__jack metadata-open-circuit__jack--implementer" />
            <span className="metadata-open-circuit__label metadata-open-circuit__label--implementer">
              Implementer
            </span>
          </div>
        </section>

        <footer className="metadata-face-footer" aria-hidden="true">
          <span>Planner</span>
          <span>No route</span>
          <span>Implementer</span>
        </footer>
      </div>
    </main>
  );
}

export function OpenGraphSurface() {
  return (
    <main
      className="landing-shell metadata-surface metadata-og"
      data-theme="dark"
      aria-labelledby="og-title"
    >
      <div className="metadata-og__face">
        <header className="metadata-og__header">
          <Wordmark />
          <p>Planner / Task Brief / Implementer</p>
        </header>

        <div className="metadata-og__body">
          <div className="metadata-og__copy">
            <p className="metadata-eyebrow">Patch field / signal path</p>
            <h1 id="og-title">Patch your planner into your implementer.</h1>
            <p>The Task Brief is the signal between them.</p>
          </div>

          <div className="metadata-matrix-motif" aria-hidden="true">
            <p>Planner × implementer</p>
            <div className="metadata-matrix-motif__grid">
              {OG_MATRIX_CELLS.map((cell) => (
                <span
                  className={[
                    'metadata-matrix-motif__cell',
                    cell.isRowActive ? 'metadata-matrix-motif__cell--row' : '',
                    cell.isColumnActive ? 'metadata-matrix-motif__cell--column' : '',
                    cell.isSelected ? 'metadata-matrix-motif__cell--selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  key={cell.id}
                >
                  <span className="metadata-matrix-motif__jack" />
                </span>
              ))}
            </div>
          </div>
        </div>

        <footer className="metadata-og__footer" aria-hidden="true">
          <span>Planner</span>
          <span className="metadata-og__footer-line metadata-og__footer-line--planner" />
          <span>Task Brief</span>
          <span className="metadata-og__footer-line metadata-og__footer-line--implementer" />
          <span>Implementer</span>
        </footer>
      </div>
    </main>
  );
}
