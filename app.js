// Stats: reads a private repo straight from GitHub (token stays on this device) and parses it here.
// log.js adds the quick-logs that write back to the repo.
// Everything personal (file paths, goals, time zone) lives in stats.json inside that repo, not in this code.

const LS = {
  get(k, d) { try { const v = localStorage.getItem('stats.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stats.' + k, JSON.stringify(v)); } catch { /* full or blocked: skip cache */ } },
  remove(k) { try { localStorage.removeItem('stats.' + k); } catch { /* ignore */ } },
};

// ---------- theme (glass = default, classic = the original look; picked in ⚙) ----------
const THEME_COLOR = { glass: '#0b0c14', classic: '#0e1113' };
const theme = () => LS.get('theme', 'glass');
function applyTheme() {
  document.documentElement.dataset.theme = theme();
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', THEME_COLOR[theme()] || THEME_COLOR.glass);
}
applyTheme();

const H = 3600e3;
let CFG = {}; // loaded from stats.json in the data repo
const BUDGET = () => CFG.budget, PROTEIN_GOAL = () => CFG.proteinGoal, KCAL_GOAL = () => CFG.kcalGoal, FLOSS_START = () => CFG.flossStart || '0000', MOUTH_START = () => CFG.mouthStart || '0000';
const F = (k) => CFG.files[k];

// ---------- dates ----------
let fmtKey;
const dayKey = (ms) => fmtKey.format(new Date(ms - (CFG.dayStartHour || 0) * H));
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const span = (from, to) => { const out = []; for (let k = from; k <= to; k = addDays(k, 1)) out.push(k); return out; };
const short = (key) => new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);

// ---------- GitHub (ETag cache: unchanged files cost almost no data) ----------
async function gh(path, json = false) {
  const { token, repo } = LS.get('conn', {});
  const cached = LS.get('cache:' + path, null);
  const headers = { Authorization: 'Bearer ' + token, Accept: json ? 'application/vnd.github+json' : 'application/vnd.github.raw+json' };
  if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=main`, { headers, cache: 'no-store' });
  if (res.status === 304 && cached) return cached.body;
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error('auth');
  if (!res.ok) throw new Error('GitHub ' + res.status);
  const body = await res.text();
  LS.set('cache:' + path, { etag: res.headers.get('ETag'), body });
  return body;
}

async function ghRaw(path) {
  const { token, repo } = LS.get('conn', {});
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=main`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
  if (res.status === 401 || res.status === 403) throw new Error('auth');
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return res.text();
}

// ---------- parsers ----------
function csv(text) {
  if (!text) return [];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function mdTable(text, after) {
  // rows of the first markdown table after the heading `after` (or every table row if no heading)
  let t = text || '';
  if (after) { const i = t.indexOf(after); if (i < 0) return []; t = t.slice(i + after.length); const j = t.search(/\n#{1,3} /); if (j >= 0) t = t.slice(0, j); }
  return t.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l))
    .map((l) => l.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim()));
}

const strip = (s) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();

function studyTime(timeFiles, tagsText) {
  const tags = {};
  for (const r of csv(tagsText)) tags[r.session] = r.tag || 'study';
  const bySession = {};
  for (const text of timeFiles) for (const r of csv(text)) {
    const t = Date.parse(r.ts); if (!r.session || isNaN(t)) continue;
    (bySession[r.session] ||= []).push([t, r.event]);
  }
  const out = {};
  for (const [sid, evs] of Object.entries(bySession)) {
    const tag = tags[sid] || 'study';
    if ((CFG.skipTags || []).includes(tag)) continue;
    evs.sort((a, b) => a[0] - b[0]);
    let paused = false;
    evs.forEach(([t, ev], i) => {
      const d = (out[dayKey(t)] ||= { study: 0, chat: 0 });
      if (i === 0) { paused = ev === 'brb'; return; }
      if (paused && (ev === 'prompt' || ev === 'brb')) { paused = ev === 'brb'; return; }
      paused = paused || ev === 'brb';
      const gap = t - evs[i - 1][0];
      if (gap < 20 * 60e3) d[tag === (CFG.chatTag || 'chat') ? 'chat' : 'study'] += gap / 60e3;
    });
  }
  return out;
}

function dayLog(text) {
  const life = (text.split('## Life')[1] || '').split('\n## ')[0];
  const r = { floss: false, gym: false, run: false, asleep: null };
  const no = /\b(no|plan|skipped|skip)\b/i;
  for (const line of life.split('\n')) {
    if (line.includes('🦷') && !/\bnot?\b|didn/i.test(line)) r.floss = true;
    if (line.includes('🪥') && !/\bnot?\b|didn/i.test(line)) { if (/\bAM\b|morning/i.test(line)) r.brushAm = true; if (/\bPM\b|evening|night/i.test(line)) r.brushPm = true; }
    if (line.includes('🏋') && !no.test(line.split('·')[0])) r.gym = true;
    if (line.includes('🏃') && /\d+(\.\d+)? ?km/.test(line) && !no.test(line.split('·')[0])) r.run = true;
    if (/^\s*-\s*😴/u.test(line) && !/^\s*-\s*😴\s*(Woke|Plan)/u.test(line)) {
      const t = [...line.matchAll(/(?:really|actually) asleep ~?(\d{1,2}:\d{2})/g)];
      const u = t.length ? t : [...line.matchAll(/(?:Asleep|Went to bed)\s*~?(\d{1,2}:\d{2})/g)];
      if (u.length) r.asleep = u[u.length - 1][1].padStart(5, '0');
    }
  }
  // streak (same rule as the daily update): "Streak: earned|frozen|not earned" in ## Study; no such line → earned if ## Study isn't empty
  const study = (text.split('## Study')[1] || '').split('\n## ')[0];
  const marks = [...study.matchAll(/Streak:\W*(earned|frozen|not earned)/gi)].map((m) => m[1].toLowerCase());
  r.streak = marks.includes('earned') ? 'earned' : marks.includes('frozen') ? 'frozen' : marks.length ? 'no' : study.trim() ? 'earned' : 'no';
  return r;
}

// one row of log/habits.csv (date,time,habit,value) into a day; the today bar uses it for unsaved rows too
const CHORES = { dishes: '🍽️ Dishes', trash: '🗑️ Trash', floor: '🧹 Floor', laundry: '🧺 Laundry' };
function habitInto(d, r) {
  const h = r.habit;
  if (h === 'floss') d.floss = true;
  else if (h === 'brush_am') d.brushAm = true;
  else if (h === 'brush_pm') d.brushPm = true;
  else if (h === 'mouthwash') d.mouthwash = true;
  else if (h === 'shower') d.showers = (d.showers || 0) + 1;
  else if (h === 'caffeine') { d.caffeine = (d.caffeine || 0) + 1; d.cafTimes = [...(d.cafTimes || []), r.time]; }
  else if (h === 'asleep' && r.value) d.asleep = r.value;
  else if (h === 'awake' && r.value) d.awake = r.value;
  else if ((h === 'mood' || h === 'energy') && Number(r.value)) d[h] = Number(r.value);
  else if (CHORES[h]) d.chores = [...new Set([...(d.chores || []), h])];
}
const mouthCount = (d) => (d?.brushAm ? 1 : 0) + (d?.brushPm ? 1 : 0) + (d?.floss ? 1 : 0);
const mouthDone = (d) => mouthCount(d) === 3;
window.habitInto = habitInto; window.mouthCount = mouthCount;

const sleepHours = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return (h < 12 ? h + 24 : h) + m / 60; };
const fmtClock = (x) => `${String(Math.floor(x) % 24).padStart(2, '0')}:${String(Math.round((x % 1) * 60) % 60).padStart(2, '0')}`;

// ---------- load everything ----------
async function load(range) {
  const cfgText = await gh('stats.json');
  if (!cfgText) {
    // 404 also means "this token can't see the repo": tell those apart
    const { token, repo } = LS.get('conn', {});
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
    throw new Error(r.ok ? `no stats.json in ${repo}` : `token can't see ${repo}: check the token's repository access + Contents: Read`);
  }
  CFG = JSON.parse(cfgText);
  fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: CFG.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = dayKey(Date.now());
  const listing = JSON.parse(await gh(F('logDir'), true) || '[]');
  const names = listing.map((f) => f.name);
  // every day log is needed for the streak; only files whose blob sha changed get downloaded, the parsed result is cached
  const logFiles = listing.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name));
  const timeNames = names.filter((n) => /^time-.*\.csv$/.test(n) && F('logDir') + '/' + n !== F('timeTags'));

  const [ratings, food, tags, deadlineText, money, tx, weightText, gymText, runText, habitText, spendText, pianoText, ...rest] = await Promise.all([
    gh(F('ratings')), gh(F('food')), gh(F('timeTags')),
    gh(F('deadlines')), gh(F('money')), gh(F('transactions')),
    gh(F('weight')), gh(F('gym')), gh(F('runs')), gh(F('habits')), gh(F('spend')), F('piano') ? gh(F('piano')) : null,
    ...timeNames.map((n) => gh(F('logDir') + '/' + n)),
  ]);
  const timeFiles = rest;
  // daily update (written by Claude as JSON) + its archive
  let update = null, updateDates = [];
  if (F('update')) {
    const [u, arch] = await Promise.all([gh(F('update')), gh(F('updateArchive'), true)]);
    try { update = u ? JSON.parse(u) : null; } catch { update = null; }
    try { updateDates = JSON.parse(arch || '[]').map((f) => f.name).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 10)).sort(); } catch { /* none yet */ }
  }
  const parsedLogs = await Promise.all(logFiles.map(async (f) => {
    const c = LS.get('log:' + f.name, null);
    if (c && c.sha === f.sha) return c.r;
    const r = dayLog(await ghRaw(F('logDir') + '/' + f.name));
    LS.set('log:' + f.name, { sha: f.sha, r });
    return r;
  }));

  const days = {};
  const day = (k) => (days[k] ||= { kcal: 0, protein: 0, meals: 0 });
  for (const r of csv(ratings)) Object.assign(day(r.date), { score: Number(r.score), final: r.final === 'final', why: r.why });
  for (const r of csv(food)) { const d = day(r.date); d.kcal += Number(r.kcal) || 0; d.protein += Number(r.protein_g) || 0; d.meals++; }
  for (const [k, v] of Object.entries(studyTime(timeFiles, tags))) Object.assign(day(k), v);
  logFiles.forEach((f, i) => Object.assign(day(f.name.slice(0, 10)), parsedLogs[i], { logged: true }));

  // app logs (CSV) count the same as the day logs
  const gym = csv(gymText), runs = csv(runText);
  for (const r of gym) day(r.date).gym = true;
  for (const r of runs) day(r.date).run = true;
  const piano = csv(pianoText);
  for (const r of piano) day(r.date).piano = (day(r.date).piano || 0) + (Number(r.minutes) || 0);
  const habits = csv(habitText), spendLog = csv(spendText);
  for (const r of habits) habitInto(day(r.date), r);
  const weightRows = csv(weightText);
  const weights = weightRows.filter((r) => r.kg).map((r) => ({ date: r.date, kg: Number(r.kg), note: r.note || '' }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const deadlines = mdTable(deadlineText).map((c) => ({ c, m: (c[0] || '').match(/(\d{4}-\d{2}-\d{2})/) }))
    .filter(({ c, m }) => m && c.length >= 5 && m[1] >= today && !/✅|\bdone\b/.test(c[c.length - 1]))
    .map(({ c, m }) => ({ date: m[1], item: strip(c[1]).split(/ · |\(/)[0].trim(), course: strip(c[2]) }));

  // spending: imported bank rows (CSV), then hand-logged markdown rows dated after the last import
  const SKIP = /^(Own transfer|Investing|Income|Private transfers in)/;
  const spends = [];
  let lastImport = '';
  for (const r of csv(tx)) { lastImport = r.date > lastImport ? r.date : lastImport; const e = Number(r.eur); if (e < 0 && !SKIP.test(r.category)) spends.push({ date: r.date, what: r.what, cat: r.category, eur: -e }); }
  for (const c of mdTable(money)) if (/^\d{4}-\d{2}-\d{2}$/.test(c[0]) && c.length >= 5 && c[0] > lastImport) {
    const e = Number(c[4].replace(/[^\d.]/g, '')) * (/^\s*[+−-]/.test(c[4]) ? -1 : 1); // "+€" = money back
    if (e) spends.push({ date: c[0], what: strip(c[1]), cat: strip(c[3]), eur: e });
  }
  for (const r of spendLog) if (r.date > lastImport && Number(r.eur)) spends.push({ date: r.date, what: r.what, cat: r.category, eur: Number(r.eur) });

  return { today, update, updateDates, days, weights, deadlines, spends, gym, runs, piano, habits, spendLog, weightRows, cfg: CFG, fetched: Date.now() };
}

// ---------- tiny charts ----------
// glass theme: the flat colours become gradients (+ a glow from style.css)
const GLASS_PAINT = { 'var(--accent)': 'url(#g-accent)', 'var(--good)': 'url(#g-good)', 'var(--warn)': 'url(#g-warn)', 'var(--bad)': 'url(#g-bad)' };
const GLASS_DEFS = `<defs>${[['accent', '#22d3ee', '#8b5cf6'], ['good', '#5eead4', '#22d3ee'], ['warn', '#fde68a', '#f59e0b'], ['bad', '#fda4af', '#f43f5e']]
  .map(([id, a, b]) => `<linearGradient id="g-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`).join('')}</defs>`;
function bars(values, { max, min = 0, ref, cls, hollow } = {}) {
  const W = 300, Hh = 60, n = values.length, top = max ?? Math.max(1, ...values.filter((v) => v != null), ref || 0);
  const bw = W / n, y = (v) => Hh - ((v - min) / (top - min)) * (Hh - 4);
  const glass = theme() === 'glass', paint = (c) => (glass && GLASS_PAINT[c]) || c, rx = glass ? Math.min(4, bw * 0.3) : 2;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${Hh + 10}" preserveAspectRatio="none" role="img">${glass ? GLASS_DEFS : ''}`;
  values.forEach((v, i) => {
    const x = i * bw + bw * 0.15, w = Math.max(1, bw * 0.7);
    s += `<rect data-i="${i}" x="${i * bw}" y="0" width="${bw}" height="${Hh}" fill="transparent"/>`;
    if (v == null) { s += `<rect x="${x}" y="${Hh - 1}" width="${w}" height="1" fill="var(--line)"/>`; return; }
    const c = cls ? cls(v, i) : 'var(--accent)', yy = Math.min(y(v), Hh - 2);
    s += hollow && hollow(i)
      ? `<rect pointer-events="none" x="${x + .75}" y="${yy}" width="${w - 1.5}" height="${Hh - yy}" rx="${rx}" fill="none" stroke="${c}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
      : `<rect class="bar" style="animation-delay:${Math.min(i, 30) * 25}ms" pointer-events="none" x="${x}" y="${yy}" width="${w}" height="${Hh - yy}" rx="${rx}" fill="${paint(c)}"/>`;
  });
  if (ref != null) s += `<line x1="0" x2="${W}" y1="${y(ref)}" y2="${y(ref)}" stroke="var(--muted)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`;
  return s + '</svg>';
}

// ---------- streak ----------
// earned days count, frozen days keep the streak alive without adding to it, anything else breaks it; today joins once earned
const stOf = (days, k) => days[k]?.streak || 'no';
function streakInfo(days, today) {
  let cur = 0;
  for (let k = addDays(today, -1); stOf(days, k) !== 'no'; k = addDays(k, -1)) if (stOf(days, k) === 'earned') cur++;
  if (stOf(days, today) === 'earned') cur++;
  const first = Object.keys(days).filter((k) => days[k].logged).sort()[0] || today;
  let best = 0, run = 0;
  for (const k of span(first, today)) {
    const st = stOf(days, k);
    if (st === 'earned') best = Math.max(best, ++run);
    else if (st === 'no' && k !== today) run = 0;
  }
  // golden week = Mon–Sun all earned (frozen doesn't count)
  const mon = (k) => addDays(k, -((new Date(k + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const golden = (ks) => ks.every((k) => k <= today && stOf(days, k) === 'earned');
  let weeks = 0;
  for (let m = mon(first); addDays(m, 6) <= today; m = addDays(m, 7)) if (golden(span(m, addDays(m, 6)))) weeks++;
  return { cur, best, weeks, first, mon, golden, today: stOf(days, today) === 'earned' };
}
window.streakInfo = streakInfo;
let calMonth = null; // month shown in the streak calendar (YYYY-MM)

// ---------- cards ----------
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const sign = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const CARDS = [
  { id: 'streak', title: 'Study streak', render(x) {
    const s = streakInfo(x.days, x.today);
    const month = (calMonth ||= x.today.slice(0, 7));
    const m1 = month + '-01', dim = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
    const mEnd = month + '-' + String(dim).padStart(2, '0');
    const goldMonth = mEnd <= x.today && s.golden(span(m1, mEnd));
    const live = (k) => stOf(x.days, k) !== 'no';
    let rows = '';
    for (let w = s.mon(m1); w <= mEnd; w = addDays(w, 7)) {
      const ks = span(w, addDays(w, 6));
      rows += `<div class="cal-row${s.golden(ks) ? ' gold' : ''}">` + ks.map((k, i) => {
        if (k.slice(0, 7) !== month) return '<span class="cal-day out"></span>';
        const st = stOf(x.days, k);
        const cls = k > x.today ? 'future' : k < s.first ? 'pre' : st === 'earned' ? 'on' : st === 'frozen' ? 'frz' : k === x.today ? 'open' : 'off';
        const band = (st !== 'no' && k <= x.today) ? (i > 0 && live(ks[i - 1]) && ks[i - 1].slice(0, 7) === month ? ' jl' : '') + (i < 6 && live(ks[i + 1]) && ks[i + 1] <= x.today && ks[i + 1].slice(0, 7) === month ? ' jr' : '') : '';
        return `<button class="cal-day ${cls}${band}${k === x.today ? ' now' : ''}" data-k="${k}">${Number(k.slice(8))}</button>`;
      }).join('') + '</div>';
    }
    const title = new Date(m1 + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const label = { earned: '🔥 earned', frozen: '🧊 frozen', no: 'not earned' };
    return { big: `<span class="${s.cur ? 'fire' : ''}">🔥 ${s.cur}</span>`, unit: `day${s.cur === 1 ? '' : 's'}`,
      sub: `best ${s.best} · golden weeks ${s.weeks}` + (s.today ? ' · <span class="good">today ✓</span>' : ' · today still open'),
      html: `<div class="cal">
        <div class="cal-head"><button class="cal-nav" data-nav="-1" aria-label="Previous month" ${month <= s.first.slice(0, 7) ? 'disabled' : ''}>‹</button>
          <b class="${goldMonth ? 'gold-t' : ''}">${goldMonth ? '👑 ' : ''}${title}</b>
          <button class="cal-nav" data-nav="1" aria-label="Next month" ${month >= x.today.slice(0, 7) ? 'disabled' : ''}>›</button></div>
        <div class="cal-row dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>${rows}</div><div class="detail"></div>`,
      wire(el) {
        const det = el.querySelector('.detail');
        det.textContent = `${short(x.today)}: ${label[stOf(x.days, x.today)]}`;
        el.querySelectorAll('.cal-day[data-k]').forEach((b) => b.addEventListener('click', () => {
          const k = b.dataset.k;
          det.textContent = k > x.today ? `${short(k)}: still ahead` : k < s.first ? `${short(k)}: before tracking` : `${short(k)}: ${label[stOf(x.days, k)]}`;
        }));
        el.querySelectorAll('.cal-nav').forEach((b) => b.addEventListener('click', () => {
          const d = new Date(month + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Number(b.dataset.nav));
          calMonth = d.toISOString().slice(0, 7); render();
        }));
      } };
  } },
  { id: 'score', title: 'Day score', render(x) {
    const s = x.dates.map((k) => x.days[k]?.score ?? null);
    const v = s.filter((n) => n != null), p = x.prev.map((k) => x.days[k]?.score).filter((n) => n != null);
    const a = avg(v), pa = avg(p);
    return { big: a == null ? '—' : a.toFixed(1), unit: '/10',
      sub: `${v.length} rated day${v.length === 1 ? '' : 's'}` + (a != null && pa != null ? ` · <span class="${a >= pa ? 'good' : 'bad'}">${sign(a - pa)} vs before</span>` : ''),
      chart: bars(s, { max: 10, hollow: (i) => !x.days[x.dates[i]]?.final }),
      tap: (i) => { const d = x.days[x.dates[i]]; return d?.score != null ? `${short(x.dates[i])}: ${d.score}/10${d.final ? '' : ' (provisional)'} · ${d.why}` : `${short(x.dates[i])}: not rated`; } };
  } },
  { id: 'study', title: 'Study time', render(x) {
    const m = x.dates.map((k) => (x.days[k]?.study ? x.days[k].study : null));
    const tot = sum(m.filter(Boolean)) / 60, prev = sum(x.prev.map((k) => x.days[k]?.study || 0)) / 60;
    return { big: tot.toFixed(1), unit: 'h',
      sub: x.prev.length ? `<span class="${tot >= prev ? 'good' : 'bad'}">${sign(tot - prev)} h vs before</span> · best day ${(Math.max(0, ...m.filter(Boolean)) / 60).toFixed(1)} h` : `best day ${(Math.max(0, ...m.filter(Boolean)) / 60).toFixed(1)} h`,
      chart: bars(m),
      tap: (i) => { const d = x.days[x.dates[i]] || {}; return `${short(x.dates[i])}: ${((d.study || 0) / 60).toFixed(1)} h study · ${Math.round(d.chat || 0)} min chat`; } };
  } },
  { id: 'piano', title: 'Piano', render(x) {
    const m = x.dates.map((k) => x.days[k]?.piano || null);
    const played = m.filter(Boolean), tot = sum(played), prev = sum(x.prev.map((k) => x.days[k]?.piano || 0));
    const last = [...(x.piano || [])].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).pop();
    const live = LS.get('pianoTimer', null);
    return { big: String(Math.round(tot)), unit: 'min',
      sub: `${played.length}/${x.dates.length} days played` + (x.prev.length ? ` · <span class="${tot >= prev ? 'good' : 'bad'}">${tot >= prev ? '+' : '−'}${Math.round(Math.abs(tot - prev))} min vs before</span>` : '')
        + (last ? ` · last ${short(last.date)}` : ''),
      head: `<button class="card-btn${live ? ' live' : ''}" data-piano>${live ? '■ Stop' : '▶ Start'}</button>`,
      chart: bars(m),
      tap: (i) => { const k = x.dates[i], rows = (x.piano || []).filter((r) => r.date === k);
        return rows.length ? `${short(k)}: ${Math.round(x.days[k].piano)} min` + (rows.some((r) => r.note) ? ' · ' + rows.map((r) => r.note).filter(Boolean).join(', ') : '') : `${short(k)}: didn’t play`; },
      wire(el) { el.querySelector('[data-piano]').addEventListener('click', () => window.openPiano?.()); } };
  } },
  { id: 'protein', title: 'Protein', render(x) {
    const pr = x.dates.map((k) => (x.days[k]?.meals ? Math.round(x.days[k].protein) : null));
    const logged = x.dates.filter((k) => x.days[k]?.meals);
    const ap = avg(logged.map((k) => x.days[k].protein));
    const hit = logged.filter((k) => x.days[k].protein >= PROTEIN_GOAL()).length;
    return { big: ap == null ? '—' : `<span class="${ap >= PROTEIN_GOAL() ? 'good' : 'warn'}">${Math.round(ap)}</span>`, unit: 'g avg',
      sub: ap == null ? 'nothing logged' : `goal ${PROTEIN_GOAL()} g · ${hit}/${logged.length} days hit`,
      chart: bars(pr, { ref: PROTEIN_GOAL(), cls: (v) => (v >= PROTEIN_GOAL() ? 'var(--good)' : 'var(--accent)') }),
      tap: (i) => { const d = x.days[x.dates[i]]; return d?.meals ? `${short(x.dates[i])}: ${Math.round(d.protein)} g protein · ${d.meals} items` : `${short(x.dates[i])}: nothing logged`; } };
  } },
  { id: 'kcal', title: 'Calories', render(x) {
    const kc = x.dates.map((k) => (x.days[k]?.meals ? Math.round(x.days[k].kcal) : null));
    const logged = x.dates.filter((k) => x.days[k]?.meals);
    const ak = avg(logged.map((k) => x.days[k].kcal)), goal = KCAL_GOAL();
    // within ±10 % of the target = on target; over = warn, under = plain
    const near = (v) => goal && Math.abs(v - goal) <= goal * 0.1;
    const on = logged.filter((k) => near(x.days[k].kcal)).length;
    return { big: ak == null ? '—' : `<span class="${!goal ? '' : near(ak) ? 'good' : 'warn'}">${Math.round(ak).toLocaleString('en')}</span>`, unit: 'kcal avg',
      sub: ak == null ? 'nothing logged' : goal ? `target ${goal.toLocaleString('en')} · ${on}/${logged.length} days within ±10 %` : `${logged.length} days logged`,
      chart: bars(kc, { ref: goal, cls: (v) => (!goal ? 'var(--accent)' : near(v) ? 'var(--good)' : v > goal ? 'var(--warn)' : 'var(--accent)') }),
      tap: (i) => { const d = x.days[x.dates[i]]; return d?.meals ? `${short(x.dates[i])}: ${Math.round(d.kcal).toLocaleString('en')} kcal · ${d.meals} items` : `${short(x.dates[i])}: nothing logged`; } };
  } },
  { id: 'mouth', title: 'Mouth hygiene', render(x) {
    // done = brushed AM + brushed PM + flossed; before mouthStart only floss was tracked
    const start = MOUTH_START(), ds = x.dates.filter((k) => k >= start && k < x.today);
    const n = ds.filter((k) => mouthDone(x.days[k])).length, td = x.days[x.today];
    let streak = 0; for (let k = mouthDone(td) ? x.today : addDays(x.today, -1); k >= start && mouthDone(x.days[k]); k = addDays(k, -1)) streak++;
    const fl = x.dates.filter((k) => k >= FLOSS_START() && k < x.today), fn = fl.filter((k) => x.days[k]?.floss).length;
    return { big: ds.length ? `<span class="${n / ds.length >= 0.7 ? 'good' : 'bad'}">${n}</span>` : `${mouthCount(td)}`, unit: ds.length ? `/${ds.length} days` : '/3 today',
      sub: `streak ${streak} 🪥 · today ${mouthCount(td)}/3` + (fl.length ? ` · floss ${fn}/${fl.length}` : ''),
      chart: bars(x.dates.map((k) => (k < FLOSS_START() ? null : mouthCount(x.days[k]))), { max: 3, cls: (v) => (v === 3 ? 'var(--good)' : v ? 'var(--warn)' : 'var(--bad)') }),
      tap: (i) => { const k = x.dates[i], d = x.days[k] || {};
        return k < FLOSS_START() ? `${short(k)}: before tracking` : `${short(k)}: ` + [d.brushAm ? '🪥 AM ✓' : '🪥 AM ✗', d.brushPm ? '🪥 PM ✓' : '🪥 PM ✗', d.floss ? '🧵 floss ✓' : '🧵 floss ✗', d.mouthwash && 'mouthwash ✓'].filter(Boolean).join(' · ') + (k < start ? ' (only floss tracked then)' : ''); } };
  } },
  { id: 'shower', title: 'Showers', render(x) {
    const start = MOUTH_START(), ds = x.dates.filter((k) => k >= start);
    const v = x.dates.map((k) => (k < start ? null : x.days[k]?.showers || 0));
    const days = ds.filter((k) => x.days[k]?.showers).length, tot = sum(ds.map((k) => x.days[k]?.showers || 0));
    const last = [...x.dates].reverse().find((k) => x.days[k]?.showers);
    return { big: String(days), unit: `/${ds.length} days`,
      sub: `${tot} shower${tot === 1 ? '' : 's'}` + (last ? ` · last ${last === x.today ? 'today' : daysBetween(last, x.today) + ' d ago'}` : ''),
      chart: bars(v, { max: Math.max(2, ...v.filter((n) => n != null)), cls: (n) => (n ? 'var(--accent)' : 'var(--line)') }),
      tap: (i) => { const k = x.dates[i]; return k < start ? `${short(k)}: before tracking` : `${short(k)}: ${x.days[k]?.showers || 0} shower${x.days[k]?.showers === 1 ? '' : 's'}`; } };
  } },
  { id: 'training', title: 'Training', render(x) {
    const g = x.dates.filter((k) => x.days[k]?.gym).length, r = x.dates.filter((k) => x.days[k]?.run).length;
    const weeks = Math.max(1, x.dates.length / 7);
    return { big: String(g + r), unit: 'sessions',
      sub: `${g} gym · ${r} run` + (CFG.trainingPerWeek ? ` · goal ${Math.round(CFG.trainingPerWeek * weeks)}` : ''),
      chart: bars(x.dates.map((k) => ((x.days[k]?.gym ? 1 : 0) + (x.days[k]?.run ? 1 : 0)) || null), { max: 2 }),
      tap: (i) => { const d = x.days[x.dates[i]] || {}; return `${short(x.dates[i])}: ${[d.gym && 'gym', d.run && 'run'].filter(Boolean).join(' + ') || 'rest'}`; } };
  } },
  { id: 'sleep', title: 'Asleep at', render(x) {
    const h = x.dates.map((k) => sleepHours(x.days[k]?.asleep));
    const v = h.filter((n) => n != null).sort((a, b) => a - b);
    const med = v.length ? v[Math.floor((v.length - 1) / 2)] : null;
    return { big: med == null ? '—' : fmtClock(med), unit: 'median',
      sub: `${v.filter((n) => n >= 25).length} of ${v.length} nights after 01:00` + (CFG.sleepTarget ? ` · line = ${CFG.sleepTarget}` : '') + ' · taller = later',
      chart: bars(h.map((n) => (n == null ? null : n - 21)), { max: 8, ref: CFG.sleepTarget ? sleepHours(CFG.sleepTarget) - 21 : undefined, cls: (n) => (n >= 4 ? 'var(--bad)' : n >= 3 ? 'var(--warn)' : 'var(--accent)') }),
      tap: (i) => `${short(x.dates[i])}: ${x.days[x.dates[i]]?.asleep ? 'asleep ~' + x.days[x.dates[i]].asleep : 'not logged'}` };
  } },
  { id: 'sleeplen', title: 'Sleep', render(x) {
    // asleep on day D (goodnight) → awake tap on day D+1
    const h = x.dates.map((k) => { const a = sleepHours(x.days[addDays(k, -1)]?.asleep), w = x.days[k]?.awake;
      if (a == null || !w) return null; const [hh, mm] = w.split(':').map(Number); const d = hh + mm / 60 + 24 - a; return d > 0 && d < 16 ? Math.round(d * 10) / 10 : null; });
    const v = h.filter((n) => n != null);
    const wakes = x.dates.map((k) => x.days[k]?.awake).filter(Boolean).sort();
    return { big: v.length ? avg(v).toFixed(1) : '—', unit: 'h avg',
      sub: v.length ? `${v.filter((n) => n < 7).length} of ${v.length} nights under 7 h` + (wakes.length ? ` · usually up ~${wakes[Math.floor((wakes.length - 1) / 2)]}` : '') : 'tap ☀️ Awake in the morning to get this',
      chart: bars(h, { max: 10, cls: (n) => (n < 6 ? 'var(--bad)' : n < 7 ? 'var(--warn)' : 'var(--good)') }),
      tap: (i) => { const k = x.dates[i]; return h[i] != null ? `${short(k)}: ${h[i]} h (asleep ~${x.days[addDays(k, -1)].asleep}, up ${x.days[k].awake})` : `${short(k)}: ${x.days[k]?.awake ? 'up ' + x.days[k].awake + ', no goodnight the night before' : 'no awake tap'}`; } };
  } },
  { id: 'mood', title: 'Mood + energy', render(x) {
    const m = x.dates.map((k) => x.days[k]?.mood ?? null), e = x.dates.map((k) => x.days[k]?.energy ?? null);
    const am = avg(m.filter((n) => n != null)), ae = avg(e.filter((n) => n != null));
    const face = (n) => ['', '😣', '🙁', '😐', '🙂', '😄'][Math.round(n)] || '';
    return { big: am == null ? '—' : `${am.toFixed(1)} ${face(am)}`, unit: '/5 mood',
      sub: am == null ? 'rate it at 😴 Goodnight' : `energy ${ae == null ? '—' : ae.toFixed(1) + '/5'} · ${m.filter((n) => n != null).length} days rated`,
      chart: bars(m, { max: 5, cls: (n) => (n >= 4 ? 'var(--good)' : n >= 3 ? 'var(--accent)' : n >= 2 ? 'var(--warn)' : 'var(--bad)') }),
      tap: (i) => { const d = x.days[x.dates[i]] || {}; return d.mood || d.energy ? `${short(x.dates[i])}: mood ${d.mood ?? '—'}/5 ${face(d.mood || 0)} · energy ${d.energy ?? '—'}/5` : `${short(x.dates[i])}: not rated`; } };
  } },
  { id: 'caffeine', title: 'Caffeine', render(x) {
    const c = x.dates.map((k) => x.days[k]?.caffeine || null);
    const start = MOUTH_START(), ds = x.dates.filter((k) => k >= start), tot = sum(ds.map((k) => x.days[k]?.caffeine || 0));
    // "late" = after 16:00 or before the day ends at 04:00
    const late = (t) => t >= '16:00' || t < '04:00';
    const lates = ds.flatMap((k) => x.days[k]?.cafTimes || []).filter(late).length;
    return { big: ds.length ? (tot / ds.length).toFixed(1) : '—', unit: '/day',
      sub: `${tot} total · ${lates} after 16:00`,
      chart: bars(c, { cls: () => 'var(--warn)' }),
      tap: (i) => { const d = x.days[x.dates[i]] || {}; return d.caffeine ? `${short(x.dates[i])}: ${d.caffeine} × at ${d.cafTimes.join(', ')}` : `${short(x.dates[i])}: none`; } };
  } },
  { id: 'home', title: 'Household', render(x) {
    const last = {}; for (const r of x.habits || []) if (CHORES[r.habit] && (!last[r.habit] || r.date > last[r.habit])) last[r.habit] = r.date;
    const inR = x.dates.reduce((n, k) => n + (x.days[k]?.chores?.length || 0), 0);
    return { big: String(inR), unit: `chore${inR === 1 ? '' : 's'}`,
      sub: 'tap 🏠 Home when you did one',
      html: `<ul class="list">${Object.entries(CHORES).map(([h, label]) => { const g = last[h] ? daysBetween(last[h], x.today) : null;
        return `<li><span>${label}</span><span class="${g == null || g >= 7 ? 'bad' : g >= 3 ? 'warn' : 'good'}">${g == null ? 'not logged yet' : g === 0 ? 'today' : g + ' d ago'}</span></li>`; }).join('')}</ul>` };
  } },
  { id: 'exams', title: 'Coming up', render(x) {
    const next = x.deadlines.slice(0, 6);
    const d0 = next[0] ? daysBetween(x.today, next[0].date) : null;
    return { big: d0 == null ? '—' : d0 === 0 ? 'today' : String(d0), unit: d0 ? `day${d0 === 1 ? '' : 's'} to ${esc(next[0].item)}` : '',
      html: `<ul class="list">${next.map((d) => { const n = daysBetween(x.today, d.date); return `<li><span class="${n <= 3 ? 'bad' : n <= 7 ? 'warn' : ''}">${esc(d.item)} · ${esc(d.course.split(' ').slice(0, 3).join(' ').replace(/[,:]$/, ''))}</span><span>${n === 0 ? 'today' : 'in ' + n + ' d'}</span></li>`; }).join('')}</ul>` };
  } },
  { id: 'money', title: 'Money this month', render(x) {
    const month = x.today.slice(0, 7);
    const rows = x.spends.filter((s) => s.date.startsWith(month));
    const everyday = rows.filter((s) => !/^One-time/i.test(s.cat));
    const spent = sum(everyday.map((s) => s.eur)), oneoff = sum(rows.filter((s) => /^One-time/i.test(s.cat)).map((s) => s.eur));
    const dom = Number(x.today.slice(8)), dim = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
    const pace = (spent / dom) * dim;
    const last = x.spends.reduce((m, s) => (s.date > m && s.date <= x.today ? s.date : m), '');
    const gap = last ? daysBetween(last, x.today) : null;
    const cats = {}; everyday.forEach((s) => (cats[s.cat] = (cats[s.cat] || 0) + s.eur));
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return { big: `<span class="${pace <= BUDGET() ? 'good' : 'bad'}">€${Math.round(spent)}</span>`, unit: `of €${BUDGET()}`,
      sub: `on pace for €${Math.round(pace)}` + (oneoff ? ` · one-offs ${oneoff < 0 ? '−' : ''}€${Math.abs(Math.round(oneoff))}` : '') +
        (gap != null ? ` · <span class="${gap >= 2 ? 'warn' : ''}">last logged ${gap === 0 ? 'today' : gap + ' d ago'}</span>` : ''),
      html: `<ul class="list">${top.map(([c, e]) => `<li><span>${esc(c)}</span><span>€${e.toFixed(2)}</span></li>`).join('')}</ul>` };
  } },
  { id: 'weight', title: 'Weight', render(x) {
    const w = x.weights; const last = w[w.length - 1];
    const inR = w.filter((r) => r.date >= x.dates[0]);
    const byDay = Object.fromEntries(w.map((r) => [r.date, r.kg])); // last weigh-in of a day wins
    const vals = x.dates.map((k) => byDay[k] ?? null), have = vals.filter((v) => v != null);
    return { big: last ? last.kg.toFixed(1) : '—', unit: 'kg',
      sub: last ? `${short(last.date)}` + (inR.length >= 2 ? ` · ${sign(inR[inR.length - 1].kg - inR[0].kg)} kg in range` : '') + ` · ${inR.length} weigh-in${inR.length === 1 ? '' : 's'}` : 'no weigh-ins yet',
      chart: have.length ? bars(vals, { min: Math.floor(Math.min(...have)) - 1, max: Math.ceil(Math.max(...have)) + 0.5 }) : '',
      tap: (i) => { const r = w.find((q) => q.date === x.dates[i]); return r ? `${short(r.date)}: ${r.kg} kg · ${r.note}` : `${short(x.dates[i])}: no weigh-in`; } };
  } },
];

// ---------- update tab ----------
// update.json: { date, generated, headline, sections: [{ title, highlight?, note?, items?: [item], groups?: [{ label, items }] }] }
// item: { text, meta?, tone?: good|warn|bad|muted|focus } · text may use **bold**
let tab = null, updShown = null; // updShown = archive date being viewed (null = latest)
const updCache = {};
const md = (s) => esc(s || '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const itemHtml = (it) => typeof it === 'string' ? `<li>${md(it)}</li>`
  : `<li class="${esc(it.tone || '')}"><span>${md(it.text)}</span>${it.meta ? `<span class="meta">${md(it.meta)}</span>` : ''}</li>`;

async function renderUpdate() {
  const el = $('#update');
  const latest = DATA.update;
  let u = latest;
  if (updShown && updShown !== latest?.date) {
    u = updCache[updShown];
    if (!u) {
      el.innerHTML = '<p class="status">Loading…</p>';
      try { u = updCache[updShown] = JSON.parse(await gh(`${F('updateArchive')}/${updShown}.json`)); } catch (e) { el.innerHTML = `<p class="status">Couldn’t load ${esc(updShown)}: ${esc(e.message)}</p>`; return; }
    }
  }
  if (!u) { el.innerHTML = '<article class="card"><h2>Daily update</h2><p class="sub">No update yet. Run it in Claude ("let\'s do the update") and it shows up here.</p></article>'; return; }
  const dates = [...new Set([...DATA.updateDates, latest?.date].filter(Boolean))].sort();
  const i = dates.indexOf(u.date);
  const stale = u === latest && u.date !== DATA.today;
  el.innerHTML = `
    <div class="upd-head">
      <button class="cal-nav" id="upd-prev" aria-label="Older update" ${i > 0 ? '' : 'disabled'}>‹</button>
      <div><b>${short(u.date)}</b>${u.generated ? `<span class="sub"> · ${new Date(u.generated).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: CFG.timezone })}</span>` : ''}</div>
      <button class="cal-nav" id="upd-next" aria-label="Newer update" ${i >= 0 && i < dates.length - 1 ? '' : 'disabled'}>›</button>
    </div>
    ${stale ? `<p class="stale">No update yet today, this is ${short(u.date)}’s.</p>` : ''}
    ${u.headline ? `<p class="headline">${md(u.headline)}</p>` : ''}
    ${(u.sections || []).map((s) => `<article class="card upd">
      <h2>${esc(s.title)}</h2>
      ${s.highlight ? `<p class="focus">${md(s.highlight)}</p>` : ''}
      ${s.note ? `<p class="sub">${md(s.note)}</p>` : ''}
      ${s.items?.length ? `<ul class="list upd-list">${s.items.map(itemHtml).join('')}</ul>` : ''}
      ${(s.groups || []).map((g) => `<h3>${esc(g.label)}</h3><ul class="list upd-list">${(g.items || []).map(itemHtml).join('')}</ul>`).join('')}
    </article>`).join('')}`;
  const go = (d) => { updShown = d === latest?.date ? null : d; renderUpdate(); };
  $('#upd-prev').addEventListener('click', () => go(dates[i - 1]));
  $('#upd-next').addEventListener('click', () => go(dates[i + 1]));
  if (u === latest && latest.generated) LS.set('seenUpdate', latest.generated);
}

function showTab(t) {
  tab = t; LS.set('tab', t);
  document.querySelectorAll('.tabs button').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('#update').hidden = t !== 'update';
  $('#cards').hidden = $('#today').hidden = $('.range').hidden = t !== 'stats';
  render();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- render ----------
let DATA = null;
let range = LS.get('range', 7);
const $ = (s) => document.querySelector(s);

function order() {
  const saved = LS.get('order', []).flatMap((id) => (id === 'food' ? ['protein', 'kcal'] : id === 'floss' ? ['mouth'] : [id])).filter((id) => CARDS.some((c) => c.id === id));
  CARDS.forEach((c, i) => {
    if (saved.includes(c.id)) return;
    const before = CARDS.slice(0, i).map((p) => p.id).filter((id) => saved.includes(id)).pop();
    saved.splice(before ? saved.indexOf(before) + 1 : 0, 0, c.id);
  });
  return [...new Set(saved)];
}
const hidden = () => new Set(LS.get('hidden', []));

function render() {
  if (!DATA) return;
  if (tab === 'update') { renderUpdate(); return; }
  window.renderToday?.();
  const first = Object.keys(DATA.days).sort()[0] || DATA.today;
  const from = range === 'all' ? first : addDays(DATA.today, -(range - 1));
  const dates = span(from, DATA.today);
  const prev = range === 'all' ? [] : span(addDays(from, -range), addDays(from, -1));
  const ctx = { ...DATA, dates, prev };
  const off = hidden();
  const root = $('#cards'); root.textContent = '';
  for (const id of order()) {
    if (off.has(id)) continue;
    const def = CARDS.find((c) => c.id === id);
    let r;
    try { r = def.render(ctx); } catch (e) { r = { big: '—', sub: 'couldn’t read this one: ' + esc(e.message) }; }
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `${r.head ? `<div class="card-head"><h2>${def.title}</h2>${r.head}</div>` : `<h2>${def.title}</h2>`}<div class="big">${r.big}<small>${r.unit || ''}</small></div><div class="sub">${r.sub || ''}</div>${r.chart || ''}${r.html || ''}${r.tap ? '<div class="detail"></div>' : ''}`;
    if (r.tap) {
      const det = el.querySelector('.detail');
      const lastI = dates.length - 1;
      det.textContent = r.tap(lastI);
      el.querySelector('svg')?.addEventListener('click', (ev) => { const i = ev.target.getAttribute('data-i'); if (i != null) det.textContent = r.tap(Number(i)); });
    }
    r.wire?.(el);
    root.appendChild(el);
  }
}

async function refresh() {
  if (!LS.get('conn', {}).token) { $('#setup').hidden = false; return; }
  $('#status').textContent = 'Loading…';
  try {
    DATA = await load(range === 'all' ? 'all' : Math.max(range, 30));
    LS.set('last', DATA);
    if (!tab) showTab(DATA.update?.generated && DATA.update.generated !== LS.get('seenUpdate', null) ? 'update' : 'stats');
    $('#status').textContent = 'Updated ' + new Date(DATA.fetched).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    $('#status').textContent = e.message === 'auth' ? 'Token rejected: open ⚙ → Change token.' : (e instanceof TypeError ? 'Offline or GitHub unreachable' : 'Couldn’t load') + ', showing the last data: ' + e.message;
  }
  if (!tab) showTab(LS.get('tab', 'stats') === 'update' ? 'update' : 'stats');
  render();
}

// ---------- UI wiring ----------
document.querySelectorAll('.range button').forEach((b) => {
  b.classList.toggle('on', String(range) === b.dataset.range);
  b.addEventListener('click', () => {
    range = b.dataset.range === 'all' ? 'all' : Number(b.dataset.range);
    LS.set('range', range);
    document.querySelectorAll('.range button').forEach((o) => o.classList.toggle('on', o === b));
    if (range === 'all') refresh(); else render();
  });
});
$('#refresh').addEventListener('click', refresh);
$('#save-token').addEventListener('click', () => {
  LS.set('conn', { token: $('#token').value.trim(), repo: $('#repo').value.trim() });
  $('#setup').hidden = true; refresh();
});
$('#change-token').addEventListener('click', () => { $('#settings').hidden = true; $('#setup').hidden = false; });

function drawList() {
  const off = hidden(), ul = $('#card-list'); ul.textContent = '';
  order().forEach((id, i, all) => {
    const def = CARDS.find((c) => c.id === id);
    const li = document.createElement('li');
    li.innerHTML = `<label><input type="checkbox" id="c-${id}" ${off.has(id) ? '' : 'checked'}> ${def.title}</label><button aria-label="Move up" ${i ? '' : 'disabled'}>↑</button><button aria-label="Move down" ${i < all.length - 1 ? '' : 'disabled'}>↓</button>`;
    li.querySelector('input').addEventListener('change', (e) => { const h = hidden(); e.target.checked ? h.delete(id) : h.add(id); LS.set('hidden', [...h]); });
    const [up, down] = li.querySelectorAll('button');
    const move = (d) => { const o = order(); o.splice(i, 1); o.splice(i + d, 0, id); LS.set('order', o); drawList(); };
    up.addEventListener('click', () => move(-1)); down.addEventListener('click', () => move(1));
    ul.appendChild(li);
  });
}
function drawThemes() {
  document.querySelectorAll('#theme-pick button').forEach((b) => {
    b.classList.toggle('on', b.dataset.pick === theme());
    b.onclick = () => { LS.set('theme', b.dataset.pick); applyTheme(); drawThemes(); render(); };
  });
}
$('#open-settings').addEventListener('click', () => { drawList(); drawThemes(); $('#settings').hidden = false; });
$('#close-settings').addEventListener('click', () => { $('#settings').hidden = true; render(); });

DATA = LS.get('last', null);
if (DATA?.cfg) { CFG = DATA.cfg; fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: CFG.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
showTab(LS.get('tab', 'stats') === 'update' ? 'update' : 'stats'); tab = null; // real choice once fresh data is in
refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
