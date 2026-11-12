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
  notes: 'date,time,kind,text,done',
  questions: 'id,date,kind,text,options,answer,answered',
  food: 'date,time,meal,item,kcal,protein_g,where,source,with,cost_eur,tags,note',
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
  toast((item.op === 'del' ? 'Undo noted: ' : item.op === 'set' ? 'Change noted: ' : 'Noted: ') + item.label + ' · hit Save to keep it');
  rerender();
}
const unstage = (id) => { LS.set('staged', staged().filter((x) => x.id !== id)); rerender(); };
// redraw the open page + the Save pill (the pill sits outside the pages, so it shows on every tab)
const rerender = () => { render(); };

// ---------- GitHub: all staged changes in one commit (git data API) ----------
const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const sameRow = (row, match) => Object.entries(match).every(([k, v]) => (row[k] ?? '') === String(v ?? ''));

function applyOps(text, header, ops) {
  if (!text) text = header + '\n';
  let lines = text.replace(/\n+$/, '').split('\n');
  for (const op of ops) {
    if (op.op === 'add') lines.push(...op.rows.map(line));
    else if (op.op === 'set') {
      // v2: change fields of the newest row that matches (dump text / resolved mark, answer to a question, a missing price)
      const head = csv(lines[0] + '\n' + lines[0])[0] ? Object.keys(csv(lines[0] + '\n' + lines[0])[0]) : lines[0].split(',');
      for (let i = lines.length - 1; i > 0; i--) { const row = csv(lines[0] + '\n' + lines[i])[0] || {}; if (sameRow(row, op.match)) { lines[i] = line(head.map((h) => (h in op.set ? op.set[h] : row[h] ?? ''))); break; } }
    } else {
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
  const api = `${API}/repos/${repo}`;
  const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
  const call = async (path, opts = {}) => {
    const r = await fetch(api + path, { cache: 'no-store', ...opts, headers: { ...H, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 401) throw new Error('auth');
    if (r.status === 403) throw new Error('token can’t write: needs Contents: Read and write');
    return r;
  };
  const byPath = {};
  for (const it of items) (byPath[F(it.kind) || F2(it.kind)] ||= { header: HEADERS[it.kind], ops: [] }).ops.push(it);
  const message = 'app: ' + items.map((i) => (i.op === 'del' ? 'undo ' : i.op === 'set' ? 'edit ' : '') + i.label).join(' · ');
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
  saving = true; rerender();
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
  rerender();
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
  const t = JSON.parse(JSON.stringify(DATA.days[nowKey()] || {}));
  for (const it of staged()) {
    if (it.date !== nowKey()) continue;
    if (it.kind === 'habits' && it.op === 'add') it.rows.forEach(([date, time, habit, value]) => date === nowKey() && habitInto(t, { date, time, habit, value }));
    else Object.assign(t, it.marks || {});
  }
  return t;
}
// one habits.csv row, staged
const habit = (h, value = '1', label = h) => stage({ kind: 'habits', op: 'add', rows: [[nowKey(), clock(Date.now()), h, value]], label });
// ---------- quick buttons: favourites (pinned in ⚙, any number) + smart ones when their moment comes + ＋ for the rest ----------
const hourNow = () => Number(clock(Date.now()).slice(0, 2));
const pendingNotes = (kind) => (DATA.notes || []).filter((n) => !n.done && (!kind || n.kind === kind)).length + staged().filter((i) => i.kind === 'notes' && i.op === 'add' && (!kind || i.rows[0][2] === kind)).length;
// badge(t) → text on the button; live(t) → glowing; smart(t, h) → shows up on its own (only buttons with an obvious "right moment")
const BUTTONS = [
  { id: 'awake', icon: '☀️', label: 'Awake', act: () => habit('awake', clock(Date.now()), `awake ${clock(Date.now())}`), badge: (t) => t.awake && '✓', off: (t) => !!t.awake,
    smart: (t, h) => h >= 4 && h < 13 && !t.awake },
  { id: 'mouth', icon: '🪥', label: 'Mouth', act: () => openMouth(), badge: (t) => `${mouthCount(t)}/3`, done: (t) => mouthCount(t) === 3,
    smart: (t, h) => (h >= 4 && h < 12 && !t.brushAm) || ((h >= 21 || h < 4) && (!t.brushPm || !t.floss)) },
  { id: 'shower', icon: '🚿', label: 'Shower', act: () => habit('shower', '1', 'shower'), badge: (t) => t.showers && (t.showers > 1 ? t.showers : '✓') },
  { id: 'caffeine', icon: '☕', label: 'Caff', act: () => habit('caffeine', '1', 'caffeine'), badge: (t) => t.caffeine || '' },
  { id: 'food', icon: '🍽️', label: 'Food', act: () => openNote('food'), badge: () => pendingNotes('food') ? '⏳' + pendingNotes('food') : '' },
  { id: 'dump', icon: '💭', label: 'Dump', act: () => openNote('dump'), badge: () => pendingNotes('dump') ? '⏳' + pendingNotes('dump') : '' },
  { id: 'gym', icon: '🏋️', label: 'Gym', act: () => openGym(), badge: (t) => (LS.get('workout', null) ? '●' : t.gym && '✓'), live: () => !!LS.get('workout', null),
    smart: () => !!LS.get('workout', null) },
  { id: 'run', icon: '🏃', label: 'Run', act: () => openRun(), badge: (t) => t.run && '✓' },
  { id: 'piano', icon: '🎹', label: 'Piano', act: () => openPiano(), badge: (t) => (LS.get('pianoTimer', null) ? '●' : t.piano && Math.round(t.piano) + '′'), live: () => !!LS.get('pianoTimer', null),
    smart: () => !!LS.get('pianoTimer', null) },
  { id: 'home', icon: '🏠', label: 'Home', act: () => openHome(), badge: (t) => t.chores?.length || '' },
  { id: 'weight', icon: '⚖️', label: 'Weight', act: () => openWeight(), badge: () => (DATA.weights || []).some((w) => w.date === nowKey()) && '✓' },
  { id: 'spend', icon: '💸', label: 'Spend', act: () => openSpend() },
  { id: 'night', icon: '😴', label: 'Night', act: () => openNight(), badge: (t) => t.asleep && '✓', smart: (t, h) => (h >= 22 || h < 4) && !t.asleep },
];
window.BUTTONS = BUTTONS;
const DEFAULT_FAVS = ['mouth', 'shower', 'piano', 'gym', 'spend', 'food', 'dump'];
const favs = () => LS.get('favs', DEFAULT_FAVS).filter((id) => BUTTONS.some((b) => b.id === id));
window.favs = favs;
const btnHtml = (b, t, smart) => {
  const badge = b.badge?.(t);
  return `<button data-b="${b.id}" class="${b.live?.(t) ? 'live' : ''}${b.done?.(t) ? ' done' : ''}${smart ? ' smart' : ''}" ${b.off?.(t) ? 'disabled' : ''}>${b.icon}<span>${b.label}</span>${badge ? `<b class="bdg">${badge}</b>` : ''}${smart ? '<i class="sp">✨</i>' : ''}</button>`;
};
function wireButtons(root, after) {
  root.querySelectorAll('[data-b]').forEach((el) => el.addEventListener('click', () => { after?.(); BUTTONS.find((b) => b.id === el.dataset.b).act(); }));
}
window.renderToday = function () {
  const el = $('#today');
  if (!el || !DATA || !CFG.files) return;
  const t = todayView(), items = staged(), h = hourNow(), f = favs();
  const smart = BUTTONS.filter((b) => !f.includes(b.id) && b.smart?.(t, h));
  const waiting = pendingNotes();
  el.innerHTML = `
    <div class="quick">${f.map((id) => btnHtml(BUTTONS.find((b) => b.id === id), t)).join('')}${smart.map((b) => btnHtml(b, t, true)).join('')}<button id="q-more" class="plus" aria-label="More">＋</button></div>
    ${waiting ? `<p class="waiting">⏳ ${waiting} note${waiting === 1 ? '' : 's'} waiting for boss</p>` : ''}`;
  wireButtons(el);
  $('#q-more').addEventListener('click', openMore);
};
window.renderSavebar = function () {
  const el = $('#savebar'), items = staged();
  if (!el) return;
  el.innerHTML = items.length ? `<button class="save-pill" id="save-pill">${saving ? 'Saving…' : `💾 Save ${items.length}`}</button>` : '';
  $('#save-pill')?.addEventListener('click', openUnsaved);
};
function openMore() {
  const t = todayView();
  openSheet('Log something', `<div class="quick all">${BUTTONS.map((b) => btnHtml(b, t)).join('')}<button id="m-undo">↺<span>Undo</span></button></div>`, (r) => {
    wireButtons(r, closeSheet);
    r.querySelector('#m-undo').addEventListener('click', openEntries);
  });
}
function openUnsaved() {
  const items = staged();
  if (!items.length) { closeSheet(); return; }
  openSheet(`Not saved yet · ${items.length}`, `<ul class="list unsaved-list">${items.map((i) => `<li><span>${i.op === 'del' ? '🗑️ undo ' : i.op === 'set' ? '✏️ ' : ''}${esc(i.label)}</span><button class="x" data-unstage="${i.id}" aria-label="Remove">✕</button></li>`).join('')}</ul>
    <button class="primary" id="save-all" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : `Save ${items.length} change${items.length === 1 ? '' : 's'}`}</button>`, (r) => {
    r.querySelectorAll('[data-unstage]').forEach((b) => b.addEventListener('click', () => { unstage(Number(b.dataset.unstage)); openUnsaved(); }));
    r.querySelector('#save-all').addEventListener('click', () => { closeSheet(); saveAll(); });
  });
}

// ---------- quick notes: rough food descriptions + brain dumps; boss turns them into real entries in the next session ----------
function openNote(kind) {
  const food = kind === 'food';
  openSheet(food ? 'Food 🍽️' : 'Brain dump 💭', `
    <p class="sub">${food ? 'Rough is fine ("2 Semmel with ham + a coffee"). Boss estimates kcal + protein next session.' : 'Anything. Boss files it next session and tells you where it went.'}</p>
    <textarea id="n-text" rows="${food ? 3 : 7}" placeholder="${food ? 'what did you eat?' : 'dump it here…'}"></textarea>
    ${food ? '<label for="n-time">Eaten earlier? (leave empty = now)</label><input id="n-time" type="time">' : ''}
    <button class="primary" id="n-save">Save note</button>`, (r) => {
    setTimeout(() => r.querySelector('#n-text').focus(), 50);
    r.querySelector('#n-save').addEventListener('click', () => {
      const text = r.querySelector('#n-text').value.trim();
      if (!text) { toast('Write something first'); return; }
      let ms = Date.now(); const tv = r.querySelector('#n-time')?.value;
      if (tv) { const [hh, mm] = tv.split(':').map(Number), [nh, nm] = clock(ms).split(':').map(Number); ms -= ((((nh * 60 + nm) - (hh * 60 + mm)) % 1440 + 1440) % 1440) * 60e3; }
      stage({ kind: 'notes', op: 'add', rows: [[dayKey(ms), clock(ms), kind, text, '']], label: `${food ? '🍽️' : '💭'} ${text.length > 40 ? text.slice(0, 40) + '…' : text}` });
      closeSheet();
    });
  });
}

// ---------- undo saved entries (today + yesterday) ----------
function openEntries() {
  const days = [nowKey(), addDays(nowKey(), -1)];
  const pick = (rows) => (rows || []).filter((r) => days.includes(r.date));
  const list = [
    ...pick(DATA.habits).map((r) => ({ kind: 'habits', match: r, label: r.habit === 'asleep' ? `goodnight ${r.value}` : r.habit === 'awake' ? `awake ${r.value}` : /^(mood|energy)$/.test(r.habit) ? `${r.habit} ${r.value}/5` : (r.habit === 'trash' && TRASH[r.value] ? TRASH[r.value] : MOUTH[r.habit] || CHORES[r.habit] || r.habit), marks: r.habit === 'floss' ? { floss: false } : {} })),
    ...pick(DATA.weightRows).map((r) => ({ kind: 'weight', match: r, label: `weight ${r.kg} kg` })),
    ...pick(DATA.runs).map((r) => ({ kind: 'runs', match: r, label: `run ${r.km} km`, marks: { run: false } })),
    ...pick(DATA.spendLog).map((r) => ({ kind: 'spend', match: r, label: `spend €${r.eur} ${r.what}` })),
    ...pick(DATA.notes).filter((r) => !r.done).map((r) => ({ kind: 'notes', match: r, label: `${r.kind === 'food' ? '🍽️' : '💭'} ${r.text.slice(0, 40)}` })),
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

// ---------- mouth hygiene + household ----------
const noIcon = (l) => l.replace(/^\S+\s/, '');
const MOUTH = { brush_am: '🪥 Brushed AM', brush_pm: '🪥 Brushed PM', floss: '🧵 Flossed', mouthwash: '💧 Mouthwash' };
const MOUTH_KEY = { brush_am: 'brushAm', brush_pm: 'brushPm', floss: 'floss', mouthwash: 'mouthwash' };
const mouthButtons = (t) => Object.entries(MOUTH).map(([h, label]) =>
  `<button class="tick${t[MOUTH_KEY[h]] ? ' on' : ''}" data-h="${h}" ${t[MOUTH_KEY[h]] ? 'disabled' : ''}>${label}${t[MOUTH_KEY[h]] ? ' ✓' : ''}${h === 'mouthwash' ? ' <small>bonus</small>' : ''}</button>`).join('');
function openMouth() {
  const t = todayView();
  openSheet('Mouth hygiene 🪥', `<p class="sub">Done = brush AM + brush PM + floss (${mouthCount(t)}/3 today)</p><div class="ticks">${mouthButtons(t)}</div>`, (r) => {
    r.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => { habit(b.dataset.h, '1', MOUTH[b.dataset.h]); openMouth(); }));
  });
}
function openHome() {
  const t = todayView(), last = {};
  for (const r of DATA.habits || []) if (CHORES[r.habit] && (!last[r.habit] || r.date > last[r.habit])) last[r.habit] = r.date;
  openSheet('Household 🏠', `<p class="sub">Tap what you just did.</p><div class="ticks">${Object.entries(CHORES).map(([h, label]) => {
    const done = t.chores?.includes(h), g = last[h] ? daysBetween(last[h], nowKey()) : null;
    return `<button class="tick${done ? ' on' : ''}" data-h="${h}" ${done ? 'disabled' : ''}>${label}${done ? ' ✓' : ` <small>${g == null ? 'never logged' : g === 0 ? 'today' : g + ' d ago'}</small>`}</button>`; }).join('')}</div>`, (r) => {
    r.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.h === 'trash') return openTrash(); habit(b.dataset.h, '1', noIcon(CHORES[b.dataset.h]).toLowerCase()); openHome(); }));
  });
}
// trash: one button per type, tap several in a row (each tap = one row 'trash,<type>')
function openTrash() {
  const today = nowKey(), ts = trashStats(DATA.habits, today), t = todayView();
  const doneToday = new Set((t.trashToday || []));
  openSheet('Trash 🗑️', `<p class="sub">Tap every type you just took out.</p><div class="ticks">${Object.entries(TRASH).map(([k, label]) => {
    const on = doneToday.has(k) || ts[k]?.ago === 0, l = trashLine(ts[k]);
    return `<button class="tick${on ? ' on' : ''}" data-t="${k}" ${on ? 'disabled' : ''}>${label}${on ? ' ✓' : ` <small class="${l.cls}">${l.txt}</small>`}</button>`; }).join('')}</div>`, (r) => {
    r.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { habit('trash', b.dataset.t, 'trash ' + noIcon(TRASH[b.dataset.t]).replace(/ \(.*\)$/, '')); openTrash(); }));
  });
}

// ---------- goodnight: mouth check (judged), mood + energy, asleep = now + 15 min ----------
const scale = (id, label) => `<label>${label}</label><div class="scale" data-scale="${id}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}">${n}</button>`).join('')}</div>`;
function openNight(picked = {}) {
  const at = clock(Date.now() + 15 * 60e3), t = todayView(), n = mouthCount(t);
  const missing = Object.keys(MOUTH).filter((h) => h !== 'mouthwash' && !t[MOUTH_KEY[h]]);
  openSheet('Goodnight 😴', `
    <p>Logs <b>asleep ~${at}</b> (now + 15 min).</p>
    ${n === 3 ? '<p class="good">Mouth 3/3 ✓ proud of you 🪥</p>' : `<p class="bad">Mouth ${n}/3. Missing: ${missing.map((h) => noIcon(MOUTH[h])).join(', ')} 😤</p>
      <div class="ticks">${missing.map((h) => `<button class="tick" data-h="${h}">${MOUTH[h]}, log it</button>`).join('')}</div>`}
    ${scale('mood', 'Mood today')}
    ${scale('energy', 'Energy today')}
    <button class="primary" id="n-save">Log goodnight</button>`, (r) => {
    const pick = { ...picked };
    const paint = () => r.querySelectorAll('[data-scale]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', pick[g.dataset.scale] === b.dataset.v)));
    r.querySelectorAll('[data-scale] button').forEach((b) => b.addEventListener('click', () => { const k = b.parentElement.dataset.scale; pick[k] = pick[k] === b.dataset.v ? undefined : b.dataset.v; paint(); }));
    paint();
    r.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => { habit(b.dataset.h, '1', MOUTH[b.dataset.h]); openNight(pick); }));
    r.querySelector('#n-save').addEventListener('click', () => {
      // goodnight between 04:00 and noon = the night that started on the previous day key (the day rolled over at 04:00)
      const now = clock(Date.now()), hr = Number(now.slice(0, 2)), nk = hr >= (CFG.dayStartHour || 4) && hr < 12 ? addDays(nowKey(), -1) : nowKey();
      const rows = [[nk, now, 'asleep', at]];
      if (pick.mood) rows.push([nk, now, 'mood', pick.mood]);
      if (pick.energy) rows.push([nk, now, 'energy', pick.energy]);
      stage({ kind: 'habits', op: 'add', rows, label: `goodnight ${at}` + (pick.mood ? ` · mood ${pick.mood}` : '') + (pick.energy ? ` · energy ${pick.energy}` : '') });
      closeSheet();
    });
  });
}

// ---------- gym ----------
// no plan targets any more (gymPlan left stats.json 2026-11-02): everything comes from what he actually logged
function gymRecent() { // distinct exercises, most recently done first (later rows of the same workout count as more recent)
  const rows = (DATA?.gym || []).map((r, i) => ({ r, i })).filter(({ r }) => r.exercise);
  rows.sort((a, b) => (b.r.date + ' ' + b.r.time).localeCompare(a.r.date + ' ' + a.r.time) || b.i - a.i);
  return [...new Set(rows.map(({ r }) => r.exercise))];
}
function lastInfo(name) {
  const rows = (DATA?.gym || []).filter((r) => r.exercise === name);
  if (!rows.length) return null;
  const d = rows.map((r) => r.date + ' ' + r.time).sort().pop();
  return { date: d.slice(0, 10), sets: rows.filter((r) => r.date + ' ' + r.time === d).map((r) => ({ reps: Number(r.reps), kg: Number(r.kg) })) };
}
// last time as a mini table (folder cards): Set | kg | Reps
const miniTable = (info) => `<span class="mt"><i>Set</i><i>kg</i><i>Reps</i>${info.sets.map((s, j) => `<i>${j + 1}</i><i>${s.kg ? kg(s.kg) : '—'}</i><i>${s.reps}</i>`).join('')}</span>`;
const fold = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
// el: container · skip: names to leave out · onPick(name) · live: sets of the running workout (count toward "this week")
// layout: recent ones (big buttons) → search → muscle-group folders (body icon, sets this week; inside: cards with last time's table)
function exPicker(el, { skip = [], onPick, allowNew = true, n = 8, live = {} }) {
  const names = gymRecent().filter((x) => !skip.includes(x));
  const btn = (name) => { const info = lastInfo(name);
    return `<button type="button" class="exp-b" data-ex="${esc(name)}"><b>${esc(name)}</b><small>${info ? `${dm(info.date)} · ${shortSets(info.sets)}` : 'never logged'}</small></button>`; };
  const card = (name) => { const info = lastInfo(name);
    return `<button type="button" class="exp-b sm" data-ex="${esc(name)}"><b>${esc(name)}</b>${info ? `<small>last time ${dm(info.date)}</small>${miniTable(info)}` : '<small>never logged</small>'}</button>`; };
  const today = nowKey(), week = groupSets(gymSessions(DATA?.gym), monOf(today), today);
  for (const [x, sets] of Object.entries(live)) week[muscleOf(x)] += sets.length;
  const groups = MUSCLES.map((m) => [m, names.filter((x) => muscleOf(x) === m)]).filter(([, l]) => l.length);
  el.innerHTML = `<div class="exp"><div class="exp-grid exp-recent">${names.slice(0, n).map((x) => btn(x)).join('')}</div>
    <input type="search" class="exp-q" placeholder="${allowNew ? 'Search all, or type a new one…' : 'Search all exercises…'}" autocomplete="off" enterkeyhint="done">
    <div class="exp-grid exp-res"></div>
    <div class="exp-groups">${groups.map(([m, l]) => `<details class="exp-g"><summary>${muscleIcon(m)}<span class="g-n">${m}<small>${l.length} exercise${l.length === 1 ? '' : 's'}</small></span><span class="g-w${week[m] ? '' : ' zero'}">${week[m]} set${week[m] === 1 ? '' : 's'} this week</span></summary><div class="exp-grid">${l.map(card).join('')}</div></details>`).join('')}</div></div>`;
  const q = el.querySelector('.exp-q'), res = el.querySelector('.exp-res'), rec = el.querySelector('.exp-recent'), grp = el.querySelector('.exp-groups');
  const wire = (root) => root.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.ex)));
  const draw = () => {
    const t = fold(q.value.trim());
    rec.hidden = grp.hidden = !!t;
    if (!t) { res.innerHTML = ''; return; }
    const hits = names.filter((x) => fold(x).includes(t) || fold(muscleOf(x)).includes(t));
    const exact = gymRecent().some((x) => fold(x) === t);
    res.innerHTML = hits.map((x) => btn(x)).join('') + (allowNew && !exact ? `<button type="button" class="exp-b exp-new" data-new="1"><b>＋ Add “${esc(q.value.trim())}”</b><small>new exercise · ${muscleOf(q.value.trim())}</small></button>` : '')
      + (!hits.length && !allowNew ? '<p class="sub">No match.</p>' : '');
    wire(res);
    res.querySelector('[data-new]')?.addEventListener('click', () => onPick(q.value.trim()));
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const b = res.querySelector('button'); b?.click(); });
  wire(rec); wire(grp);
}
window.exPicker = exPicker; window.gymRecent = gymRecent;

// sets while logging, like Strong: Set | Previous (last time's set N, grey) | kg | Reps | ✕; rows for last time's sets not done yet stay empty
function logTable(name, done, prev) {
  const n = Math.max(done.length, prev.length), b = done.length > 1 ? bestIdx(done, isAssist(name)) : -1;
  if (!n) return '';
  return `<table class="st log"><thead><tr><th>Set</th><th>Previous</th><th>${isAssist(name) ? 'Assist kg' : 'kg'}</th><th>Reps</th><th></th></tr></thead><tbody>${Array.from({ length: n }, (_, j) => {
    const s = done[j];
    return `<tr class="${s ? '' : 'todo'}${j === b ? ' best' : ''}"><td>${j + 1}</td><td class="prev">${prevTxt(prev[j])}</td><td>${s ? (s.kg ? kg(s.kg) : '—') : ''}</td><td>${s ? s.reps : ''}</td><td>${s ? `<button class="x" data-del="${esc(name)}:${j}" aria-label="Delete set ${j + 1}">✕</button>` : ''}</td></tr>`; }).join('')}</tbody></table>`;
}

function openGym() {
  const wo = LS.get('workout', null);
  if (!wo) {
    // every workout starts empty and he picks what he actually does (workout column = "free")
    openSheet('Gym', `
      <button class="primary big-btn" data-w="free">▶ Start workout</button>
      <p class="sub">Starts the timer. Pick exercises as you go.</p>`, (r) => {
      r.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
        LS.set('workout', { start: Date.now(), type: b.dataset.w, sets: {}, list: [] });
        renderToday(); openGym();
      }));
    });
    return;
  }
  const mins = Math.round((Date.now() - wo.start) / 60e3), dur = wo.dur ?? Math.max(1, mins);
  const total = Object.values(wo.sets).reduce((n, s) => n + s.length, 0), step = CFG.kgStep || 2.5;
  openSheet(`Workout ${wo.type === 'free' ? '' : wo.type} · ${mins} min`, `
    ${wo.list.map((name, i) => {
      const info = lastInfo(name), prev = info?.sets || [], done = wo.sets[name] || [];
      const next = done[done.length - 1] || prev[done.length] || prev[0] || { reps: 10, kg: 0 };
      return `<section class="ex">
        <div class="ex-head">${muscleIcon(muscleOf(name))}<b>${esc(name)}</b><span class="sub">${info ? `last time ${dm(info.date)}` : 'first time'}</span></div>
        ${logTable(name, done, prev)}
        <div class="set-row">${stepper('kg' + i, kg(next.kg), step, 'kg')}${stepper('reps' + i, next.reps, 1, 'reps')}
        <button class="primary small" data-add="${i}">+ Set ${done.length + 1}</button></div>
      </section>`;
    }).join('')}
    <h3>${wo.list.length ? 'Add exercise' : 'Pick an exercise'}</h3>
    <div id="g-pick"></div>
    <h3>Duration</h3>
    ${stepper('g-dur', dur, 5, 'min')}
    <p class="sub">Running since ${clock(wo.start)}. Fix it if you forgot to stop; saved with the workout.</p>
    <button class="primary" id="g-finish">Finish workout · ${total} set${total === 1 ? '' : 's'}</button>
    <button id="g-discard" class="ghost">Discard workout</button>`, (r) => {
    wireSteppers(r);
    // keep a hand-fixed duration across re-renders
    const put = (w) => { const d = Number(r.querySelector('#g-dur').value); if (d && d !== dur) w.dur = d; const y = sheet().scrollTop; LS.set('workout', w); openGym(); sheet().scrollTop = y; };
    r.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const i = b.dataset.add, name = wo.list[i];
      (wo.sets[name] ||= []).push({ reps: Number(r.querySelector('#reps' + i).value) || 0, kg: Number(r.querySelector('#kg' + i).value) || 0 });
      put(wo);
    }));
    r.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.del.lastIndexOf(':'), name = b.dataset.del.slice(0, k); wo.sets[name].splice(Number(b.dataset.del.slice(k + 1)), 1); put(wo);
    }));
    exPicker(r.querySelector('#g-pick'), { skip: wo.list, live: wo.sets, onPick: (n) => {
      if (!n || wo.list.includes(n)) return;
      wo.list.push(n); put(wo);
      sheet().querySelectorAll('.ex')[wo.list.length - 1]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } });
    r.querySelector('#g-finish').addEventListener('click', () => {
      const date = dayKey(wo.start), time = clock(wo.start), rows = [];
      for (const name of wo.list) (wo.sets[name] || []).forEach((s, j) => rows.push([date, time, wo.type, name, j + 1, s.reps, kg(s.kg), '']));
      if (!rows.length) { toast('No sets logged yet'); return; }
      // duration rides in the first row's note ("session 58 min"), so the CSV header stays the same
      // untouched field = real elapsed time now (the field only shows the minutes from the last redraw)
      const v = Number(r.querySelector('#g-dur').value) || 0;
      const m = Math.round(wo.dur == null && v === dur ? Math.max(1, (Date.now() - wo.start) / 60e3) : v);
      if (m > 0) rows[0][7] = `session ${m} min`;
      const ex = new Set(rows.map((x) => x[3])).size;
      LS.remove('workout');
      stage({ kind: 'gym', op: 'add', rows, label: `gym ${wo.type} · ${ex} exercise${ex === 1 ? '' : 's'}, ${rows.length} sets${m > 0 ? `, ${m} min` : ''}`, marks: { gym: true } });
      closeSheet();
    });
    const disc = r.querySelector('#g-discard');
    disc.addEventListener('click', () => {
      if (disc.dataset.sure) { LS.remove('workout'); closeSheet(); renderToday(); return; }
      disc.dataset.sure = '1'; disc.textContent = 'Tap again to throw this workout away';
    });
  });
}
