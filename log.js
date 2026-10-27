// Quick-logs: rows for the data repo's CSVs (paths from stats.json).
// Nothing is written right away: every log (and every undo) lands in an "unsaved" list on the device.
// Save writes the whole list as ONE commit starting with "app:", so sessions on the repo side can list it.

const HEADERS = {
  weight: 'date,time,kg,note',
  gym: 'date,time,workout,exercise,set,reps,kg,note',
  runs: 'date,time,km,minutes,feel,with,note',
  habits: 'date,time,habit,value',
  spend: 'date,time,eur,what,category',
  piano: 'date,time,minutes,note',
};

const cell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
const line = (vals) => vals.map(cell).join(',');
const clock = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: CFG.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const kg = (v) => String(Math.round(Number(v) * 100) / 100);

// ---------- staging ----------
// item: { id, kind, op: 'add' | 'del', rows (add) | match (del: every field must equal), label, marks: today's chips }
const staged = () => LS.get('staged', []);
function stage(item) {
  LS.set('staged', [...staged(), { id: Date.now() + Math.random(), date: nowKey(), ...item }]);
  toast((item.op === 'del' ? 'Undo noted: ' : 'Noted: ') + item.label + ' · hit Save to keep it');
  renderToday();
}
const unstage = (id) => { LS.set('staged', staged().filter((x) => x.id !== id)); renderToday(); };

// ---------- GitHub: all staged changes in one commit (git data API) ----------
const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const sameRow = (row, match) => Object.entries(match).every(([k, v]) => (row[k] ?? '') === String(v ?? ''));

function applyOps(text, header, ops) {
  if (!text) text = header + '\n';
  let lines = text.replace(/\n+$/, '').split('\n');
  for (const op of ops) {
    if (op.op === 'add') lines.push(...op.rows.map(line));
    else {
      // gym undo removes the whole workout (all rows of that date+time); everything else one row, newest first
      const hit = (l) => sameRow(csv(lines[0] + '\n' + l)[0] || {}, op.match);
      if (op.kind === 'gym') lines = [lines[0], ...lines.slice(1).filter((l) => !hit(l))];
      else for (let i = lines.length - 1; i > 0; i--) if (hit(lines[i])) { lines.splice(i, 1); break; }
    }
  }
  return lines.join('\n') + '\n';
}

async function commitStaged(items) {
  const { token, repo } = LS.get('conn', {});
  const api = `https://api.github.com/repos/${repo}`;
  const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
  const call = async (path, opts = {}) => {
    const r = await fetch(api + path, { cache: 'no-store', ...opts, headers: { ...H, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 401) throw new Error('auth');
    if (r.status === 403) throw new Error('token can’t write: needs Contents: Read and write');
    return r;
  };
  const byPath = {};
  for (const it of items) (byPath[F(it.kind)] ||= { header: HEADERS[it.kind], ops: [] }).ops.push(it);
  const message = 'app: ' + items.map((i) => (i.op === 'del' ? 'undo ' : '') + i.label).join(' · ');
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await call('/git/ref/heads/main'); if (!ref.ok) throw new Error('GitHub ' + ref.status);
    const parent = (await ref.json()).object.sha;
    const base = (await (await call('/git/commits/' + parent)).json()).tree.sha;
    const tree = [];
    for (const [path, { header, ops }] of Object.entries(byPath)) {
      const g = await call(`/contents/${path}?ref=${parent}`);
      if (!g.ok && g.status !== 404) throw new Error('GitHub ' + g.status);
      const text = g.ok ? b64d((await g.json()).content) : '';
      tree.push({ path, mode: '100644', type: 'blob', content: applyOps(text, header, ops) });
    }
    const t = await call('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base, tree }) });
    if (!t.ok) throw new Error('GitHub ' + t.status);
    const c = await call('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: (await t.json()).sha, parents: [parent] }) });
    if (!c.ok) throw new Error('GitHub ' + c.status);
    const u = await call('/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: (await c.json()).sha, force: false }) });
    if (u.ok) { Object.keys(byPath).forEach((p) => LS.remove('cache:' + p)); return; }
    if (u.status !== 422 && u.status !== 409) throw new Error('GitHub ' + u.status);
    // main moved in between (a sync from the computer): build again on top of it
  }
  throw new Error('the repo kept changing, try again');
}

let saving = false;
async function saveAll() {
  const items = staged();
  if (saving || !items.length) return;
  saving = true; renderToday();
  try {
    await commitStaged(items);
    const done = new Set(items.map((i) => i.id));
    LS.set('staged', staged().filter((x) => !done.has(x.id)));
    toast(`Saved ✓ ${items.length} change${items.length === 1 ? '' : 's'}`);
    saving = false;
    refresh();
  } catch (e) {
    saving = false;
    toast(`Not saved (${e.message === 'auth' ? 'token rejected' : e instanceof TypeError ? 'offline' : e.message}). Still on the phone, try Save again.`);
  }
  renderToday();
}

// ---------- small UI helpers ----------
const sheet = () => $('#sheet');
function openSheet(title, html, wire) {
  // fresh inner element each time, so listeners never pile up on the sheet itself
  sheet().innerHTML = `<div class="sheet-in"><div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>${html}</div>`;
  sheet().hidden = false;
  const root = sheet().firstElementChild;
  root.querySelector('[data-close]').addEventListener('click', closeSheet);
  wire?.(root);
}
function closeSheet() { sheet().hidden = true; sheet().innerHTML = ''; }
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
const stepper = (id, value, step, label) =>
  `<div class="stepper"><span class="lbl">${label}</span><button type="button" data-step="${id}" data-d="-${step}">−</button><input id="${id}" type="number" inputmode="decimal" step="any" value="${value}"><button type="button" data-step="${id}" data-d="${step}">+</button></div>`;
function wireSteppers(root) {
  root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const i = root.querySelector('#' + b.dataset.step);
    i.value = kg(Math.max(0, (Number(i.value) || 0) + Number(b.dataset.d)));
  }));
}
const nowKey = () => dayKey(Date.now());

// ---------- today bar ----------
function todayView() {
  const t = { ...(DATA.days[nowKey()] || {}) };
  for (const it of staged()) if (it.date === nowKey()) Object.assign(t, it.marks || {});
  return t;
}
window.renderToday = function () {
  const el = $('#today');
  if (!el || !DATA || !CFG.files) return;
  const t = todayView(), items = staged(), wo = LS.get('workout', null), pt = LS.get('pianoTimer', null), goal = CFG.proteinGoal;
  const st = streakInfo(DATA.days, nowKey());
  el.innerHTML = `
    <div class="chips">
      <span class="chip ${st.today ? 'fire' : ''}">🔥 ${st.cur}${st.today ? ' ✓' : ''}</span>
      <span class="chip ${t.protein >= goal ? 'good' : ''}">🍽️ ${Math.round(t.protein || 0)}/${goal} g</span>
      <span class="chip ${t.floss ? 'good' : 'bad'}">🦷 ${t.floss ? '✓' : '✗'}</span>
      <span class="chip ${t.gym || t.run ? 'good' : ''}">${t.gym ? '🏋️ ✓' : '🏋️ –'} ${t.run ? '🏃 ✓' : '🏃 –'}</span>
      ${F('piano') ? `<span class="chip ${t.piano ? 'good' : ''}">🎹 ${Math.round(t.piano || 0)} min</span>` : ''}
      <button class="chip" id="entries">↺ Undo…</button>
    </div>
    <div class="quick">
      <button id="q-floss" ${t.floss ? 'disabled' : ''}>🦷<span>${t.floss ? 'Flossed' : 'Floss'}</span></button>
      <button id="q-gym" class="${wo ? 'live' : ''}">🏋️<span>${wo ? 'Resume' : 'Gym'}</span></button>
      <button id="q-run">🏃<span>Run</span></button>
      ${F('piano') ? `<button id="q-piano" class="${pt ? 'live' : ''}">🎹<span>${pt ? 'Playing' : 'Piano'}</span></button>` : ''}
      <button id="q-weight">⚖️<span>Weight</span></button>
      <button id="q-spend">💸<span>Spend</span></button>
      <button id="q-night">😴<span>Goodnight</span></button>
    </div>
    ${items.length ? `<div class="unsaved">
      <div class="unsaved-head"><b>Not saved yet</b><span class="badge">${items.length}</span></div>
      <ul>${items.map((i) => `<li><span>${i.op === 'del' ? '🗑️ undo ' : ''}${esc(i.label)}</span><button class="x" data-unstage="${i.id}" aria-label="Remove">✕</button></li>`).join('')}</ul>
      <button class="primary" id="save-all" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : `Save ${items.length} change${items.length === 1 ? '' : 's'}`}</button>
    </div>` : ''}`;
  el.querySelectorAll('[data-unstage]').forEach((b) => b.addEventListener('click', () => unstage(Number(b.dataset.unstage))));
  $('#save-all')?.addEventListener('click', saveAll);
  $('#entries').addEventListener('click', openEntries);
  $('#q-floss').addEventListener('click', () => stage({ kind: 'habits', op: 'add', rows: [[nowKey(), clock(Date.now()), 'floss', '1']], label: 'floss', marks: { floss: true } }));
  $('#q-gym').addEventListener('click', openGym);
  $('#q-run').addEventListener('click', openRun);
  $('#q-piano')?.addEventListener('click', openPiano);
  $('#q-weight').addEventListener('click', openWeight);
  $('#q-spend').addEventListener('click', openSpend);
  $('#q-night').addEventListener('click', openNight);
};

// ---------- undo saved entries (today + yesterday) ----------
function openEntries() {
  const days = [nowKey(), addDays(nowKey(), -1)];
  const pick = (rows) => (rows || []).filter((r) => days.includes(r.date));
  const list = [
    ...pick(DATA.habits).map((r) => ({ kind: 'habits', match: r, label: r.habit === 'asleep' ? `goodnight ${r.value}` : r.habit, marks: r.habit === 'floss' ? { floss: false } : {} })),
    ...pick(DATA.weightRows).map((r) => ({ kind: 'weight', match: r, label: `weight ${r.kg} kg` })),
    ...pick(DATA.runs).map((r) => ({ kind: 'runs', match: r, label: `run ${r.km} km`, marks: { run: false } })),
    ...pick(DATA.spendLog).map((r) => ({ kind: 'spend', match: r, label: `spend €${r.eur} ${r.what}` })),
    ...pick(DATA.piano).map((r) => ({ kind: 'piano', match: r, label: `piano ${r.minutes} min`, marks: { piano: 0 } })),
    ...Object.values(Object.groupBy ? Object.groupBy(pick(DATA.gym), (r) => r.date + ' ' + r.time) : pick(DATA.gym).reduce((m, r) => ((m[r.date + ' ' + r.time] ||= []).push(r), m), {}))
      .map((rows) => ({ kind: 'gym', match: { date: rows[0].date, time: rows[0].time }, label: `gym ${rows[0].workout} · ${rows.length} sets`, marks: { gym: false } })),
  ].map((e) => ({ ...e, day: e.match.date, time: e.match.time || '' })).sort((a, b) => (b.day + b.time).localeCompare(a.day + a.time));
  const queued = staged().filter((i) => i.op === 'del').map((i) => JSON.stringify(i.match));
  openSheet('Undo a saved entry', list.length ? `
    <p class="sub">Today and yesterday. Undo lands in "Not saved yet" first, Save makes it real.</p>
    <ul class="list entries">${list.map((e, i) => `<li><span>${e.day === nowKey() ? 'Today' : 'Yesterday'} ${esc(e.time)} · ${esc(e.label)}</span>${queued.includes(JSON.stringify(e.match)) ? '<span>queued</span>' : `<button data-undo="${i}" aria-label="Undo">🗑️</button>`}</li>`).join('')}</ul>`
    : '<p class="sub">Nothing saved from the app today or yesterday.</p>', (r) => {
    r.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', () => {
      const e = list[Number(b.dataset.undo)];
      stage({ kind: e.kind, op: 'del', match: e.match, label: e.label, marks: e.day === nowKey() ? e.marks : {} });
      closeSheet();
    }));
  });
}

// ---------- weight ----------
function openWeight() {
  const last = DATA?.weights?.[DATA.weights.length - 1];
  const hour = Number(clock(Date.now()).slice(0, 2));
  openSheet('Weight', `
    ${stepper('w-kg', last ? last.kg : 75, 0.1, 'kg')}
    <label class="check"><input type="checkbox" id="w-morning" ${hour < 11 ? 'checked' : ''}> Morning, before eating</label>
    <label for="w-note">Note</label><input id="w-note" type="text" placeholder="optional">
    <button class="primary" id="w-save">Save</button>`, (r) => {
    wireSteppers(r);
    r.querySelector('#w-save').addEventListener('click', () => {
      const v = kg(r.querySelector('#w-kg').value);
      const note = [r.querySelector('#w-morning').checked ? 'morning' : 'not morning', r.querySelector('#w-note').value.trim()].filter(Boolean).join(', ');
      stage({ kind: 'weight', op: 'add', rows: [[nowKey(), clock(Date.now()), v, note]], label: `weight ${v} kg` });
      closeSheet();
    });
  });
}

// ---------- run ----------
function openRun() {
  const partner = CFG.runPartner;
  openSheet('Run', `
    ${stepper('r-km', 5, 0.5, 'km')}
    <label for="r-time">Time (mm:ss or h:mm:ss)</label><input id="r-time" type="text" inputmode="numeric" placeholder="30:00">
    <p class="sub" id="r-pace"></p>
    <label for="r-feel">Effort 1–10: <b id="r-feel-v">5</b></label><input id="r-feel" type="range" min="1" max="10" value="5">
    ${partner ? `<label class="check"><input type="checkbox" id="r-with"> With ${esc(partner)}</label>` : ''}
    <label for="r-note">Note</label><input id="r-note" type="text" placeholder="route, how it felt">
    <button class="primary" id="r-save">Save</button>`, (r) => {
    wireSteppers(r);
    const mins = () => { const p = r.querySelector('#r-time').value.trim().split(':').map(Number); if (p.some(isNaN) || !p[0] && p.length < 2) return null; return p.length === 3 ? p[0] * 60 + p[1] + p[2] / 60 : p.length === 2 ? p[0] + p[1] / 60 : p[0]; };
    const pace = () => { const m = mins(), k = Number(r.querySelector('#r-km').value); r.querySelector('#r-pace').textContent = m && k ? `Pace ${Math.floor(m / k)}:${String(Math.round((m / k % 1) * 60)).padStart(2, '0')} /km` : ''; };
    r.addEventListener('input', pace); r.addEventListener('click', pace);
    r.querySelector('#r-feel').addEventListener('input', (e) => (r.querySelector('#r-feel-v').textContent = e.target.value));
    r.querySelector('#r-save').addEventListener('click', () => {
      const m = mins(), k = kg(r.querySelector('#r-km').value);
      if (!m) { toast('Add the time first'); return; }
      const w = r.querySelector('#r-with')?.checked ? partner : '';
      stage({ kind: 'runs', op: 'add', rows: [[nowKey(), clock(Date.now()), k, (Math.round(m * 100) / 100), r.querySelector('#r-feel').value, w, r.querySelector('#r-note').value.trim()]],
        label: `run ${k} km ${r.querySelector('#r-time').value.trim()}`, marks: { run: true } });
      closeSheet();
    });
  });
}

// ---------- spending ----------
function openSpend() {
  const cats = CFG.spendCategories || ['Other'];
  openSheet('Spending', `
    <label for="s-eur">Amount €</label><input id="s-eur" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
    <label for="s-what">What + where</label><input id="s-what" type="text" placeholder="e.g. Döner, uni">
    <label for="s-cat">Category</label><select id="s-cat">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
    <label for="s-date">Day</label><input id="s-date" type="date" value="${nowKey()}">
    <button class="primary" id="s-save">Save</button>`, (r) => {
    r.querySelector('#s-save').addEventListener('click', () => {
      const e = Number(r.querySelector('#s-eur').value), what = r.querySelector('#s-what').value.trim();
      if (!e || !what) { toast('Amount and what, please'); return; }
      const d = r.querySelector('#s-date').value || nowKey(), cat = r.querySelector('#s-cat').value;
      stage({ kind: 'spend', op: 'add', rows: [[d, clock(Date.now()), e.toFixed(2), what, cat]], label: `spend €${e.toFixed(2)} ${what}` });
      closeSheet();
    });
  });
}

// ---------- piano: start/stop timer, or add minutes by hand ----------
const pianoRow = (start, minutes, note) => {
  const m = Math.max(1, Math.round(minutes)), d = dayKey(start);
  stage({ kind: 'piano', op: 'add', rows: [[d, clock(start), m, note]], label: `piano ${m} min${note ? ' ' + note : ''}`,
    marks: d === nowKey() ? { piano: (todayView().piano || 0) + m } : {} });
};
let pianoTick;
function openPiano() {
  clearInterval(pianoTick);
  const pt = LS.get('pianoTimer', null);
  if (pt) {
    const el = () => sheet().querySelector('#p-clock');
    const tick = () => { const s = Math.floor((Date.now() - pt.start) / 1000); if (el()) el().textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; else clearInterval(pianoTick); };
    openSheet('Playing 🎹', `
      <p class="timer" id="p-clock">0:00</p>
      <p class="sub">since ${clock(pt.start)}</p>
      <label for="p-note">What did you play?</label><input id="p-note" type="text" placeholder="optional, e.g. Unravel">
      <button class="primary" id="p-stop">■ Stop + log</button>
      <button id="p-discard" class="ghost">Discard timer</button>`, (r) => {
      tick(); pianoTick = setInterval(tick, 1000);
      r.querySelector('#p-stop').addEventListener('click', () => {
        LS.remove('pianoTimer'); clearInterval(pianoTick);
        pianoRow(pt.start, (Date.now() - pt.start) / 60e3, r.querySelector('#p-note').value.trim());
        closeSheet(); render();
      });
      const disc = r.querySelector('#p-discard');
      disc.addEventListener('click', () => {
        if (disc.dataset.sure) { LS.remove('pianoTimer'); clearInterval(pianoTick); closeSheet(); render(); return; }
        disc.dataset.sure = '1'; disc.textContent = 'Tap again to throw this session away';
      });
    });
    return;
  }
  openSheet('Piano 🎹', `
    <button class="primary big-btn" id="p-start">▶ Start timer</button>
    <p class="sub">Keeps running when you close the app. Tap 🎹 again to stop.</p>
    <h3>Or add it by hand</h3>
    ${stepper('p-min', 30, 5, 'min')}
    <label for="p-mnote">What did you play?</label><input id="p-mnote" type="text" placeholder="optional">
    <label for="p-date">Day</label><input id="p-date" type="date" value="${nowKey()}">
    <button id="p-add">Add</button>`, (r) => {
    wireSteppers(r);
    r.querySelector('#p-start').addEventListener('click', () => { LS.set('pianoTimer', { start: Date.now() }); closeSheet(); render(); toast('Timer running 🎹 have fun'); });
    r.querySelector('#p-add').addEventListener('click', () => {
      const m = Number(r.querySelector('#p-min').value);
      if (!m) { toast('How many minutes?'); return; }
      const d = r.querySelector('#p-date').value || nowKey();
      // a past day gets noon as its time; today gets now
      pianoRow(d === nowKey() ? Date.now() : Date.parse(d + 'T12:00:00Z'), m, r.querySelector('#p-mnote').value.trim());
      closeSheet();
    });
  });
}
window.openPiano = openPiano;

// ---------- goodnight ----------
function openNight() {
  const at = clock(Date.now() + 15 * 60e3), flossed = todayView().floss;
  openSheet('Goodnight 😴', `
    <p>Logs <b>asleep ~${at}</b> (now + 15 min).</p>
    ${flossed ? '' : '<p class="bad">No floss today yet 😤</p><button id="n-floss">🦷 Flossed, log it too</button>'}
    <button class="primary" id="n-save">Log goodnight</button>`, (r) => {
    r.querySelector('#n-floss')?.addEventListener('click', (e) => { stage({ kind: 'habits', op: 'add', rows: [[nowKey(), clock(Date.now()), 'floss', '1']], label: 'floss', marks: { floss: true } }); e.target.remove(); r.querySelector('.bad')?.remove(); });
    r.querySelector('#n-save').addEventListener('click', () => {
      stage({ kind: 'habits', op: 'add', rows: [[nowKey(), clock(Date.now()), 'asleep', at]], label: `goodnight ${at}` });
      closeSheet();
    });
  });
}

// ---------- gym ----------
const planOf = (type) => (CFG.gymPlan?.[type] || []);
const allPlanned = () => ['A', 'B', 'extra'].flatMap(planOf);
const planItem = (name) => allPlanned().find((p) => p.name === name);
function lastSession(name) {
  const rows = (DATA?.gym || []).filter((r) => r.exercise === name);
  if (!rows.length) return null;
  const d = rows.map((r) => r.date + ' ' + r.time).sort().pop();
  return rows.filter((r) => r.date + ' ' + r.time === d).map((r) => ({ reps: Number(r.reps), kg: Number(r.kg) }));
}
function hint(name) {
  const p = planItem(name), last = lastSession(name);
  if (!p || !last || p.bodyweight) return '';
  const top = Math.max(...last.map((s) => s.kg)), atTop = last.filter((s) => s.kg === top);
  if (atTop.length < p.sets || atTop.some((s) => s.reps < p.reps[1])) return '';
  const step = CFG.kgStep || 2.5;
  return p.assist ? `↓ try ${kg(Math.max(0, top - step))} kg assist` : `↑ try ${kg(top + step)} kg`;
}
const fmtSets = (sets) => sets.map((s) => `${s.reps}×${kg(s.kg)}`).join(', ');

function openGym() {
  const wo = LS.get('workout', null);
  if (!wo) {
    openSheet('Gym', `
      <p>Which workout?</p>
      <div class="pick"><button data-w="A">A</button><button data-w="B">B</button><button data-w="free">Free</button></div>
      <p class="sub">A: ${planOf('A').map((p) => esc(p.name)).join(' · ')}<br>B: ${planOf('B').map((p) => esc(p.name)).join(' · ')}</p>`, (r) => {
      r.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
        LS.set('workout', { start: Date.now(), type: b.dataset.w, sets: {}, list: planOf(b.dataset.w).map((p) => p.name) });
        renderToday(); openGym();
      }));
    });
    return;
  }
  const known = [...new Set([...allPlanned().map((p) => p.name), ...(DATA?.gym || []).map((r) => r.exercise)])].filter((n) => !wo.list.includes(n));
  const mins = Math.round((Date.now() - wo.start) / 60e3);
  const total = Object.values(wo.sets).reduce((n, s) => n + s.length, 0);
  openSheet(`Workout ${wo.type === 'free' ? '' : wo.type} · ${mins} min`, `
    ${wo.list.map((name, i) => {
      const p = planItem(name), last = lastSession(name), done = wo.sets[name] || [];
      const next = done[done.length - 1] || last?.[done.length] || last?.[0] || { reps: p?.reps?.[0] || 10, kg: 0 };
      const h = hint(name);
      return `<section class="ex">
        <div class="ex-head"><b>${esc(name)}</b><span class="sub">${p ? `${p.sets} × ${p.reps[0]}${p.reps[1] !== p.reps[0] ? '–' + p.reps[1] : ''}` : ''}</span></div>
        <div class="sub">${last ? 'last: ' + fmtSets(last) : 'first time'} ${h ? `<span class="good">${h}</span>` : ''}</div>
        ${done.length ? `<ol class="sets">${done.map((s, j) => `<li>${s.reps} × ${kg(s.kg)} kg <button class="x" data-del="${i}:${j}" aria-label="Delete set">✕</button></li>`).join('')}</ol>` : ''}
        <div class="set-row">${stepper('reps' + i, next.reps, 1, 'reps')}${p?.bodyweight ? `<input id="kg${i}" type="hidden" value="0">` : stepper('kg' + i, kg(h && !done.length ? (p.assist ? next.kg - (CFG.kgStep || 2.5) : next.kg + (CFG.kgStep || 2.5)) : next.kg), CFG.kgStep || 2.5, 'kg')}
        <button class="primary small" data-add="${i}">+ Set</button></div>
      </section>`;
    }).join('')}
    <div class="add-ex">
      <select id="g-known"><option value="">Add exercise…</option>${known.map((n) => `<option>${esc(n)}</option>`).join('')}</select>
      <input id="g-new" type="text" placeholder="or a new one">
      <button id="g-add">Add</button>
    </div>
    <button class="primary" id="g-finish">Finish workout · ${total} set${total === 1 ? '' : 's'}</button>
    <button id="g-discard" class="ghost">Discard workout</button>`, (r) => {
    wireSteppers(r);
    const put = (w) => { const y = sheet().scrollTop; LS.set('workout', w); openGym(); sheet().scrollTop = y; };
    r.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const i = b.dataset.add, name = wo.list[i];
      (wo.sets[name] ||= []).push({ reps: Number(r.querySelector('#reps' + i).value) || 0, kg: Number(r.querySelector('#kg' + i).value) || 0 });
      put(wo);
    }));
    r.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const [i, j] = b.dataset.del.split(':').map(Number); wo.sets[wo.list[i]].splice(j, 1); put(wo);
    }));
    r.querySelector('#g-add').addEventListener('click', () => {
      const n = (r.querySelector('#g-new').value.trim() || r.querySelector('#g-known').value).trim();
      if (n && !wo.list.includes(n)) { wo.list.push(n); put(wo); }
    });
    r.querySelector('#g-finish').addEventListener('click', () => {
      const date = dayKey(wo.start), time = clock(wo.start), rows = [];
      for (const name of wo.list) (wo.sets[name] || []).forEach((s, j) => rows.push([date, time, wo.type, name, j + 1, s.reps, kg(s.kg), '']));
      if (!rows.length) { toast('No sets logged yet'); return; }
      const ex = new Set(rows.map((x) => x[3])).size;
      LS.remove('workout');
      stage({ kind: 'gym', op: 'add', rows, label: `gym ${wo.type} · ${ex} exercise${ex === 1 ? '' : 's'}, ${rows.length} sets`, marks: { gym: true } });
      closeSheet();
    });
    const disc = r.querySelector('#g-discard');
    disc.addEventListener('click', () => {
      if (disc.dataset.sure) { LS.remove('workout'); closeSheet(); renderToday(); return; }
      disc.dataset.sure = '1'; disc.textContent = 'Tap again to throw this workout away';
    });
  });
}
