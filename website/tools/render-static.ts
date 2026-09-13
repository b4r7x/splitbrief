import { readFileSync, writeFileSync } from 'node:fs';
import { glyphFor } from '../src/features/diagram/atlas';
import { density } from '../src/features/diagram/density';
import { SEATS, type Seat } from '../src/features/diagram/seats';

function frameZero(seat: Seat): string {
  const rows: string[] = [];
  for (let r = 0; r < seat.rows; r++) {
    let row = '';
    for (let c = 0; c < seat.cols; c++) row += glyphFor(density(seat, c, r, 0));
    rows.push(row.trimEnd());
  }
  return rows.join('\n');
}

if (process.argv.includes('--write')) {
  const path = new URL('../index.html', import.meta.url);
  let html = readFileSync(path, 'utf8');
  for (const [name, seat] of Object.entries(SEATS)) {
    const fallback = new RegExp(
      `(class="ghost ghost--${name}"[^]*?<pre class="ghost-fallback"[^>]*>)[^]*?(</pre>)`,
    );
    html = html.replace(
      fallback,
      (_, open: string, close: string) => `${open}\n${frameZero(seat)}\n${close}`,
    );
  }
  writeFileSync(path, html);
} else {
  for (const [name, seat] of Object.entries(SEATS)) {
    console.log(`--- ${name} (${seat.cols}x${seat.rows})\n${frameZero(seat)}`);
  }
}
