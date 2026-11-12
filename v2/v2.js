// v2 pages: Today (home screen, day picker, tap questions, schedule), Study overview, Notes board, Home (apartment + kitchen).
// Loaded after app.js + log.js; uses their helpers (DATA, CFG, stage, openSheet, csv, mdTable …).

window.viewDay = null; // a day picked in the calendar; null = today
const hhmm = () => clock(Date.now());
const isEvening = () => { const h = Number(hhmm().slice(0, 2)); return h >= 21 || h < (CFG.dayStartHour || 4); };
const stagedQ = () => new Set(staged().map((i) => i.qid).filter(Boolean));

// ---------- Today ----------
window.renderTodayPage = function () {
  if (!DATA || !CFG.files) return;
  const today = DATA.today, k = window.viewDay || today, isToday = k === today;
  drawDayHead(k, isToday);
  drawUpdateCard(isToday);
  drawQuestions(isToday);
  drawSched(k, isToday);
  $('#today').hidden = !isToday;
  if (isToday) window.renderToday();
  const body = $('#day-body');
  body.innerHTML = dayBody(k, isToday);
  body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.open)));
};

function drawDayHead(k, isToday) {
  const s = streakInfo(DATA.days, DATA.today), d = DATA.days[k] || {};
  $('#day-head').innerHTML = `<div class="day-head">
    <button id="pick-day" class="day-btn" aria-label="Pick a day"><b>${short(k)}</b><i>▾</i></button>
    ${isToday ? `<span class="chip ${s.today ? 'fire-chip' : ''}">🔥 ${s.cur}${s.today ? '' : ' · open'}</span>` : `<button id="back-today" class="chip">↩ Today</button>`}
    ${d.score != null ? `<span class="chip">⭐ ${d.score}/10${d.final ? '' : ' ?'}</span>` : ''}
  </div>`;
  $('#pick-day').addEventListener('click', () => openCalendar(k.slice(0, 7)));
  $('#back-today')?.addEventListener('click', () => { window.viewDay = null; render(); });
}

function drawUpdateCard(isToday) {
  const el = $('#upd-card'), u = DATA.update;
  if (!isToday || !u) { el.innerHTML = ''; return; }
  const unseen = u.generated && u.generated !== LS.get('seenUpdate', null), stale = u.date !== DATA.today;
  const at = u.generated ? new Date(u.generated).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: CFG.timezone }) : '';
  el.innerHTML = `<article class="card upd-mini${unseen ? ' new' : ''}" id="open-upd">
    <h2>Daily update · ${short(u.date)}${at ? ' ' + at : ''}${unseen ? ' · <span class="good">new</span>' : ''}</h2>
    <p class="upd-line">${stale ? 'No update yet today. This is the last one.' : md(u.headline || 'Open the update')}</p>
    <span class="chev">›</span></article>`;
  $('#open-upd').addEventListener('click', () => {
    updShown = null;
    openSheet('Daily update', '<section id="update" class="update"></section>', () => renderUpdate());
    setTimeout(render, 0);
  });
}

// ---------- tap questions: worked out from the data here, or written by boss into log/questions.csv ----------
function questions() {
  const today = DATA.today, t = todayView(), done = stagedQ(), out = [], hour = Number(hhmm().slice(0, 2));
  const dismissed = LS.get('qdismiss', {});
  const add = (q) => { if (!done.has(q.id) && dismissed[q.id] !== today) out.push(q); };
  // boss's questions first
  for (const q of DATA.questions || []) {
    if (q.answer || !q.id || !q.text) continue;
    add({ id: 'boss:' + q.id, text: q.text, type: q.kind || 'text', options: (q.options || '').split('|').map((o) => o.trim()).filter(Boolean), from: 'boss',
      answer: (v) => stage({ kind: 'questions', op: 'set', match: { id: q.id }, set: { answer: v, answered: `${fmtKey.format(new Date())} ${hhmm()}` }, label: `answer “${q.text.slice(0, 28)}${q.text.length > 28 ? '…' : ''}” → ${v}`, qid: 'boss:' + q.id }) });
  }
  // nights without a sleep time (last 3; today's own night belongs to 😴 Night)
  const firstSleep = (DATA.habits || []).filter((r) => r.habit === 'asleep').map((r) => r.date).sort()[0];
  for (let i = 1; i <= 3; i++) {
    const D = addDays(today, -i);
    if (!firstSleep || D < firstSleep || DATA.days[D]?.asleep) continue;
    add({ id: 'sleep:' + D, text: `When did you fall asleep on the night of ${short(D)}?`, type: 'time', skip: 'Don’t remember',
      answer: (v) => stage({ kind: 'habits', op: 'add', rows: [[D, hhmm(), 'asleep', v]], label: `asleep ${short(D)} ~${v}`, qid: 'sleep:' + D }) });
  }
  if (hour >= 13 && !t.awake) add({ id: 'awake:' + today, text: 'When did you get up today?', type: 'time',
    answer: (v) => stage({ kind: 'habits', op: 'add', rows: [[today, hhmm(), 'awake', v]], label: `awake ${v}`, qid: 'awake:' + today }) });
  if (isEvening()) {
    const miss = Object.keys(MOUTH).filter((h) => h !== 'mouthwash' && !t[MOUTH_KEY[h]]);
    if (miss.length) add({ id: 'mouth:' + today, text: `Mouth ${mouthCount(t)}/3. Still missing:`, type: 'ticks', options: miss.map((h) => ({ v: h, label: MOUTH[h] })),
      answer: (h) => habit(h, '1', MOUTH[h]) });
    if (!t.mood) add({ id: 'mood:' + today, text: 'Mood today?', type: 'scale', answer: (v) => stage({ kind: 'habits', op: 'add', rows: [[today, hhmm(), 'mood', v]], label: `mood ${v}/5` }) });
    if (!t.energy) add({ id: 'energy:' + today, text: 'Energy today?', type: 'scale', answer: (v) => stage({ kind: 'habits', op: 'add', rows: [[today, hhmm(), 'energy', v]], label: `energy ${v}/5` }) });
  }
  // eating out without a price (last 14 days)
  for (const r of DATA.foodRows || []) {
    if (!/eating out/i.test(r.source || '') || (r.cost_eur ?? '') !== '' || r.date < addDays(today, -14)) continue;
    const id = `price:${r.date}:${r.time}:${r.item}`;
    add({ id, text: `What did “${r.item.length > 40 ? r.item.slice(0, 40) + '…' : r.item}” (${short(r.date)}) cost? Your share, in €.`, type: 'amount', skip: 'Don’t know',
      answer: (v) => stage({ kind: 'food', op: 'set', match: { date: r.date, time: r.time, item: r.item }, set: { cost_eur: v }, label: `price ${r.item.slice(0, 24)} €${v}`, qid: id }) });
  }
  return out;
}
function drawQuestions(isToday) {
  const el = $('#questions');
  if (!isToday) { el.innerHTML = ''; return; }
  const qs = questions();
  if (!qs.length) { el.innerHTML = ''; return; }
  const ctl = (q, i) => {
    if (q.type === 'yesno') return `<div class="q-row"><button data-a="${i}" data-v="yes">Yes</button><button data-a="${i}" data-v="no">No</button></div>`;
    if (q.type === 'scale') return `<div class="scale">${[1, 2, 3, 4, 5].map((n) => `<button data-a="${i}" data-v="${n}">${n}</button>`).join('')}</div>`;
    if (q.type === 'choice') return `<div class="q-row wrap">${q.options.map((o) => `<button data-a="${i}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
    if (q.type === 'ticks') return `<div class="q-row wrap">${q.options.map((o) => `<button data-a="${i}" data-v="${esc(o.v)}">${o.label}</button>`).join('')}</div>`;
    const input = q.type === 'time' ? '<input type="time">' : q.type === 'amount' ? '<input type="number" inputmode="decimal" step="0.01" placeholder="0.00">' : '<input type="text" placeholder="short answer">';
    return `<div class="q-row">${input}<button class="primary small" data-ok="${i}">OK</button></div>`;
  };
  el.innerHTML = `<h3 class="sec-h">Questions <small>${qs.length}</small></h3>` + qs.map((q, i) => `<article class="card q-card" data-q="${i}">
    <div class="q-top"><p>${q.from === 'boss' ? '<span class="q-from">boss</span> ' : ''}${esc(q.text)}</p><button class="x" data-skip="${i}" aria-label="Not now">${q.skip ? esc(q.skip) : '✕'}</button></div>${ctl(q, i)}</article>`).join('');
  el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => qs[Number(b.dataset.a)].answer(b.dataset.v)));
  el.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', () => {
    const q = qs[Number(b.dataset.ok)], v = b.parentElement.querySelector('input').value.trim();
    if (!v) { toast('Fill it in first'); return; }
    q.answer(q.type === 'amount' ? Number(v).toFixed(2) : v);
  }));
  el.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', () => { LS.set('qdismiss', { ...LS.get('qdismiss', {}), [qs[Number(b.dataset.skip)].id]: DATA.today }); render(); }));
}
window.v2Questions = questions;

// ---------- schedule (a copy boss writes into the repo; the app can't read Google Calendar) + deadlines ----------
function drawSched(k, isToday) {
  const el = $('#sched'), s = DATA.sched, today = DATA.today;
  const use = s && Array.isArray(s.items) && (s.date === k || (isToday && s.date === addDays(today, 1)));
  const now = hhmm(), live = use && s.date === today && Number(now.slice(0, 2)) >= (CFG.dayStartHour || 4);
  const rows = use ? s.items.map((it) => { const past = live && (it.end || it.start) <= now, cur = live && it.start <= now && (it.end || it.start) > now;
    return `<li class="${past ? 'past' : cur ? 'cur' : ''} k-${esc(it.kind || 'other')}"><span class="t">${esc(it.start || '')}${it.end ? '–' + esc(it.end) : ''}</span><span class="w">${md(it.title || '')}</span></li>`; }).join('') : '';
  const dl = (isToday ? DATA.deadlines.filter((d) => daysBetween(today, d.date) <= 14).slice(0, 4) : (DATA.allDeadlines || []).filter((d) => d.date === k));
  const dlRows = dl.map((d) => { const n = daysBetween(today, d.date);
    return `<li><span class="${n >= 0 && n <= 3 ? 'bad' : n >= 0 && n <= 7 ? 'warn' : ''}">${esc(d.item)} · ${esc(d.course.split(' ').slice(0, 3).join(' ').replace(/[,:]$/, ''))}</span><span>${n === 0 ? 'today' : n > 0 ? 'in ' + n + ' d' : short(d.date)}</span></li>`; }).join('');
  if (!rows && !dlRows && !isToday) { el.innerHTML = ''; return; }
  el.innerHTML = `<article class="card sched">
    <h2>${use ? (s.date === k ? 'Schedule' : 'Coming up · ' + short(s.date)) : 'Schedule'}${use && s.asOf ? ` <small>as of ${esc(s.asOf)}</small>` : ''}</h2>
    ${rows ? `<ul class="sched-list">${rows}</ul>` : isToday ? '<p class="sub">No schedule for today yet. Boss writes it at the next update or check-in.</p>' : ''}
    ${dlRows ? `<h3 class="dh">${isToday ? 'Deadlines, next 14 days' : 'Deadlines'}</h3><ul class="list">${dlRows}</ul>` : ''}</article>`;
}

// ---------- one day, everything in one spot ----------
function nightOf(k) { // the night that ended on day k
  const a = sleepHours(DATA.days[addDays(k, -1)]?.asleep), w = DATA.days[k]?.awake;
  if (a == null || !w) return null;
  const d = Number(w.split(':')[0]) + Number(w.split(':')[1]) / 60 + 24 - a;
  return d > 0 && d < 16 ? Math.round(d * 10) / 10 : null;
}
function dayBody(k, isToday) {
  const d = isToday ? { ...(DATA.days[k] || {}), ...todayView() } : (DATA.days[k] || {}), today = DATA.today;
  if (k > today) return '<p class="sub pad">Still ahead.</p>';
  const chips = [];
  if (d.study) chips.push(`📚 ${(d.study / 60).toFixed(1)} h`);
  if (d.meals) chips.push(`<span class="${d.protein >= PROTEIN_GOAL() ? 'good' : ''}">🥩 ${Math.round(d.protein)}/${PROTEIN_GOAL()} g</span>`, `🔥 ${Math.round(d.kcal).toLocaleString('en')} kcal`);
  if (k >= MOUTH_START()) chips.push(`<span class="${mouthCount(d) === 3 ? 'good' : ''}">🪥 ${mouthCount(d)}/3</span>`);
  const nl = nightOf(k); if (nl != null) chips.push(`😴 ${nl} h`); else if (d.awake) chips.push(`☀️ ${d.awake}`);
  if (d.showers) chips.push(`🚿 ${d.showers > 1 ? d.showers : '✓'}`);
  if (d.caffeine) chips.push(`☕ ${d.caffeine}`);
  if (d.piano) chips.push(`🎹 ${Math.round(d.piano)}′`);
  if (d.mood || d.energy) chips.push(`🙂 ${d.mood ?? '—'} · ⚡ ${d.energy ?? '—'}`);
  if (d.chores?.length) chips.push(d.chores.map((c) => CHORES[c]).join(' · '));
  let s = chips.length ? `<div class="chips day-chips">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>` : '';
  if (d.score != null && d.why) s += `<p class="sub pad">⭐ ${d.score}/10${d.final ? '' : ' (provisional)'} · ${esc(d.why)}</p>`;
  const crs = Object.entries(d.courses || {}).filter(([, m]) => m >= 1).sort((a, b) => b[1] - a[1]);
  if (d.studyItems?.length || crs.length) s += `<article class="card"><h2>Study</h2>${crs.length ? `<p class="sub">${crs.map(([c, m]) => `${esc(c)} ${(m / 60).toFixed(1)} h`).join(' · ')}</p>` : ''}${d.studyItems?.length ? `<ul class="study-items">${d.studyItems.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</article>`;
  const food = (DATA.foodRows || []).filter((r) => r.date === k);
  if (food.length) s += `<article class="card"><h2>Food</h2><ul class="list">${food.map((r) => `<li><span>${r.time ? `<small>${esc(r.time)}</small> ` : ''}${esc(r.item)}</span><span>${Math.round(Number(r.kcal) || 0)} kcal · ${Math.round(Number(r.protein_g) || 0)} g</span></li>`).join('')}</ul></article>`;
  if (d.gym || d.run) s += `<article class="card"><h2>Training</h2>${trainDay(DATA, k, gymSessions(DATA.gym))}</article>`;
  const sp = (DATA.spends || []).filter((x) => x.date === k);
  if (sp.length) s += `<article class="card"><h2>Spending</h2><ul class="list">${sp.map((x) => `<li><span>${esc(x.what)} <small>${esc(x.cat)}</small></span><span>€${x.eur.toFixed(2)}</span></li>`).join('')}</ul></article>`;
  return s || `<p class="sub pad">${isToday ? 'Nothing logged yet today.' : 'Nothing logged for this day.'}</p>`;
}

// ---------- calendar = the day picker ----------
function openCalendar(month) {
  const today = DATA.today, s = streakInfo(DATA.days, today);
  const dl = new Set((DATA.allDeadlines || []).map((d) => d.date));
  const m1 = month + '-01', dim = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate(), mEnd = month + '-' + String(dim).padStart(2, '0');
  const sel = window.viewDay || today;
  let rows = '';
  for (let w = s.mon(m1); w <= mEnd; w = addDays(w, 7)) {
    rows += '<div class="cal-row">' + span(w, addDays(w, 6)).map((k) => {
      if (k.slice(0, 7) !== month) return '<span class="pc-day out"></span>';
      const d = DATA.days[k] || {};
      const marks = (stOf(DATA.days, k) === 'earned' ? '<i class="m-study"></i>' : '') + (d.gym || d.run ? '<i class="m-train"></i>' : '') + (dl.has(k) ? '<i class="m-dead"></i>' : '');
      return `<button class="pc-day${k === today ? ' now' : ''}${k === sel ? ' sel' : ''}${k > today ? ' future' : ''}" data-k="${k}"><b>${Number(k.slice(8))}</b><span class="marks">${marks}</span></button>`;
    }).join('') + '</div>';
  }
  const title = new Date(m1 + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shift = (n) => { const d = new Date(month + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
  openSheet('Pick a day', `<div class="cal pick-cal">
    <div class="cal-head"><button class="cal-nav" data-nav="-1" aria-label="Previous month">‹</button><b>${title}</b><button class="cal-nav" data-nav="1" aria-label="Next month">›</button></div>
    <div class="cal-row dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>${rows}</div>
    <div class="cal-key"><span><i class="m-study"></i>studied</span><span><i class="m-train"></i>trained</span><span><i class="m-dead"></i>deadline</span></div>
    <button id="cal-today">Back to today</button>`, (r) => {
    r.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => { window.viewDay = b.dataset.k === today ? null : b.dataset.k; closeSheet(); window.scrollTo(0, 0); render(); }));
    r.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => openCalendar(shift(Number(b.dataset.nav)))));
    r.querySelector('#cal-today').addEventListener('click', () => { window.viewDay = null; closeSheet(); render(); });
  });
}

// ---------- Study: overview (streak, coming up, connected share) or the graph ----------
window.renderStudy = function () {
  const sub = LS.get('studySub', 'over');
  const seg = $('#study-sub');
  seg.innerHTML = [['over', 'Overview'], ['graph', 'Graph']].map(([k, l]) => `<button data-s="${k}" class="${k === sub ? 'on' : ''}">${l}</button>`).join('');
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { LS.set('studySub', b.dataset.s); document.body.classList.toggle('graph-on', b.dataset.s === 'graph'); render(); }));
  $('#study-over').hidden = sub !== 'over'; $('#graph').hidden = sub !== 'graph';
  document.body.classList.toggle('graph-on', sub === 'graph');
  if (sub === 'graph') { window.renderGraph?.(); return; }
  const root = $('#study-over'), ctx = ctxFor(); root.textContent = '';
  for (const id of ['streak', 'exams']) { const def = CARDS.find((c) => c.id === id); root.appendChild(fullCard(def, run(def, ctx), ctx)); }
  const el = document.createElement('article'); el.className = 'card'; el.id = 'conn-card';
  el.innerHTML = '<h2>Connected statements</h2><p class="sub">Loading the graph…</p>';
  root.appendChild(el);
  const draw = (st) => {
    if (!st) { el.innerHTML = '<h2>Connected statements</h2><p class="sub">No graph notes found.</p>'; return; }
    const tot = st.reduce((a, c) => a + c.total, 0), con = st.reduce((a, c) => a + c.linked + c.base, 0);
    el.innerHTML = `<h2>Connected statements</h2><div class="big">${con}<small>of ${tot}</small></div>
      <p class="sub">A statement counts when it is linked to others by a chain, or marked as a plain fact with no “why”. Loose ones still need their “Woraus folgt das?”.</p>
      ${st.map((c) => `<div class="conn-row"><div class="conn-top"><span>${esc(c.course)}</span><span>${c.linked + c.base}/${c.total}</span></div>
        <div class="conn-bar"><i class="l" style="width:${pct(c.linked, c.total)}%"></i><i class="b" style="width:${pct(c.base, c.total)}%"></i></div>
        <p class="sub">${c.linked} linked · ${c.base} plain facts · ${c.total - c.linked - c.base} loose</p></div>`).join('')}`;
  };
  if (window.graphStats) window.graphStats().then(draw).catch(() => draw(null)); else draw(null);
};

// ---------- Notes: the dump board ----------
// log/notes.csv (date,time,kind,text,done): done empty = 🟡 open · "YYYY-MM-DD → where" = 🔵 parked (boss filed it) · starts with ✅ = resolved
const noteState = (n) => (!n.done ? 'open' : /^✅/.test(n.done) ? 'done' : 'parked');
window.renderNotes = function () {
  const root = $('#p-notes'), show = LS.get('notesShow', 'active');
  const stagedAdds = staged().filter((i) => i.kind === 'notes' && i.op === 'add' && i.rows[0][2] === 'dump').map((i) => ({ date: i.rows[0][0], time: i.rows[0][1], kind: 'dump', text: i.rows[0][3], done: '', unsaved: true }));
  const edits = staged().filter((i) => i.kind === 'notes' && i.op === 'set');
  const all = [...(DATA.notes || []).filter((n) => n.kind === 'dump').map((n) => { const e = edits.filter((i) => sameRow(n, i.match)).pop(); return e ? { ...n, ...e.set, _orig: n, unsaved: true } : { ...n, _orig: n }; }), ...stagedAdds]
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const count = (st) => all.filter((n) => noteState(n) === st).length;
  const list = all.filter((n) => (show === 'active' ? noteState(n) !== 'done' : noteState(n) === show));
  const where = (n) => n.done.replace(/^✅\s*/, '').replace(/^\d{4}-\d{2}-\d{2}\s*→\s*/, '');
  root.innerHTML = `
    <div class="note-new"><textarea id="nb-text" rows="3" placeholder="Dump it here…"></textarea><button class="primary" id="nb-add">Add</button></div>
    <div class="seg seg-4 note-filter">${[['active', `Active ${count('open') + count('parked')}`], ['open', `🟡 ${count('open')}`], ['parked', `🔵 ${count('parked')}`], ['done', `✅ ${count('done')}`]].map(([k, l]) => `<button data-f="${k}" class="${k === show ? 'on' : ''}">${l}</button>`).join('')}</div>
    <p class="sub">🟡 open, boss hasn’t seen it · 🔵 parked, boss filed it (line below says where) · ✅ resolved</p>
    <div class="board">${list.map((n, i) => { const st = noteState(n);
      return `<article class="note ${st}" data-n="${i}"><p class="n-text">${esc(n.text)}</p>
        ${st !== 'open' ? `<p class="n-where">${st === 'done' ? '✅' : '🔵'} ${esc(where(n)) || 'filed'}</p>` : ''}
        <div class="n-foot"><small>${short(n.date)} ${esc(n.time)}${n.unsaved ? ' · not saved yet' : ''}</small>${n._orig && st !== 'done' ? `<button class="n-ok" data-ok="${i}" aria-label="Resolved">✓</button>` : ''}</div></article>`; }).join('') || '<p class="sub pad">Nothing here.</p>'}</div>`;
  $('#nb-add').addEventListener('click', () => {
    const text = $('#nb-text').value.trim();
    if (!text) { toast('Write something first'); return; }
    stage({ kind: 'notes', op: 'add', rows: [[nowKey(), hhmm(), 'dump', text, '']], label: `💭 ${text.length > 40 ? text.slice(0, 40) + '…' : text}` });
  });
  root.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { LS.set('notesShow', b.dataset.f); render(); }));
  const key = (n) => ({ date: n._orig.date, time: n._orig.time, kind: 'dump', text: n._orig.text });
  root.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const n = list[Number(b.dataset.ok)];
    stage({ kind: 'notes', op: 'set', match: key(n), set: { text: n.text, done: '✅ ' + (n.done || nowKey()) }, label: `resolved: ${n.text.slice(0, 30)}` });
  }));
  root.querySelectorAll('.note').forEach((el) => el.addEventListener('click', () => {
    const n = list[Number(el.dataset.n)];
    if (!n._orig) { toast('Save it first, then you can edit it'); return; }
    openSheet('Edit note', `<textarea id="ne-text" rows="8">${esc(n.text)}</textarea>
      ${n.done ? `<p class="sub">${esc(n.done)}</p>` : ''}
      <button class="primary" id="ne-save">Save text</button>
      ${noteState(n) === 'done' ? '<button id="ne-reopen">Back to parked</button>' : ''}`, (r) => {
      r.querySelector('#ne-save').addEventListener('click', () => { const text = r.querySelector('#ne-text').value.trim(); if (!text) return;
        stage({ kind: 'notes', op: 'set', match: key(n), set: { text, done: n.done }, label: `note text: ${text.slice(0, 30)}` }); closeSheet(); });
      r.querySelector('#ne-reopen')?.addEventListener('click', () => { stage({ kind: 'notes', op: 'set', match: key(n), set: { text: n.text, done: n.done.replace(/^✅\s*/, '') }, label: `reopened: ${n.text.slice(0, 30)}` }); closeSheet(); });
    });
  }));
};

// ---------- Home: apartment + trash + what's in stock ----------
const AREA_HABIT = { dishes: /^dishes/i, trash: /^trash/i, floor: /^floor/i, laundry: /^laundry/i };
function homeAreas() {
  const today = DATA.today, lastTap = {};
  for (const r of DATA.habits || []) if (CHORES[r.habit] && (!lastTap[r.habit] || r.date > lastTap[r.habit])) lastTap[r.habit] = r.date;
  const rows = mdTable(DATA.homeMd).filter((c) => c.length >= 3 && /^\d+$/.test(c[1])).map((c) => {
    let last = (c[2].match(/\d{4}-\d{2}-\d{2}/) || [null])[0];
    const hk = Object.keys(AREA_HABIT).find((h) => AREA_HABIT[h].test(c[0]));
    if (hk && lastTap[hk] && (!last || lastTap[hk] > last)) last = lastTap[hk];
    const every = Number(c[1]), since = last ? daysBetween(last, today) : null;
    return { area: strip(c[0]), every, last, since, cls: since == null ? 'bad' : since > every ? 'bad' : since === every ? 'warn' : 'good' };
  });
  if (rows.length) return rows;
  return Object.entries(CHORES).map(([h, l]) => { const since = lastTap[h] ? daysBetween(lastTap[h], today) : null; return { area: l, every: null, last: lastTap[h], since, cls: since == null || since >= 7 ? 'bad' : since >= 3 ? 'warn' : 'good' }; });
}
function stock() {
  const today = DATA.today, out = [];
  for (const [sec, head] of [['Fridge', '## Fridge'], ['Freezer', '## Freezer'], ['Pantry', '## Pantry'], ['Spices', '## Spices']]) {
    const rows = mdTable(DATA.kitchen, head).slice(1).filter((c) => c.length >= 2 && c[0]);
    const items = rows.map((c) => {
      const amount = strip(c[1] || ''), gone = /❌\s*gone|^gone\b|^~?0\b|^\*?\*?~?0\*?\*?\s*(\(|·|$)|used up|all gone|leer/i.test(amount);
      const dateCell = sec === 'Fridge' ? (c[3] || '') : sec === 'Spices' ? (c[2] || '') : '', iso = (dateCell.match(/\d{4}-\d{2}-\d{2}/) || [null])[0];
      const left = iso ? daysBetween(today, iso) : null;
      return { name: strip(c[0]).replace(/\s*\([^)]*\)/g, '').trim(), amount: amount.split(/ · | \(/)[0].slice(0, 28), gone, iso, left,
        cls: left == null ? '' : left < 0 ? 'warn' : left <= 3 ? 'warn' : '', when: left == null ? '' : left < 0 ? `past date (${dm(iso)})` : left === 0 ? 'use today' : left <= 14 ? `${left} d left` : dm(iso) };
    }).filter((it) => it.name && !it.gone);
    if (items.length) out.push({ sec, items });
  }
  return out;
}
window.renderHome = function () {
  const root = $('#p-home'), areas = homeAreas(), ts = trashStats(DATA.habits, DATA.today), st = stock();
  const state = (DATA.homeMd.match(/\*\*State \(([^)]*)\):\*\*\s*(.*)/) || []);
  const soon = st.flatMap((g) => g.items.filter((it) => it.left != null && it.left <= 3).map((it) => ({ ...it, sec: g.sec }))).sort((a, b) => a.left - b.left);
  root.innerHTML = `
    <article class="card"><div class="card-head"><h2>Apartment</h2><button class="card-btn" id="h-log">Log a chore</button></div>
      ${state[2] ? `<p class="sub">${esc(strip(state[2]))} <small>(${esc(state[1])})</small></p>` : ''}
      <ul class="list">${areas.map((a) => `<li><span>${esc(a.area)}${a.every ? ` <small>every ${a.every} d</small>` : ''}</span><span class="${a.cls}">${a.since == null ? 'never logged' : agoTxt(a.since)}</span></li>`).join('')}</ul></article>
    <article class="card"><div class="card-head"><h2>Trash</h2><button class="card-btn" id="h-trash">Took some out</button></div>
      <ul class="list">${Object.entries(TRASH).map(([k, l]) => { const t = trashLine(ts[k]); return `<li><span>${l.replace(/ \(.*\)$/, '')}</span><span class="${t.cls}">${t.txt}</span></li>`; }).join('')}</ul></article>
    ${soon.length ? `<article class="card"><h2>Use soon</h2><ul class="list">${soon.map((it) => `<li><span>${esc(it.name)} <small>${it.sec}</small></span><span class="${it.cls}">${it.when}</span></li>`).join('')}</ul></article>` : ''}
    <article class="card"><h2>In stock</h2><p class="sub">Read from the kitchen list. To change it, tell boss.</p>
      ${st.map((g, i) => `<details class="stock" ${i === 0 ? 'open' : ''}><summary>${g.sec} <small>${g.items.length}</small></summary>
        <ul class="list">${g.items.map((it) => `<li><span>${esc(it.name)}${it.amount ? ` <small>${esc(it.amount)}</small>` : ''}</span><span class="${it.cls}">${it.when}</span></li>`).join('')}</ul></details>`).join('') || '<p class="sub">No kitchen list found.</p>'}</article>`;
  $('#h-log').addEventListener('click', () => openHome());
  $('#h-trash').addEventListener('click', () => openTrash());
};
