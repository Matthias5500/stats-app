// Quick-logs: write rows to the data repo's CSVs (paths from stats.json).
// Every save is one commit starting with "app:" so sessions on the repo side can list what came from here.
// Writes go through a queue kept on the device, so a bad connection (gym wifi) never loses an entry.

const HEADERS = {
  weight: 'date,time,kg,note',
  gym: 'date,time,workout,exercise,set,reps,kg,note',
  runs: 'date,time,km,minutes,feel,with,note',
  habits: 'date,time,habit,value',
  spend: 'date,time,eur,what,category',
};

const cell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
const line = (vals) => vals.map(cell).join(',');
const clock = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: CFG.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const kg = (v) => String(Math.round(Number(v) * 100) / 100);

// ---------- GitHub write ----------
const b64e = (s) => { let bin = ''; new TextEncoder().encode(s).forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };
const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

async function appendRows(job) {
  const { token, repo } = LS.get('conn', {});
  const url = `https://api.github.com/repos/${repo}/contents/${job.path}`;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const g = await fetch(url + '?ref=main', { headers, cache: 'no-store' });
    let text = '', sha;
    if (g.status === 404) text = job.header + '\n';
    else if (g.status === 401 || g.status === 403) throw new Error('auth');
    else if (!g.ok) throw new Error('GitHub ' + g.status);
    else { const j = await g.json(); sha = j.sha; text = b64d(j.content); }
    if (text && !text.endsWith('\n')) text += '\n';
    text += job.lines.join('\n') + '\n';
    const p = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: job.message, content: b64e(text), sha, branch: 'main' }) });
    if (p.ok) { try { localStorage.removeItem('stats.cache:' + job.path); } catch { /* ignore */ } return; }
    if (p.status === 401 || p.status === 403) throw new Error(p.status === 403 ? 'token can’t write: needs Contents: Read and write' : 'auth');
    if (p.status !== 409 && p.status !== 422) throw new Error('GitHub ' + p.status);
    // 409/422 = the file changed in between (e.g. a sync from the computer): read again and retry
  }
  throw new Error('file kept changing, try again');
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  let wrote = false, err = null;
  try {
    for (let q = LS.get('queue', []); q.length; q = LS.get('queue', [])) {
      try { await appendRows(q[0]); } catch (e) { err = e; break; }
      LS.set('queue', LS.get('queue', []).slice(1));
      wrote = true;
    }
  } finally { flushing = false; }
  if (err) toast(`Saved on the phone, not synced yet (${err.message === 'auth' ? 'token rejected' : err instanceof TypeError ? 'offline' : err.message}). Retries automatically.`);
  window.renderToday?.();
  if (wrote && !err) refresh();
}

function save(kind, rows, message) {
  const q = LS.get('queue', []);
  q.push({ path: F(kind), header: HEADERS[kind], lines: rows.map(line), message: 'app: ' + message });
  LS.set('queue', q);
  toast('Saved ✓ ' + message);
  flush();
}

window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (!document.hidden && LS.get('queue', []).length) flush(); });

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
function markToday(field, value = true) { if (!DATA) return; (DATA.days[nowKey()] ||= { kcal: 0, protein: 0, meals: 0 })[field] = value; LS.set('last', DATA); render(); }

// ---------- today bar ----------
window.renderToday = function () {
  const el = $('#today');
  if (!el || !DATA || !CFG.files) return;
  const t = DATA.days[nowKey()] || {};
  const pending = LS.get('queue', []).length;
  const wo = LS.get('workout', null);
  const goal = CFG.proteinGoal;
  el.innerHTML = `
    <div class="chips">
      <span class="chip ${t.protein >= goal ? 'good' : ''}">🍽️ ${Math.round(t.protein || 0)}/${goal} g</span>
      <span class="chip ${t.floss ? 'good' : 'bad'}">🦷 ${t.floss ? '✓' : '✗'}</span>
      <span class="chip ${t.gym || t.run ? 'good' : ''}">${t.gym ? '🏋️ ✓' : '🏋️ –'} ${t.run ? '🏃 ✓' : '🏃 –'}</span>
      ${pending ? `<button class="chip warn" id="retry">⏳ ${pending} to sync</button>` : ''}
    </div>
    <div class="quick">
      <button id="q-floss" ${t.floss ? 'disabled' : ''}>🦷<span>${t.floss ? 'Flossed' : 'Floss'}</span></button>
      <button id="q-gym" class="${wo ? 'live' : ''}">🏋️<span>${wo ? 'Resume' : 'Gym'}</span></button>
      <button id="q-run">🏃<span>Run</span></button>
      <button id="q-weight">⚖️<span>Weight</span></button>
      <button id="q-spend">💸<span>Spend</span></button>
      <button id="q-night">😴<span>Goodnight</span></button>
    </div>`;
  $('#retry')?.addEventListener('click', flush);
  $('#q-floss').addEventListener('click', () => { save('habits', [[nowKey(), clock(Date.now()), 'floss', '1']], 'floss'); markToday('floss'); });
  $('#q-gym').addEventListener('click', openGym);
  $('#q-run').addEventListener('click', openRun);
  $('#q-weight').addEventListener('click', openWeight);
  $('#q-spend').addEventListener('click', openSpend);
  $('#q-night').addEventListener('click', openNight);
};

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
      save('weight', [[nowKey(), clock(Date.now()), v, note]], `weight ${v} kg`);
      DATA.weights.push({ date: nowKey(), kg: Number(v), note }); LS.set('last', DATA);
      closeSheet(); render();
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
      save('runs', [[nowKey(), clock(Date.now()), k, (Math.round(m * 100) / 100), r.querySelector('#r-feel').value, w, r.querySelector('#r-note').value.trim()]],
        `run ${k} km ${r.querySelector('#r-time').value.trim()}`);
      markToday('run'); closeSheet();
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
      save('spend', [[d, clock(Date.now()), e.toFixed(2), what, cat]], `spend €${e.toFixed(2)} ${what}`);
      DATA.spends.push({ date: d, what, cat, eur: e }); LS.set('last', DATA);
      closeSheet(); render();
    });
  });
}

// ---------- goodnight ----------
function openNight() {
  const at = clock(Date.now() + 15 * 60e3), flossed = DATA?.days[nowKey()]?.floss;
  openSheet('Goodnight 😴', `
    <p>Logs <b>asleep ~${at}</b> (now + 15 min).</p>
    ${flossed ? '' : '<p class="bad">No floss today yet 😤</p><button id="n-floss">🦷 Flossed, log it too</button>'}
    <button class="primary" id="n-save">Log goodnight</button>`, (r) => {
    r.querySelector('#n-floss')?.addEventListener('click', (e) => { save('habits', [[nowKey(), clock(Date.now()), 'floss', '1']], 'floss'); markToday('floss'); e.target.remove(); r.querySelector('.bad')?.remove(); });
    r.querySelector('#n-save').addEventListener('click', () => {
      save('habits', [[nowKey(), clock(Date.now()), 'asleep', at]], `goodnight ${at}`);
      markToday('asleep', at); closeSheet();
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
      save('gym', rows, `gym ${wo.type} · ${ex} exercise${ex === 1 ? '' : 's'}, ${rows.length} sets`);
      DATA.gym.push(...rows.map((x) => ({ date: x[0], time: x[1], workout: x[2], exercise: x[3], set: String(x[4]), reps: String(x[5]), kg: x[6] })));
      LS.remove('workout'); markToday('gym'); closeSheet();
    });
    const disc = r.querySelector('#g-discard');
    disc.addEventListener('click', () => {
      if (disc.dataset.sure) { LS.remove('workout'); closeSheet(); renderToday(); return; }
      disc.dataset.sure = '1'; disc.textContent = 'Tap again to throw this workout away';
    });
  });
}
