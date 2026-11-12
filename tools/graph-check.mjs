#!/usr/bin/env node
// Visual checks for the v2 graph ("unit tests for looking good"): headless Chromium over the DevTools protocol, no npm packages.
// For every look × every label level × phone (375×812) and desktop (1440×900): one screenshot + counted problems.
//
//   python3 -m http.server 8790 --directory <this repo>  +  python3 tools/mock-github.py <data copy> 8791
//   node tools/graph-check.mjs [--out DIR] [--url http://localhost:8790/?api=http://localhost:8791] [--chrome /snap/bin/chromium]
//
// Writes DIR/<size>-<look>-<n>-<level>.png, DIR/report.json, DIR/report.md. Exit code 1 if any look fails.
// Pass rules (per screenshot): 0 overlapping labels · 0 labels cut off · ≤ 1 label level · smallest text ≥ 10 px ·
// ≤ 15 % of dots overlapping · a zoomed-in level shows ≥ 1 label · fit view: ≤ 80 % empty screen · ≤ 1 line crossing per line.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', './graph-check-out'), URL = arg('url', 'http://localhost:8790/?api=http://localhost:8791');
const CHROME = arg('chrome', '/snap/bin/chromium'), PORT = 9300 + Math.floor(Math.random() * 500);
const SIZES = [['phone', 375, 812, 2, true], ['desktop', 1440, 900, 1, false]];
const LOOKS = (arg('looks', 'web,float,rings,tree')).split(',');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
chrome.on('error', () => null);
let page;
for (let i = 0; i < 60 && !page; i++) { await sleep(250); try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ } }
if (!page) { console.error('Chromium did not start'); try { chrome.kill(); } catch { /* snap */ } process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await js(expr).catch(() => false)) return true; await sleep(200); } throw new Error('timeout: ' + expr); };

// measured inside the page from what the last frame drew (graphView.last)
const MEASURE = `(() => {
  const v = window.graphView, p = v.last, W = v.w, H = v.h;
  const L = p.labels.filter((l) => l.level !== 'forced'), B = L.map((l) => l.box);
  let overlaps = 0; for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) { const a = B[i], b = B[j]; if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) overlaps++; }
  const cut = B.filter((b) => b[0] < 0 || b[1] < 0 || b[2] > W || b[3] > H).length;
  const D = p.dots; let dotHit = 0;
  for (let i = 0; i < D.length; i++) { for (let j = 0; j < D.length; j++) { if (i !== j && Math.hypot(D[i][0] - D[j][0], D[i][1] - D[j][1]) < 0.8 * (D[i][2] + D[j][2])) { dotHit++; break; } } }
  const C = 24, cols = Math.ceil(W / C), rows = Math.ceil(H / C), cell = new Uint8Array(cols * rows);
  const put = (x, y) => { const cx = Math.floor(x / C), cy = Math.floor(y / C); if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) cell[cy * cols + cx] = 1; };
  for (const d of D) put(d[0], d[1]);
  for (const b of B) for (let x = b[0]; x <= b[2]; x += C / 2) for (let y = b[1]; y <= b[3]; y += C / 2) put(x, y);
  for (const s of p.segs) { const n = Math.ceil(Math.hypot(s[2] - s[0], s[3] - s[1]) / 8) || 1; for (let i = 0; i <= n; i++) put(s[0] + ((s[2] - s[0]) * i) / n, s[1] + ((s[3] - s[1]) * i) / n); }
  const empty = 1 - cell.reduce((a, b) => a + b, 0) / cell.length;
  const S = p.segs, cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  let crossings = 0;
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
    const a = S[i], b = S[j]; if (a[4] === b[4] || a[4] === b[5] || a[5] === b[4] || a[5] === b[5]) continue;
    const p1 = [a[0], a[1]], p2 = [a[2], a[3]], q1 = [b[0], b[1]], q2 = [b[2], b[3]];
    if (cr(p1, p2, q1) * cr(p1, p2, q2) < 0 && cr(q1, q2, p1) * cr(q1, q2, p2) < 0) crossings++;
  }
  return { level: p.level, levels: [...p.levels].filter((l) => l !== 'forced'), labels: L.length, overlaps, cut, minFont: L.length ? Math.min(...L.map((l) => l.fs)) : null,
    dots: D.length, dotOverlap: D.length ? +(dotHit / D.length).toFixed(3) : 0, empty: +empty.toFixed(3), lines: S.length, crossings, crossPerLine: S.length ? +(crossings / S.length).toFixed(2) : 0, zoom: +p.z.toFixed(2) };
})()`;

const report = [];
try {
  for (const [size, w, h, dpr, mobile] of SIZES) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
    await cdp('Page.navigate', { url: URL });
    await until('document.readyState === "complete"');
    await js(`localStorage.setItem('stats.conn', JSON.stringify({ token: 'test', repo: 'local/data' })); localStorage.setItem('stats2.studySub', '"graph"'); true`);
    await cdp('Page.navigate', { url: URL });
    await until('!!document.querySelector("[data-tab=study]") && typeof DATA !== "undefined" && !!DATA');
    await js('document.querySelector("[data-tab=study]").click(); true');
    await until('!!(window.graphView && window.graphView.L && window.graphView.last)');
    for (const look of LOOKS) {
      const levels = await js(`window.graphView.test.look(${JSON.stringify(look)})`);
      for (let i = 0; i < levels.length; i++) {
        await js(`window.graphView.test.stage(${i}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => true)`);
        const m = await js(MEASURE);
        const fails = [];
        if (m.overlaps) fails.push(`${m.overlaps} overlapping labels`);
        if (m.cut) fails.push(`${m.cut} labels cut off`);
        if (m.levels.length > 1) fails.push(`${m.levels.length} label levels at once (${m.levels.join(', ')})`);
        if (m.minFont != null && m.minFont < 10) fails.push(`text ${m.minFont}px`);
        if (m.dotOverlap > 0.15) fails.push(`${Math.round(m.dotOverlap * 100)} % dots overlapping`);
        if (i > 0 && !m.labels) fails.push('no labels at this level');
        if (i === 0 && m.empty > 0.8) fails.push(`${Math.round(m.empty * 100)} % empty screen`);
        if (m.crossPerLine > 1) fails.push(`${m.crossPerLine} crossings per line`);
        const file = `${size}-${look}-${i}-${levels[i]}.png`;
        const shot = await cdp('Page.captureScreenshot', { format: 'png' });
        writeFileSync(`${OUT}/${file}`, Buffer.from(shot.data, 'base64'));
        report.push({ size, look, stage: i, level: levels[i], file, ...m, fails });
        console.log(`${fails.length ? '✗' : '✓'} ${size} ${look} ${i}:${levels[i]}  labels ${m.labels} · dots ${m.dots} (${Math.round(m.dotOverlap * 100)}% overl.) · empty ${Math.round(m.empty * 100)}% · lines ${m.lines}, ${m.crossings} crossings · min font ${m.minFont}${fails.length ? '  → ' + fails.join('; ') : ''}`);
      }
    }
  }
} finally {
  // snap Chromium can't be signalled from here (EACCES): ask it to quit over the protocol instead
  await cdp('Browser.close').catch(() => null); ws.close();
  try { chrome.kill(); } catch { /* already gone */ }
}

const looks = [...new Set(report.map((r) => r.look))].map((look) => ({ look, fails: report.filter((r) => r.look === look && r.fails.length).map((r) => `${r.size} ${r.level}: ${r.fails.join('; ')}`) }));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
writeFileSync(`${OUT}/report.md`, `# Graph visual check\n\n${looks.map((l) => `- **${l.look}**: ${l.fails.length ? '✗ ' + l.fails.join(' · ') : '✓ passes'}`).join('\n')}\n\n| size | look | level | labels | overlaps | cut | levels | min font | dot overlap | empty | lines | crossings |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n${report.map((r) => `| ${r.size} | ${r.look} | ${r.level} | ${r.labels} | ${r.overlaps} | ${r.cut} | ${r.levels.length} | ${r.minFont ?? '–'} | ${Math.round(r.dotOverlap * 100)} % | ${Math.round(r.empty * 100)} % | ${r.lines} | ${r.crossings} |`).join('\n')}\n`);
console.log('\n' + looks.map((l) => `${l.look}: ${l.fails.length ? 'FAIL (' + l.fails.length + ')' : 'pass'}`).join(' · '));
process.exit(looks.some((l) => l.fails.length) ? 1 : 0);
