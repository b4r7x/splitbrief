export const REPORT_CSS = `
:root {
  color-scheme: dark;
  --bg: #0a0a0a;
  --panel: #141414;
  --panel-2: #1e1e1e;
  --text: #e0e0e0;
  --muted: #8c8c8c;
  --accent: #00bcd4;
  --success: #5bd46f;
  --warning: #ffd166;
  --danger: #ff6b6b;
  --border: #2a2a2a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
main {
  width: min(800px, calc(100% - 32px));
  margin: 0 auto;
  padding: 36px 0;
}
a { color: var(--accent); }
.report-header, .report-section, .footer {
  border-left: 3px solid var(--accent);
  background: var(--panel);
  padding: 18px 20px;
  margin-bottom: 16px;
}
.report-section { background: var(--panel-2); }
.logo {
  color: var(--success);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
}
h1, h2, p { margin: 0; }
h1 {
  margin-top: 6px;
  font-size: 24px;
  line-height: 1.25;
}
h2 {
  margin-bottom: 10px;
  color: var(--text);
  font-size: 16px;
}
.muted { color: var(--muted); }
.hero {
  color: var(--success);
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
}
.hero-subtext { margin-top: 6px; color: var(--muted); }
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  border-bottom: 1px solid var(--border);
  padding: 8px 0;
  text-align: left;
  vertical-align: top;
}
th {
  width: 34%;
  color: var(--muted);
  font-weight: 400;
}
.badge {
  display: inline-block;
  margin: 4px 8px 0 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
  background: #101010;
}
.success { color: var(--success); }
.warning { color: var(--warning); }
.danger { color: var(--danger); }
.score {
  display: inline-block;
  min-width: 54px;
  margin-right: 8px;
  border-radius: 4px;
  padding: 2px 6px;
  background: #101010;
  text-align: center;
  font-weight: 700;
}
.phase-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.phase-row {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) 3fr 70px;
  gap: 10px;
  align-items: center;
}
.phase-track {
  height: 9px;
  overflow: hidden;
  border-radius: 999px;
  background: #0f0f0f;
}
.phase-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
}
.footer {
  color: var(--muted);
  font-size: 12px;
}
`;
