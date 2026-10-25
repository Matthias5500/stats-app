// Stats: reads a private repo straight from GitHub (read-only token on this device) and parses it here.
// Everything personal (file paths, goals, time zone) lives in stats.json inside that repo, not in this code.

const LS = {
  get(k, d) { try { const v = localStorage.getItem('stats.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stats.' + k, JSON.stringify(v)); } catch { /* full or blocked: skip cache */ } },
};

const H = 3600e3;
let CFG = {}; // loaded from stats.json in the data repo
const BUDGET = () => CFG.budget, PROTEIN_GOAL = () => CFG.proteinGoal, FLOSS_START = () => CFG.flossStart || '0000';
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
    if (line.includes('🏋') && !no.test(line.split('·')[0])) r.gym = true;
    if (line.includes('🏃') && /\d+(\.\d+)? ?km/.test(line) && !no.test(line.split('·')[0])) r.run = true;
    if (/^\s*-\s*😴/u.test(line) && !/^\s*-\s*😴\s*(Woke|Plan)/u.test(line)) {
      const t = [...line.matchAll(/(?:really|actually) asleep ~?(\d{1,2}:\d{2})/g)];
      const u = t.length ? t : [...line.matchAll(/(?:Asleep|Went to bed)\s*~?(\d{1,2}:\d{2})/g)];
      if (u.length) r.asleep = u[u.length - 1][1].padStart(5, '0');
    }
  }
  return r;
}

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
  const logNames = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  const from = range === 'all' ? (logNames[0] || today).slice(0, 10) : addDays(today, -(2 * range - 1));
  const wantLogs = logNames.filter((n) => n.slice(0, 10) >= from);
  const timeNames = names.filter((n) => /^time-.*\.csv$/.test(n) && F('logDir') + '/' + n !== F('timeTags'));

  const [ratings, food, tags, body, deadlineText, money, tx, ...rest] = await Promise.all([
    gh(F('ratings')), gh(F('food')), gh(F('timeTags')), gh(F('body')),
    gh(F('deadlines')), gh(F('money')), gh(F('transactions')),
    ...timeNames.map((n) => gh(F('logDir') + '/' + n)), ...wantLogs.map((n) => gh(F('logDir') + '/' + n)),
  ]);
  const timeFiles = rest.slice(0, timeNames.length);
  const logs = rest.slice(timeNames.length);

  const days = {};
  const day = (k) => (days[k] ||= { kcal: 0, protein: 0, meals: 0 });
  for (const r of csv(ratings)) Object.assign(day(r.date), { score: Number(r.score), final: r.final === 'final', why: r.why });
  for (const r of csv(food)) { const d = day(r.date); d.kcal += Number(r.kcal) || 0; d.protein += Number(r.protein_g) || 0; d.meals++; }
  for (const [k, v] of Object.entries(studyTime(timeFiles, tags))) Object.assign(day(k), v);
  wantLogs.forEach((n, i) => { if (logs[i]) Object.assign(day(n.slice(0, 10)), dayLog(logs[i]), { logged: true }); });

  const weights = mdTable(body, CFG.weightHeading).filter((c) => /^\d{4}-/.test(c[0])).map((c) => ({ date: c[0], kg: Number(c[1]), note: c[2] || '' }));

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

  return { today, days, weights, deadlines, spends, cfg: CFG, fetched: Date.now() };
}

// ---------- tiny charts ----------
function bars(values, { max, min = 0, ref, cls, hollow } = {}) {
  const W = 300, Hh = 60, n = values.length, top = max ?? Math.max(1, ...values.filter((v) => v != null), ref || 0);
  const bw = W / n, y = (v) => Hh - ((v - min) / (top - min)) * (Hh - 4);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${Hh + 10}" preserveAspectRatio="none" role="img">`;
  values.forEach((v, i) => {
    const x = i * bw + bw * 0.15, w = Math.max(1, bw * 0.7);
    s += `<rect data-i="${i}" x="${i * bw}" y="0" width="${bw}" height="${Hh}" fill="transparent"/>`;
    if (v == null) { s += `<rect x="${x}" y="${Hh - 1}" width="${w}" height="1" fill="var(--line)"/>`; return; }
    const c = cls ? cls(v, i) : 'var(--accent)', yy = Math.min(y(v), Hh - 2);
    s += hollow && hollow(i)
      ? `<rect pointer-events="none" x="${x + .75}" y="${yy}" width="${w - 1.5}" height="${Hh - yy}" rx="2" fill="none" stroke="${c}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
      : `<rect pointer-events="none" x="${x}" y="${yy}" width="${w}" height="${Hh - yy}" rx="2" fill="${c}"/>`;
  });
  if (ref != null) s += `<line x1="0" x2="${W}" y1="${y(ref)}" y2="${y(ref)}" stroke="var(--muted)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`;
  return s + '</svg>';
}

// ---------- cards ----------
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const sign = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const CARDS = [
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
  { id: 'food', title: 'Protein + kcal', render(x) {
    const pr = x.dates.map((k) => (x.days[k]?.meals ? Math.round(x.days[k].protein) : null));
    const logged = x.dates.filter((k) => x.days[k]?.meals);
    const ap = avg(logged.map((k) => x.days[k].protein)), ak = avg(logged.map((k) => x.days[k].kcal));
    const hit = logged.filter((k) => x.days[k].protein >= PROTEIN_GOAL()).length;
    return { big: ap == null ? '—' : `<span class="${ap >= PROTEIN_GOAL() ? 'good' : 'warn'}">${Math.round(ap)}</span>`, unit: `g protein avg`,
      sub: ak == null ? 'nothing logged' : `${Math.round(ak).toLocaleString('en')} kcal avg · ${hit}/${logged.length} days ≥ ${PROTEIN_GOAL()} g`,
      chart: bars(pr, { ref: PROTEIN_GOAL(), cls: (v) => (v >= PROTEIN_GOAL() ? 'var(--good)' : 'var(--accent)') }),
      tap: (i) => { const d = x.days[x.dates[i]]; return d?.meals ? `${short(x.dates[i])}: ${Math.round(d.protein)} g protein · ${Math.round(d.kcal).toLocaleString('en')} kcal · ${d.meals} items` : `${short(x.dates[i])}: nothing logged`; } };
  } },
  { id: 'floss', title: 'Floss', render(x) {
    const ds = x.dates.filter((k) => k >= FLOSS_START() && k < x.today);
    const f = x.dates.map((k) => (k < FLOSS_START() ? null : x.days[k]?.floss ? 1 : 0));
    const n = ds.filter((k) => x.days[k]?.floss).length;
    let streak = 0; for (let k = x.days[x.today]?.floss ? x.today : addDays(x.today, -1); x.days[k]?.floss; k = addDays(k, -1)) streak++;
    return { big: `<span class="${ds.length && n / ds.length >= 0.7 ? 'good' : 'bad'}">${n}</span>`, unit: `/${ds.length} days`,
      sub: `streak ${streak} 🦷` + (x.days[x.today]?.floss ? ' · done today' : ' · not yet today'),
      chart: bars(f, { max: 1, cls: (v) => (v ? 'var(--good)' : 'var(--bad)') }),
      tap: (i) => `${short(x.dates[i])}: ${x.dates[i] < FLOSS_START() ? 'before tracking' : x.days[x.dates[i]]?.floss ? 'flossed' : 'no floss'}` };
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
    const byDay = Object.fromEntries(w.map((r) => [r.date, r.kg]));
    const vals = x.dates.map((k) => byDay[k] ?? null), have = vals.filter((v) => v != null);
    return { big: last ? last.kg.toFixed(1) : '—', unit: 'kg',
      sub: last ? `${short(last.date)}` + (inR.length >= 2 ? ` · ${sign(inR[inR.length - 1].kg - inR[0].kg)} kg in range` : '') + ` · ${inR.length} weigh-in${inR.length === 1 ? '' : 's'}` : 'no weigh-ins yet',
      chart: have.length ? bars(vals, { min: Math.floor(Math.min(...have)) - 1, max: Math.ceil(Math.max(...have)) + 0.5 }) : '',
      tap: (i) => { const r = w.find((q) => q.date === x.dates[i]); return r ? `${short(r.date)}: ${r.kg} kg · ${r.note}` : `${short(x.dates[i])}: no weigh-in`; } };
  } },
];

// ---------- render ----------
let DATA = null;
let range = LS.get('range', 7);
const $ = (s) => document.querySelector(s);

function order() {
  const saved = LS.get('order', []);
  return [...saved.filter((id) => CARDS.some((c) => c.id === id)), ...CARDS.map((c) => c.id).filter((id) => !saved.includes(id))];
}
const hidden = () => new Set(LS.get('hidden', []));

function render() {
  if (!DATA) return;
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
    el.innerHTML = `<h2>${def.title}</h2><div class="big">${r.big}<small>${r.unit || ''}</small></div><div class="sub">${r.sub || ''}</div>${r.chart || ''}${r.html || ''}${r.tap ? '<div class="detail"></div>' : ''}`;
    if (r.tap) {
      const det = el.querySelector('.detail');
      const lastI = dates.length - 1;
      det.textContent = r.tap(lastI);
      el.querySelector('svg')?.addEventListener('click', (ev) => { const i = ev.target.getAttribute('data-i'); if (i != null) det.textContent = r.tap(Number(i)); });
    }
    root.appendChild(el);
  }
}

async function refresh() {
  if (!LS.get('conn', {}).token) { $('#setup').hidden = false; return; }
  $('#status').textContent = 'Loading…';
  try {
    DATA = await load(range === 'all' ? 'all' : Math.max(range, 30));
    LS.set('last', DATA);
    $('#status').textContent = 'Updated ' + new Date(DATA.fetched).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    $('#status').textContent = e.message === 'auth' ? 'Token rejected: open ⚙ → Change token.' : (e instanceof TypeError ? 'Offline or GitHub unreachable' : 'Couldn’t load') + ', showing the last data: ' + e.message;
  }
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
$('#open-settings').addEventListener('click', () => { drawList(); $('#settings').hidden = false; });
$('#close-settings').addEventListener('click', () => { $('#settings').hidden = true; render(); });

DATA = LS.get('last', null);
if (DATA?.cfg) { CFG = DATA.cfg; fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: CFG.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
render();
refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
