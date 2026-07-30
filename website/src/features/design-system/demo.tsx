import { BorderedFrame } from '../../components/bordered-frame.js';
import { JackBullet } from '../../components/jack-bullet.js';
import { PanelStrip } from '../../components/panel-strip.js';

type ThemeName = 'dark' | 'light';

interface ThemeFaceProps {
  theme: ThemeName;
}

const DECORATIVE_ROWS = [
  ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
  ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'],
] as const;

function DecorativeField() {
  return (
    <div className="border-y border-grid-decorative bg-ground px-3 py-4">
      <p className="m-0 font-mono text-xs text-dim">DECORATIVE ALIGNMENT FIELD</p>
      <div
        aria-hidden="true"
        className="mt-3 grid grid-cols-8 border-l border-t border-grid-decorative"
      >
        {DECORATIVE_ROWS.flat().map((cell) => (
          <span className="h-5 border-b border-r border-grid-decorative" key={cell} />
        ))}
      </div>
    </div>
  );
}

function RoutingGrid({ theme }: Readonly<ThemeFaceProps>) {
  return (
    <table className="w-full border-collapse font-mono text-xs">
      <caption className="bg-surface-2 px-3 py-3 text-left font-display font-semibold uppercase tracking-[0.14em]">
        Functional routing grid
      </caption>
      <thead>
        <tr>
          <th className="border border-grid-functional p-3 text-left" scope="col">
            Port
          </th>
          <th className="border border-grid-functional p-3 text-left" scope="col">
            Jack role
          </th>
          <th className="border border-grid-functional p-3 text-left" scope="col">
            Circuit state
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th className="border border-grid-functional p-3 text-left" scope="row">
            P-01
          </th>
          <td className="border border-grid-functional p-3 text-planner-text">
            <span className="inline-flex items-center gap-2">
              <JackBullet variant="planner" />
              Planner
            </span>
          </td>
          <td className="border border-grid-functional p-3">Armed</td>
        </tr>
        <tr>
          <th className="border border-grid-functional p-3 text-left" scope="row">
            B-01
          </th>
          <td className="border border-grid-functional p-3">
            <span className="inline-flex items-center gap-2">
              <JackBullet variant="neutral" />
              Task Brief
            </span>
          </td>
          <td className="border border-grid-functional p-3">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="size-3 rounded-full bg-pin" />
              Pin seated
            </span>
          </td>
        </tr>
        <tr>
          <th className="border border-grid-functional p-3 text-left" scope="row">
            I-01
          </th>
          <td className="border border-grid-functional p-3 text-implementer">
            <span className="inline-flex items-center gap-2">
              <JackBullet variant="implementer" />
              Implementer
            </span>
          </td>
          <td className="border border-grid-functional p-3">Ready</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td className="border border-grid-functional p-3 text-dim" colSpan={3}>
            {theme === 'dark' ? 'LANDING / DARK CIRCUIT' : 'DOCS / LIGHT CIRCUIT'}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function ThemeFace({ theme }: Readonly<ThemeFaceProps>) {
  const light = theme === 'light';
  const faceName = light ? 'Light docs' : 'Dark landing';
  const outputId = `design-system-${theme}-output`;

  return (
    <article
      aria-label={`${faceName} token tier`}
      className={
        light
          ? 'docs-shell min-w-0 border-grid-functional bg-ground text-fg'
          : 'landing-shell min-w-0 border-grid-functional bg-ground text-fg'
      }
      data-theme={theme}
    >
      <PanelStrip legend={`${faceName} face`} tone="neutral">
        <div className="bg-surface-1 p-4 sm:p-6">
          <div className="flex flex-col justify-between gap-4 border-b border-grid-functional pb-5 sm:flex-row sm:items-end">
            <div>
              <p className="m-0 font-display text-sm font-semibold uppercase tracking-[0.14em]">
                Ground / surface 01
              </p>
              <p className="mt-2 text-dim">
                The Task Brief carries the signal from{' '}
                <span className="text-planner-text">planner</span> to{' '}
                <span className="text-implementer">implementer</span>.
              </p>
            </div>
            <a
              className="inline-link inline-flex min-h-11 items-center self-start border border-grid-functional px-3 font-mono text-sm sm:self-auto"
              href={`#${outputId}`}
            >
              Trace {theme} output
            </a>
          </div>

          <DecorativeField />

          <div className="bg-surface-2 p-3 sm:p-5">
            <p className="m-0 font-display text-sm font-semibold uppercase tracking-[0.14em]">
              Surface 02 / patch field
            </p>
            <div className="mt-4 overflow-x-auto">
              <RoutingGrid theme={theme} />
            </div>

            <BorderedFrame
              actions={
                <a className="inline-link" href="#design-system-title">
                  Return to bench
                </a>
              }
              className="mt-5"
              id={outputId}
              label="Product phase rail / Fragment Mono"
            >
              <pre className="m-0 p-4">
                <code className="whitespace-normal">Spec › Plan › Briefs → Build → Verify</code>
              </pre>
            </BorderedFrame>
          </div>
        </div>
      </PanelStrip>
    </article>
  );
}

export function DesignSystemDemo() {
  return (
    <main className="min-h-svh bg-ground text-fg">
      <header className="border-b border-grid-functional bg-surface-1 px-4 py-8 sm:px-8">
        <p className="m-0 font-mono text-xs text-implementer">INTERNAL / P2 / TOKEN CALIBRATION</p>
        <h1 className="mt-3" id="design-system-title">
          Instrument-face calibration bench
        </h1>
        <p className="mt-4 text-dim">
          Compare both circuits in place. Press <kbd>Tab</kbd> to inspect the focus ring.
        </p>
      </header>
      <div className="grid xl:grid-cols-2">
        <ThemeFace theme="dark" />
        <ThemeFace theme="light" />
      </div>
    </main>
  );
}
