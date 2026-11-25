// Headless smoke test (2026-11-25, decisions "Outsider 2026-11"): free, no AI. Drives the Chromium that run by smoke.sh via CDP:
// loads the app against the mock GitHub, clicks every tab + the 🤖 sheet at phone width, fails on JS errors, console errors,
// horizontal overflow or an empty tab. Screenshots → $OUT/*.png (the outsider looks at them).
import { writeFileSync } from 'node:fs';
const [, , CDP, APP, API, OUT] = process.argv;
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(), errors = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).split('\n')[0]);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console.error: ' + d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 160));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, 'base64')); };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: APP }); await sleep(800);
await ev(`localStorage.clear(); localStorage.setItem('stats.conn', JSON.stringify({token:'smoke-test',repo:'test/data'})); true`);
await send('Page.navigate', { url: `${APP}/?api=${API}` }); await sleep(4000);
const fails = [];
const check = async (where) => {
  const r = await ev(`({ over: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText.length, sheetOver: (() => { const s = document.querySelector('.sheet-in'); return s ? s.scrollWidth > s.clientWidth + 1 : false; })() })`);
  if (!r) { fails.push(`${where}: page didn't answer`); return; }
  if (r.over) fails.push(`${where}: wider than the screen`);
  if (r.sheetOver) fails.push(`${where}: sheet wider than the screen`);
  if (r.text < 40) fails.push(`${where}: looks empty`);
};
const status = await ev(`document.querySelector('#status')?.innerText || ''`);
if (/error|fail|401|403|404/i.test(status)) fails.push('status line: ' + status.slice(0, 120));
for (const tab of ['today', 'stats', 'study', 'notes', 'home']) {
  await ev(`document.querySelector('[data-tab="${tab}"]')?.click(); true`); await sleep(900);
  await check(tab); await shot(tab);
}
await ev(`document.querySelector('[data-tab="today"]').click(); true`); await sleep(500);
await ev(`document.querySelector('#open-agent')?.click(); true`); await sleep(700);
await check('🤖 sheet'); await shot('agent-sheet');
await ev(`document.querySelector('[data-close]')?.click(); true`);
const all = [...errors.map((e) => 'JS ' + e), ...fails];
console.log(all.length ? '❌ smoke test failed:\n- ' + all.join('\n- ') : `✅ smoke test passed (5 tabs + 🤖 sheet, 390 px, screenshots in ${OUT})`);
ws.close(); process.exit(all.length ? 1 : 0);
