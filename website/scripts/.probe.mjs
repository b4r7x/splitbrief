import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:5174/', { waitUntil: 'networkidle' });
const r = await p.evaluate(() => {
  const el = document.createElement('span');
  el.style.cssText = 'position:absolute;visibility:hidden;font-family:"Fragment Mono",monospace;white-space:pre;font-size:100px;line-height:normal';
  el.textContent = 'M';
  document.body.appendChild(el);
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { advance: rect.width, naturalLineHeight: rect.height, family: cs.fontFamily };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
