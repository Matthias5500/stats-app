// Graph tab: the study concept graph (courses/*/graph/**/*.md in the data repo), read-only.
// One big graph: course regions → station/topic clusters → concept nodes → claim satellites (zoom levels),
// prerequisite arrows ("Braucht") and chain junctions ("Ketten": premises meet in a dot, one arrow to the result).
// Layout = d3-force (vendor/d3-force.min.js, ISC). Renderer = one canvas, one rAF loop with a dirty flag.
// Our own build; ideas (zoom-gated labels, cluster hulls, depth layout, junctions) from LearnHarness, no code from it.
(() => {
  const GV = 1; // parsed-node cache version: bump when parseNode() changes
  const DEF = { nodeSize: 1, lineWidth: 1, arrow: 1, labelSize: 1, labelZoom: 1.8, claimZoom: 3.2, clusterLabels: true, depth: 'radial' };
  const gs = () => ({ ...DEF, ...LS.get('graphSettings', {}) });
  const saveGs = (p) => LS.set('graphSettings', { ...LS.get('graphSettings', {}), ...p });

  let G = null, loadedFor = null, loading = null, view = null;

  // ---------- load + parse ----------
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  async function listFiles() {
    const root = CFG.files?.graphRoot || 'courses';
    const courses = JSON.parse(await gh(encPath(root), true) || '[]').filter((f) => f.type === 'dir');
    const out = [];
    const walk = async (path, depth) => {
      const list = JSON.parse(await gh(encPath(path), true) || '[]');
      await Promise.all(list.map((f) => (f.type === 'dir' && depth < 2 ? walk(f.path, depth + 1) : (f.type === 'file' && f.name.endsWith('.md') ? out.push(f) : null))));
    };
    await Promise.all(courses.map((c) => walk(c.path + '/graph', 0).catch(() => null)));
    return out;
  }

  const LINK = /\[\[([^\]|#]+)(?:#\^?([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
  const links = (s) => [...s.matchAll(LINK)].map((x) => ({ path: x[1].trim(), claim: x[2] ? x[2].replace(/^\^/, '').trim() : null, label: x[3] || null }));
  const plain = (s) => String(s || '').replace(LINK, (_, p, c, l) => l || p.split('/').pop()).replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s*\^k\d+\s*$/, '').trim();

  function parseNode(text, path) {
    const fm = {};
    let body = text;
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (m) {
      for (const line of m[1].split('\n')) { const k = line.match(/^(\w+):\s*(.*)$/); if (k) fm[k[1]] = k[2].replace(/^"(.*)"$/, '$1').trim(); }
      body = text.slice(m[0].length);
    }
    if (fm.type !== 'concept') return null;
    const id = path.replace(/\.md$/, '');
    const parts = path.split('/'); const gi = parts.indexOf('graph');
    const station = parts.length - gi > 2 ? parts[gi + 1] : null;
    const sec = {}; let cur = null;
    for (const line of body.split('\n')) {
      const h = line.match(/^## (.+)$/);
      if (h) { cur = h[1].trim(); sec[cur] = []; continue; }
      if (!cur) continue;
      if (/^\s*- /.test(line)) sec[cur].push(line.replace(/^\s*- /, '').trim());
      else if (line.trim() && sec[cur].length && /^\s{2,}/.test(line)) sec[cur][sec[cur].length - 1] += ' ' + line.trim();
    }
    const claims = (sec['Aussagen'] || []).map((t, i) => ({ id: (t.match(/\^(k\d+)\s*$/) || [])[1] || 'k' + (i + 1), text: t.replace(/\s*\^k\d+\s*$/, '') }));
    const needs = [...new Set((sec['Braucht'] || []).flatMap((l) => links(l).map((x) => x.path)))];
    const chains = (sec['Ketten'] || []).map((l) => {
      const [lhs, rhs] = l.split(/\s*→\s*/);
      if (rhs == null) return null;
      const premises = lhs.split(/\s+\+\s+/).map((p) => { const L = links(p)[0]; return L ? { path: L.path, claim: L.claim, label: L.label || plain(p) } : { text: plain(p) }; });
      const L = links(rhs)[0], own = rhs.match(/\^(k\d+)/);
      const conclusion = L ? { path: L.path, claim: L.claim, label: L.label || plain(rhs) } : { path: id, claim: own ? own[1] : null, label: plain(rhs) };
      return { premises, conclusion, raw: l };
    }).filter(Boolean);
    const dir = parts[gi - 1];
    let topic = fm.topic || '—';
    if (station && topic.startsWith(station + ' ')) topic = topic.slice(station.length + 1);
    return {
      id, title: (body.match(/^# (.+)$/m) || [])[1]?.trim() || parts[parts.length - 1].replace(/\.md$/, ''),
      course: fm.course || dir, station, topic, status: (fm.status || '⬜').trim(), last_reviewed: fm.last_reviewed || '', last_score: fm.last_score || '',
      claims, needs, chains,
      extra: { 'Verwechslungsgefahr': sec['Verwechslungsgefahr'] || [], 'Seine Fehler': sec['Seine Fehler'] || [], 'Verlauf': sec['Verlauf'] || [] },
    };
  }

  async function loadGraph() {
    const files = await listFiles();
    const parsed = await Promise.all(files.map(async (f) => {
      const c = LS.get('gnode:' + f.path, null);
      if (c && c.sha === f.sha && c.v === GV) return c.r;
      const r = parseNode(await ghRaw(encPath(f.path)), f.path);
      LS.set('gnode:' + f.path, { sha: f.sha, v: GV, r });
      return r;
    }));
    return build(parsed.filter(Boolean));
  }

  // ---------- graph model ----------
  function build(list) {
    const byId = new Map(list.map((n) => [n.id, n]));
    const edges = [];
    for (const n of list) for (const p of n.needs) if (byId.has(p) && p !== n.id) edges.push({ source: p, target: n.id });
    const chains = [];
    for (const n of list) for (const c of n.chains) {
      const prem = c.premises.filter((p) => p.path && byId.has(p.path));
      if (!prem.length || !byId.has(c.conclusion.path)) continue;
      chains.push({ ...c, owner: n.id, prem });
    }
    const deg = new Map(list.map((n) => [n.id, 0]));
    for (const e of edges) { deg.set(e.source, deg.get(e.source) + 1); deg.set(e.target, deg.get(e.target) + 1); }
    for (const c of chains) for (const p of [...c.prem, c.conclusion]) deg.set(p.path, (deg.get(p.path) || 0) + 1);
    // inference depth: longest prerequisite chain below a node (capped, so cycles can't loop forever)
    const depth = new Map(list.map((n) => [n.id, 0]));
    for (let i = 0; i < Math.min(list.length, 12); i++) for (const e of edges) depth.set(e.target, Math.max(depth.get(e.target), Math.min(depth.get(e.source) + 1, 8)));
    const courses = [...new Set(list.map((n) => n.course))].sort();
    const groupKey = (n) => n.course + '|' + (n.station || '') + '|' + n.topic;
    const nodes = list.map((n) => ({ ...n, deg: deg.get(n.id), depth: depth.get(n.id), orphan: !deg.get(n.id), gk: groupKey(n), ci: courses.indexOf(n.course) }));
    const nById = new Map(nodes.map((n) => [n.id, n]));
    const out = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) out.get(e.source).push(e.target);
    return { nodes, nById, edges, chains, courses, leadsTo: out };
  }

  // ---------- layout ----------
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  function courseCenters(g) {
    const R = g.courses.length > 1 ? 55 * Math.sqrt(g.nodes.length) : 0;
    return g.courses.map((_, i) => { const a = (2 * Math.PI * i) / g.courses.length + (innerHeight > innerWidth ? -Math.PI / 2 : Math.PI); return { x: Math.cos(a) * R, y: Math.sin(a) * R }; });
  }
  function layout(g, fresh) {
    const s = gs(), cc = courseCenters(g);
    const saved = fresh ? {} : LS.get('graphPos', {});
    let warm = 0;
    for (const n of g.nodes) {
      const p = saved[n.id];
      if (p) { n.x = p[0]; n.y = p[1]; warm++; continue; }
      const c = cc[n.ci], a = hash(n.id) * 2 * Math.PI, r = 30 + hash(n.id + '#') * 90;
      // a new node next to a positioned neighbour of the same group, else near its course
      const nb = g.nodes.find((m) => m !== n && m.gk === n.gk && saved[m.id]);
      const bx = nb ? saved[nb.id][0] : c.x, by = nb ? saved[nb.id][1] : c.y;
      n.x = bx + Math.cos(a) * (nb ? 25 : r); n.y = by + Math.sin(a) * (nb ? 25 : r);
    }
    const maxD = Math.max(1, ...g.nodes.map((n) => n.depth));
    const groups = () => { const m = new Map(); for (const n of g.nodes) { const q = m.get(n.gk) || { x: 0, y: 0, k: 0 }; q.x += n.x; q.y += n.y; q.k++; m.set(n.gk, q); } return m; };
    const cluster = (alpha) => {
      const m = groups();
      for (const n of g.nodes) {
        const q = m.get(n.gk), c = cc[n.ci];
        if (!n.orphan) { n.vx += (q.x / q.k - n.x) * 0.12 * alpha; n.vy += (q.y / q.k - n.y) * 0.12 * alpha; }
        n.vx += (c.x - n.x) * 0.03 * alpha; n.vy += (c.y - n.y) * 0.03 * alpha;
      }
    };
    const depthF = (alpha) => {
      const rim = cc.map((c, ci) => Math.max(40, ...g.nodes.filter((n) => n.ci === ci && !n.orphan).map((n) => Math.hypot(n.x - c.x, n.y - c.y))));
      for (const n of g.nodes) {
        const c = cc[n.ci];
        if (n.orphan) { // isolated nodes sit on the rim of their course region ("not connected yet")
          const dx = n.x - c.x, dy = n.y - c.y, d = Math.hypot(dx, dy) || 1, want = rim[n.ci] + 22;
          n.vx += (dx / d) * (want - d) * 0.1 * alpha; n.vy += (dy / d) * (want - d) * 0.1 * alpha; continue;
        }
        if (s.depth === 'radial') {
          const dx = n.x - c.x, dy = n.y - c.y, d = Math.hypot(dx, dy) || 1, want = 20 + n.depth * 60;
          n.vx += (dx / d) * (want - d) * 0.08 * alpha; n.vy += (dy / d) * (want - d) * 0.08 * alpha;
        } else if (s.depth === 'vertical') {
          n.vy += (c.y + (maxD / 2 - n.depth) * 60 - n.y) * 0.1 * alpha;
        }
      }
    };
    const sim = d3.forceSimulation(g.nodes)
      .force('link', d3.forceLink(g.edges).id((n) => n.id).distance(64).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-110).distanceMax(380))
      .force('collide', d3.forceCollide(21))
      .force('cluster', cluster).force('depth', depthF)
      .stop();
    if (warm === g.nodes.length) sim.alpha(0.08); else if (warm) sim.alpha(0.4);
    const ticks = warm === g.nodes.length ? 60 : 320;
    for (let i = 0; i < ticks; i++) sim.tick();
    savePos(g);
    return sim;
  }
  const savePos = (g) => LS.set('graphPos', Object.fromEntries(g.nodes.map((n) => [n.id, [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10]])));

  // ---------- geometry ----------
  function hull(pts) {
    if (pts.length < 3) return pts.slice();
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  const ramp = (z, a, b) => Math.max(0, Math.min(1, (z - a) / (b - a)));
  const STATUS = { '🔴': 'bad', '🟡': 'warn', '🟢': 'good', '⬜': 'muted' };
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // ---------- view (canvas, camera, input) ----------
  function makeView(root, g) {
    root.innerHTML = `
      <div class="g-bar">
        <input class="g-search" type="search" placeholder="Search concepts + claims" autocomplete="off" spellcheck="false">
        <button class="icon-btn" data-g="fit" aria-label="Fit graph">⌖</button>
        <button class="icon-btn" data-g="set" aria-label="Graph settings">⚙</button>
      </div>
      <div class="g-chips"></div>
      <div class="g-stage"><canvas></canvas><div class="g-legend"><span class="bad">●</span> gap <span class="warn">●</span> learned <span class="good">●</span> solid <span class="muted">●</span> open</div></div>`;
    const canvas = root.querySelector('canvas'), stage = root.querySelector('.g-stage'), ctx = canvas.getContext('2d');
    const V = { g, cam: LS.get('graphCam', null), w: 0, h: 0, dpr: 1, dirty: false, hover: null, sel: null, q: '', dim: new Set(LS.get('graphDim', [])), sim: null, colors: {} };
    const css = () => { const st = getComputedStyle(document.documentElement); for (const k of ['bg', 'fg', 'muted', 'line', 'accent', 'good', 'warn', 'bad']) V.colors[k] = st.getPropertyValue('--' + k).trim(); V.glass = document.documentElement.dataset.theme === 'glass'; };
    css();
    const mark = () => { if (!V.dirty) { V.dirty = true; requestAnimationFrame(draw); } };
    V.mark = mark;

    // chips: one per course, tap = dim/undim
    const chips = root.querySelector('.g-chips');
    const drawChips = () => {
      chips.innerHTML = g.courses.map((c) => `<button class="chip ${V.dim.has(c) ? 'off' : ''}" data-c="${esc(c)}">${esc(c)} <small>${g.nodes.filter((n) => n.course === c).length}</small></button>`).join('');
    };
    drawChips();
    chips.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; const c = b.dataset.c; V.dim.has(c) ? V.dim.delete(c) : V.dim.add(c); LS.set('graphDim', [...V.dim]); drawChips(); mark(); });
    root.querySelector('.g-search').addEventListener('input', (e) => { V.q = norm(e.target.value.trim()); mark(); });
    root.querySelector('[data-g=fit]').addEventListener('click', () => { fit(); mark(); });
    root.querySelector('[data-g=set]').addEventListener('click', () => settingsSheet(V));

    const visible = (n) => !V.q || norm(n.title).includes(V.q) || norm(n.topic).includes(V.q) || n.claims.some((c) => norm(c.text).includes(V.q));
    const faded = (n) => V.dim.has(n.course);
    V.visible = visible;

    const bounds = () => {
      const vs = g.nodes.filter(visible).length ? g.nodes.filter(visible) : g.nodes;
      const xs = vs.map((n) => n.x), ys = vs.map((n) => n.y);
      const x0 = Math.min(...xs) - 70, x1 = Math.max(...xs) + 70, y0 = Math.min(...ys) - 70, y1 = Math.max(...ys) + 70;
      return { x0, x1, y0, y1, k: Math.min(V.w / (x1 - x0), V.h / (y1 - y0), 3) };
    };
    function fit() {
      if (!V.w) return;
      const b = bounds();
      V.cam = { k: b.k, x: V.w / 2 - b.k * (b.x0 + b.x1) / 2, y: V.h / 2 - b.k * (b.y0 + b.y1) / 2, kFit: b.k };
      saveCam();
    }
    V.fit = fit;
    let camTimer;
    const saveCam = () => { clearTimeout(camTimer); camTimer = setTimeout(() => LS.set('graphCam', V.cam), 400); };
    const resize = () => {
      const r = stage.getBoundingClientRect(); V.dpr = window.devicePixelRatio || 1; V.w = r.width; V.h = r.height;
      canvas.width = Math.round(r.width * V.dpr); canvas.height = Math.round(r.height * V.dpr); canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
      if (!V.w || !V.h) return;
      if (!V.cam || !V.cam.kFit) fit(); else V.cam.kFit = bounds().k; // zoom levels stay relative to this screen
      mark();
    };
    new ResizeObserver(resize).observe(stage);

    const toWorld = (sx, sy) => [(sx - V.cam.x) / V.cam.k, (sy - V.cam.y) / V.cam.k];
    const zoomAt = (sx, sy, f) => {
      const k = Math.max(V.cam.kFit * 0.3, Math.min(V.cam.kFit * 12, V.cam.k * f));
      const [wx, wy] = toWorld(sx, sy);
      V.cam.k = k; V.cam.x = sx - wx * k; V.cam.y = sy - wy * k; saveCam(); mark();
    };
    const nodeR = (n) => (6 + Math.min(4, Math.sqrt(n.deg) * 1.3)) * gs().nodeSize;
    const zr = () => V.cam.k / V.cam.kFit;
    const claimPos = (n, i) => { const k = n.claims.length, a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(k, 1), r = nodeR(n) + 13; return [n.x + Math.cos(a) * r, n.y + Math.sin(a) * r]; };
    const claimIdx = (n, cid) => n.claims.findIndex((c) => c.id === cid);
    V.claimPos = claimPos;

    function pick(sx, sy) {
      const [wx, wy] = toWorld(sx, sy), pad = 10 / V.cam.k, s = gs();
      if (ramp(zr(), s.claimZoom * 0.85, s.claimZoom) > 0.4) {
        let best = null, bd = Infinity;
        for (const n of g.nodes) { if (!visible(n) || faded(n)) continue; n.claims.forEach((c, i) => { const [x, y] = claimPos(n, i), d = Math.hypot(x - wx, y - wy); if (d < 5 + pad && d < bd) { bd = d; best = { n, c }; } }); }
        if (best) return best;
      }
      let best = null, bd = Infinity;
      for (const n of g.nodes) { if (!visible(n) || faded(n)) continue; const d = Math.hypot(n.x - wx, n.y - wy); if (d < nodeR(n) + pad && d < bd) { bd = d; best = n; } }
      return best ? { n: best } : null;
    }

    // pointers: 1 = pan or drag a node, 2 = pinch; a short press without movement = tap
    const ptr = new Map(); let gesture = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId); ptr.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (ptr.size === 1) { const hit = pick(e.offsetX, e.offsetY); gesture = { kind: 'press', x: e.offsetX, y: e.offsetY, hit, cam: { ...V.cam } }; }
      else if (ptr.size === 2) { const [a, b] = [...ptr.values()]; gesture = { kind: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }; releaseDrag(); }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!ptr.has(e.pointerId)) { // mouse hover (desktop)
        const hit = pick(e.offsetX, e.offsetY), h = hit ? (hit.c ? hit.n.id + '#' + hit.c.id : hit.n.id) : null;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        if (h !== V.hover) { V.hover = h; mark(); }
        return;
      }
      ptr.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (!gesture) return;
      if (gesture.kind === 'pinch' && ptr.size === 2) {
        const [a, b] = [...ptr.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        V.cam.x += mx - gesture.mx; V.cam.y += my - gesture.my; zoomAt(mx, my, d / gesture.d);
        Object.assign(gesture, { d, mx, my }); return;
      }
      const dx = e.offsetX - gesture.x, dy = e.offsetY - gesture.y;
      if (gesture.kind === 'press' && Math.hypot(dx, dy) > 5) gesture.kind = gesture.hit && !gesture.hit.c ? 'drag' : 'pan';
      if (gesture.kind === 'pan') { V.cam.x = gesture.cam.x + dx; V.cam.y = gesture.cam.y + dy; saveCam(); mark(); }
      if (gesture.kind === 'drag') {
        const n = gesture.hit.n, [wx, wy] = toWorld(e.offsetX, e.offsetY);
        n.fx = wx; n.fy = wy;
        if (!V.sim) return;
        V.sim.alphaTarget(0.25).restart();
      }
    });
    const releaseDrag = () => { if (gesture?.kind === 'drag') { const n = gesture.hit.n; n.fx = n.fy = null; V.sim?.alphaTarget(0); } };
    const up = (e) => {
      ptr.delete(e.pointerId);
      if (gesture?.kind === 'press' && ptr.size === 0) {
        const hit = gesture.hit;
        V.sel = hit ? hit.n.id : null; mark();
        if (hit) hit.c ? claimSheet(V, hit.n, hit.c) : nodeSheet(V, hit.n);
      }
      releaseDrag();
      if (ptr.size === 0) gesture = null;
      else if (ptr.size === 1) { const [p] = [...ptr.values()]; gesture = { kind: 'pan', x: p[0], y: p[1], cam: { ...V.cam } }; }
    };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { if (V.hover) { V.hover = null; mark(); } });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

    // live physics for dragging (same forces as the layout)
    V.sim = layoutSim;
    if (V.sim) V.sim.on('tick', mark).on('end', () => savePos(g));

    // ---------- draw ----------
    function draw() {
      V.dirty = false;
      if (!V.cam || !V.w) return;
      const s = gs(), c = V.colors, z = zr(), k = V.cam.k, dpr = V.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, V.w, V.h);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * V.cam.x, dpr * V.cam.y);
      const vis = g.nodes.filter(visible), visSet = new Set(vis.map((n) => n.id));
      const alphaOf = (n) => (faded(n) ? 0.12 : 1);
      const sel = V.sel && g.nById.get(V.sel), near = new Set();
      if (sel) { near.add(sel.id); for (const e of g.edges) { if (e.source.id === sel.id) near.add(e.target.id); if (e.target.id === sel.id) near.add(e.source.id); } for (const ch of g.chains) { const ids = [...ch.prem.map((p) => p.path), ch.conclusion.path]; if (ids.includes(sel.id)) ids.forEach((i) => near.add(i)); } }
      const focusA = (id) => (sel && !near.has(id) ? 0.25 : 1);

      // hulls: course (big, faint) → station → topic (neutral tint, so status colours stay readable)
      const groupsOf = (key) => { const m = new Map(); for (const n of vis) { const kk = key(n); if (kk == null) continue; (m.get(kk) || m.set(kk, []).get(kk)).push(n); } return m; };
      const tiers = [
        { key: (n) => n.course, pad: 58, a: 0.035, font: 22, labelA: 1 - ramp(z, 1.0, 1.6), weight: 700 },
        { key: (n) => (n.station ? n.course + '|' + n.station : null), pad: 40, a: 0.04, font: 15, labelA: ramp(z, 0.9, 1.4) * (1 - 0.6 * ramp(z, s.labelZoom * 0.85, s.labelZoom)), weight: 650 },
        { key: (n) => n.gk, pad: 24, a: 0.055, font: 12, labelA: 0.6 * ramp(z, 1.1, 1.6) * (1 - 0.65 * ramp(z, s.labelZoom * 0.85, s.labelZoom)), weight: 500 },
      ];
      const labels = [];
      for (const t of tiers) {
        for (const [key, ns] of groupsOf(t.key)) {
          const pts = hull(ns.map((n) => [n.x, n.y]));
          const fa = Math.min(...ns.map(alphaOf));
          ctx.globalAlpha = t.a * fa * (V.glass ? 1.4 : 1); ctx.fillStyle = c.fg; ctx.strokeStyle = c.fg;
          ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = t.pad * 2;
          ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); if (pts.length > 2) ctx.closePath();
          if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
          ctx.stroke(); if (pts.length > 2) ctx.fill();
          if (s.clusterLabels && t.labelA > 0.02) {
            const cx = ns.reduce((a, n) => a + n.x, 0) / ns.length, cy = Math.min(...ns.map((n) => n.y)) - t.pad * 0.55;
            const name = t === tiers[0] ? ns[0].course : t === tiers[1] ? ns[0].station : ns[0].topic;
            labels.push({ x: cx, y: t === tiers[0] ? ns.reduce((a, n) => a + n.y, 0) / ns.length : cy, text: name, font: t.font, a: t.labelA * fa, weight: t.weight });
          }
        }
      }
      ctx.globalAlpha = 1;

      const lw = (1.1 * s.lineWidth) / k, ah = (7 * s.arrow) / k;
      const arrow = (x0, y0, x1, y1, rEnd, head = true) => {
        const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
        const ex = x1 - ux * rEnd, ey = y1 - uy * rEnd;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(head ? ex - ux * ah * 0.6 : ex, head ? ey - uy * ah * 0.6 : ey); ctx.stroke();
        if (!head) return;
        ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - ux * ah - uy * ah * 0.5, ey - uy * ah + ux * ah * 0.5); ctx.lineTo(ex - ux * ah + uy * ah * 0.5, ey - uy * ah - ux * ah * 0.5); ctx.closePath(); ctx.fill();
      };
      // prerequisite arrows (Braucht: prerequisite → concept)
      ctx.lineWidth = lw; ctx.strokeStyle = c.muted; ctx.fillStyle = c.muted;
      for (const e of g.edges) {
        const a = e.source, b = e.target;
        if (!visSet.has(a.id) || !visSet.has(b.id)) continue;
        ctx.globalAlpha = 0.55 * Math.min(alphaOf(a), alphaOf(b)) * Math.min(focusA(a.id), focusA(b.id));
        arrow(a.x, a.y, b.x, b.y, nodeR(b) + 2 / k);
      }
      // chain junctions (Ketten): premise lines meet headless in a dot, one arrow leaves it
      const claimA = ramp(z, s.claimZoom * 0.85, s.claimZoom);
      const endPt = (p) => { const n = g.nById.get(p.path), i = p.claim ? claimIdx(n, p.claim) : -1; return claimA > 0.5 && i >= 0 ? [...claimPos(n, i), 4] : [n.x, n.y, nodeR(n)]; };
      ctx.strokeStyle = c.accent; ctx.fillStyle = c.accent;
      for (const ch of g.chains) {
        const ns = [...ch.prem.map((p) => g.nById.get(p.path)), g.nById.get(ch.conclusion.path)];
        if (ns.some((n) => !visSet.has(n.id))) continue;
        ctx.globalAlpha = 0.85 * Math.min(...ns.map(alphaOf)) * Math.min(...ns.map((n) => focusA(n.id)));
        const P = ch.prem.map(endPt), C = endPt(ch.conclusion);
        const mx = P.reduce((a, p) => a + p[0], 0) / P.length, my = P.reduce((a, p) => a + p[1], 0) / P.length;
        let jx = (mx + C[0]) / 2, jy = (my + C[1]) / 2;
        if (Math.hypot(jx - C[0], jy - C[1]) < 6) { jx += 14; jy -= 14; } // self-chains: keep the dot visible
        ctx.lineWidth = lw * 1.3; ctx.setLineDash([4 / k, 3 / k]);
        for (const p of P) { const dx = jx - p[0], dy = jy - p[1], d = Math.hypot(dx, dy) || 1; ctx.beginPath(); ctx.moveTo(p[0] + (dx / d) * p[2], p[1] + (dy / d) * p[2]); ctx.lineTo(jx, jy); ctx.stroke(); }
        ctx.setLineDash([]);
        arrow(jx, jy, C[0], C[1], C[2] + 2 / k);
        ctx.beginPath(); ctx.arc(jx, jy, 3.2 / Math.sqrt(k) + 1, 0, 2 * Math.PI); ctx.fill();
      }
      // nodes
      for (const n of vis) {
        const col = c[STATUS[n.status] || 'muted'], r = nodeR(n), hov = V.hover === n.id, isSel = V.sel === n.id;
        ctx.globalAlpha = alphaOf(n) * focusA(n.id);
        if (V.glass || hov || isSel) { ctx.shadowColor = col; ctx.shadowBlur = (hov || isSel ? 26 : 12) * dpr; }
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(n.x, n.y, r * (hov || isSel ? 1.18 : 1), 0, 2 * Math.PI); ctx.fill();
        ctx.shadowBlur = 0;
        if (n.status === '⬜') { ctx.lineWidth = 1.5 / k; ctx.strokeStyle = c.fg; ctx.globalAlpha *= 0.4; ctx.stroke(); }
        if (isSel) { ctx.globalAlpha = 1; ctx.lineWidth = 2 / k; ctx.strokeStyle = c.fg; ctx.beginPath(); ctx.arc(n.x, n.y, r * 1.18 + 3 / k, 0, 2 * Math.PI); ctx.stroke(); }
      }
      // claim satellites (deepest zoom)
      if (claimA > 0.02) {
        for (const n of vis) {
          ctx.globalAlpha = claimA * alphaOf(n) * focusA(n.id);
          ctx.strokeStyle = c.muted; ctx.lineWidth = 0.6 / k;
          n.claims.forEach((cl, i) => {
            const [x, y] = claimPos(n, i), hov = V.hover === n.id + '#' + cl.id;
            ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(x, y); ctx.stroke();
            ctx.fillStyle = hov ? c.accent : c.fg; ctx.beginPath(); ctx.arc(x, y, hov ? 3.4 : 2.4, 0, 2 * Math.PI); ctx.fill();
          });
        }
      }
      ctx.globalAlpha = 1;

      // text in screen space (constant size at any zoom)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const sx = (x) => x * k + V.cam.x, sy = (y) => y * k + V.cam.y;
      for (const L of labels) {
        ctx.globalAlpha = L.a; ctx.fillStyle = L.font > 14 ? c.fg : c.muted;
        let fs = L.font * s.labelSize;
        ctx.font = `${L.weight} ${fs}px system-ui, sans-serif`;
        const tw = ctx.measureText(L.text).width;
        if (tw > V.w - 24) { fs *= (V.w - 24) / tw; ctx.font = `${L.weight} ${fs}px system-ui, sans-serif`; }
        ctx.fillText(L.text, Math.max(12 + Math.min(tw, V.w - 24) / 2, Math.min(V.w - 12 - Math.min(tw, V.w - 24) / 2, sx(L.x))), sy(L.y));
      }
      const nodeA = ramp(z, s.labelZoom * 0.85, s.labelZoom);
      ctx.font = `500 ${11.5 * s.labelSize}px system-ui, sans-serif`; ctx.textBaseline = 'top';
      for (const n of vis) {
        const forced = V.hover === n.id || V.sel === n.id || (sel && near.has(n.id)) || (V.q && visible(n));
        const a = Math.max(nodeA, forced ? 1 : 0) * alphaOf(n) * focusA(n.id);
        if (a < 0.02) continue;
        ctx.globalAlpha = a; ctx.fillStyle = c.fg;
        if (V.glass) { ctx.shadowColor = c.bg; ctx.shadowBlur = 4 * dpr; }
        ctx.fillText(n.title, sx(n.x), sy(n.y) + (nodeR(n) * 1.2 + (n.claims.length ? claimA * 16 : 0)) * k + 3);
        ctx.shadowBlur = 0;
      }
      // hovered claim: its text next to the dot (desktop)
      if (V.hover && V.hover.includes('#')) {
        const [id, cid] = V.hover.split('#'), n = g.nById.get(id), i = claimIdx(n, cid);
        if (n && i >= 0) { const [x, y] = claimPos(n, i); ctx.globalAlpha = 1; ctx.font = `500 ${12 * s.labelSize}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = c.accent; ctx.fillText(plain(n.claims[i].text).slice(0, 90), sx(x) + 8, sy(y) - 6); ctx.textAlign = 'center'; }
      }
      ctx.globalAlpha = 1;
    }
    V.draw = draw;
    V.focus = (id) => { const n = g.nById.get(id); if (!n || !V.cam) return; V.sel = id; const k = Math.max(V.cam.k, V.cam.kFit * gs().labelZoom); V.cam.k = k; V.cam.x = V.w / 2 - n.x * k; V.cam.y = V.h / 2 - n.y * k; saveCam(); mark(); };
    V.restyle = () => { css(); mark(); };
    return V;
  }
  let layoutSim = null;

  // ---------- sheets ----------
  const pill = (n) => `<span class="chip ${STATUS[n.status] || ''}">${esc(n.status)} ${esc({ '🔴': 'gap', '🟡': 'learned', '🟢': 'solid', '⬜': 'open' }[n.status] || '')}</span>`;
  const mdx = (s) => esc(String(s)).replace(/\[\[([^\]|#]+)(?:#\^?([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_, p, c, l) => `<b>${l || p.split('/').pop()}</b>`).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\s*\^k\d+\s*$/, '');
  const goChips = (V, ids) => ids.map((id) => V.g.nById.get(id)).filter(Boolean).map((m) => `<button class="chip ${STATUS[m.status] || ''}" data-go="${esc(m.id)}">${esc(m.status)} ${esc(m.title)}</button>`).join('').replace(/^(.+)$/, '<div class="chips">$1</div>');
  const wireGo = (V) => (root) => root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.go; V.focus(id); nodeSheet(V, V.g.nById.get(id)); }));
  const chainText = (V, ch) => `${ch.premises.map((p) => esc(p.label || p.text || '')).join(' <span class="muted">+</span> ')} <span class="muted">→</span> <b>${esc(ch.conclusion.label || '')}</b>`;
  const chainsOf = (V, n, cid) => V.g.chains.filter((ch) => [...ch.prem, ch.conclusion].some((p) => p.path === n.id && (!cid || p.claim === cid)));

  function nodeSheet(V, n) {
    const leads = V.g.leadsTo.get(n.id) || [], chs = chainsOf(V, n);
    const sec = (title, inner) => (inner ? `<h3>${title}</h3>${inner}` : '');
    const ul = (arr) => (arr.length ? `<ul class="g-list">${arr.map((t) => `<li>${mdx(t)}</li>`).join('')}</ul>` : '');
    openSheet(esc(n.title), `
      <div class="chips">${pill(n)}<span class="chip">${esc(n.course)}${n.station ? ' · ' + esc(n.station) : ''}</span><span class="chip">${esc(n.topic)}</span></div>
      ${n.last_reviewed ? `<p class="sub">Last reviewed ${esc(short(n.last_reviewed))}${n.last_score ? ' · ' + esc(n.last_score) : ''}</p>` : ''}
      ${sec('Aussagen', n.claims.length ? `<ol class="g-list">${n.claims.map((c) => `<li>${mdx(c.text)}</li>`).join('')}</ol>` : '')}
      ${sec('Braucht', goChips(V, n.needs))}
      ${sec('Führt zu', goChips(V, leads))}
      ${sec('Ketten', chs.length ? `<ul class="g-list">${chs.map((ch) => `<li>${chainText(V, ch)}</li>`).join('')}</ul>` : '')}
      ${Object.entries(n.extra).map(([t, arr]) => sec(t, ul(arr))).join('')}
      <button class="primary" data-close-show>Show in graph</button>`, (root) => {
      wireGo(V)(root);
      root.querySelector('[data-close-show]').addEventListener('click', () => { closeSheet(); V.focus(n.id); });
    });
  }
  function claimSheet(V, n, c) {
    const chs = chainsOf(V, n, c.id);
    openSheet(esc(n.title) + ' · Aussage', `
      <div class="chips">${pill(n)}<span class="chip">${esc(n.topic)}</span></div>
      <p class="g-claim">${mdx(c.text)}</p>
      ${chs.length ? `<h3>Ketten</h3><ul class="g-list">${chs.map((ch) => `<li>${chainText(V, ch)}</li>`).join('')}</ul>` : '<p class="sub">No chain uses this claim yet.</p>'}
      ${goChips(V, [n.id])}`, wireGo(V));
  }
  function settingsSheet(V) {
    const s = gs();
    const slider = (key, label, min, max, step) => `<label class="g-slider">${label} <output>${s[key]}</output><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}"></label>`;
    openSheet('Graph settings', `
      ${slider('nodeSize', 'Node size', 0.5, 2, 0.1)}
      ${slider('lineWidth', 'Line width', 0.4, 3, 0.1)}
      ${slider('arrow', 'Arrow length', 0.4, 2.5, 0.1)}
      ${slider('labelSize', 'Label size', 0.7, 1.8, 0.05)}
      ${slider('labelZoom', 'Names appear at zoom', 1, 4, 0.1)}
      ${slider('claimZoom', 'Claims appear at zoom', 1.5, 8, 0.1)}
      <label class="g-check"><input type="checkbox" data-k="clusterLabels" ${s.clusterLabels ? 'checked' : ''}> Cluster labels</label>
      <h3>Depth layout</h3>
      <div class="seg g-depth">${[['radial', 'Radial'], ['vertical', 'Vertical'], ['off', 'Off']].map(([v, l]) => `<button data-depth="${v}" class="${s.depth === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="sub">Radial = basics in the middle, what builds on them further out. Vertical = basics at the bottom.</p>
      <button data-relayout>Reset layout</button>
      <button class="primary" data-close>Done</button>`, (root) => {
      root.querySelectorAll('input[type=range]').forEach((i) => i.addEventListener('input', () => { saveGs({ [i.dataset.k]: Number(i.value) }); i.previousElementSibling.textContent = i.value; V.mark(); }));
      root.querySelector('[data-k=clusterLabels]').addEventListener('change', (e) => { saveGs({ clusterLabels: e.target.checked }); V.mark(); });
      root.querySelectorAll('[data-depth]').forEach((b) => b.addEventListener('click', () => { saveGs({ depth: b.dataset.depth }); relayout(V); settingsSheet(V); }));
      root.querySelector('[data-relayout]').addEventListener('click', () => { relayout(V); toast('Layout reset'); });
      root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
    });
  }
  function relayout(V) {
    V.sim?.stop();
    for (const n of V.g.nodes) { n.fx = n.fy = null; }
    layoutSim = layout(V.g, true);
    V.sim = layoutSim; V.sim.on('tick', V.mark).on('end', () => savePos(V.g));
    V.fit(); V.mark();
  }

  // ---------- entry (called from render() in app.js) ----------
  window.renderGraph = async function () {
    const root = document.getElementById('graph');
    if (typeof d3 === 'undefined') { root.innerHTML = '<p class="status">Graph library missing (vendor/d3-force.min.js).</p>'; return; }
    if (view && loadedFor === DATA?.fetched) { view.restyle(); return; }
    if (loading) return;
    if (!view) root.innerHTML = '<p class="status">Loading graph…</p>';
    loading = loadGraph().then((g) => {
      loadedFor = DATA?.fetched;
      if (!g.nodes.length) { root.innerHTML = '<article class="card"><h2>Graph</h2><p class="sub">No concept nodes yet. They appear once drill writes <code>courses/&lt;Course&gt;/graph/</code> notes.</p></article>'; view = null; return; }
      view?.sim?.stop();
      layoutSim = layout(g, false);
      view = makeView(root, g);
    }).catch((e) => { root.innerHTML = `<p class="status">Couldn’t load the graph: ${esc(e.message)}</p>`; }).finally(() => { loading = null; });
  };
  window.graphThemeChanged = () => view?.restyle();
})();
