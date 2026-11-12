// Study → Graph: the concept graph (courses/*/graph/**/*.md in the data repo), read-only.
// Dots = concepts + their statements ("Aussagen", tiny dots from the start). Lines = prerequisites ("Braucht"),
// statement twigs (statement → its concept) and chains ("Ketten": premises → junction → result).
// Four looks (v2 slice 8): web (LearnHarness-like spider web, opens first) · float · rings (tidy tree per course) · tree (bottom-up).
// Labels: exactly ONE level at any zoom (course → topic → concept → statement), placed greedily so they never overlap
// or leave the screen. Glow colour = status. Layout = d3-force (vendor/d3-force.min.js, ISC) or fixed geometry; canvas renderer.
// Ideas from LearnHarness (github.com/amosblomqvist/learnharness), no code from it.
(() => {
  const GV = 2; // parsed-node cache version: bump when parseNode() changes (2 = Basisfakten)
  const LOOKS = [
    ['web', 'Web', 'Spider web: every statement is a tiny dot, branches grow out from an empty middle, no topic boxes.'],
    ['float', 'Float', 'Floating clusters: concepts drift together by topic, faint boxes show the topics.'],
    ['rings', 'Rings', 'Tidy rings per course: course in the middle, then topics, concepts, statements on the outside.'],
    ['tree', 'Tree', 'Bottom-up tree: basics at the bottom, what builds on them above; loose concepts in the bottom row.'],
  ];
  const DEF = { look: 'web', dotSize: 1, lineWidth: 1, labelSize: 1, timing: 1, glow: true };
  const gs = () => ({ ...DEF, ...LS.get('graphSettings2', {}) });
  const saveGs = (p) => LS.set('graphSettings2', { ...LS.get('graphSettings2', {}), ...p });

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
      const [lhs, rhs] = l.replace(/\s*\(auto [^)]*\)\s*$/, '').split(/\s*→\s*/);
      if (rhs == null) return null;
      const premises = lhs.split(/\s+\+\s+/).map((p) => { const L = links(p)[0]; return L ? { path: L.path, claim: L.claim, label: L.label || plain(p) } : { text: plain(p) }; });
      const L = links(rhs)[0], own = rhs.match(/\^(k\d+)/);
      const conclusion = L ? { path: L.path, claim: L.claim, label: L.label || plain(rhs) } : { path: id, claim: own ? own[1] : null, label: plain(rhs) };
      return { premises, conclusion, raw: l };
    }).filter(Boolean);
    // ## Basisfakten: "- ^k1, ^k4" (statements with no "why": definitions, units) → count as handled
    const base = [...new Set((sec['Basisfakten'] || []).flatMap((l) => [...l.matchAll(/\^?(k\d+)/g)].map((x) => x[1])))];
    const dir = parts[gi - 1];
    let topic = fm.topic || '—';
    if (station && topic.startsWith(station + ' ')) topic = topic.slice(station.length + 1);
    return {
      id, title: (body.match(/^# (.+)$/m) || [])[1]?.trim() || parts[parts.length - 1].replace(/\.md$/, ''),
      course: fm.course || dir, station, topic, status: (fm.status || '⬜').trim(), last_reviewed: fm.last_reviewed || '', last_score: fm.last_score || '',
      claims, needs, chains, base,
      extra: { 'Verwechslungsgefahr': sec['Verwechslungsgefahr'] || [], 'Seine Fehler': sec['Seine Fehler'] || [], 'Verlauf': sec['Verlauf'] || [] },
    };
  }

  async function loadGraph() {
    const files = await listFiles();
    const parsed = await Promise.all(files.map(async (f) => {
      const c = LS.get('gnode2:' + f.path, null);
      if (c && c.sha === f.sha && c.v === GV) return c.r;
      const r = parseNode(await ghRaw(encPath(f.path)), f.path);
      LS.set('gnode2:' + f.path, { sha: f.sha, v: GV, r });
      return r;
    }));
    return build(parsed.filter(Boolean));
  }
  async function getGraph() {
    if (G && loadedFor === DATA?.fetched) return G;
    if (!loading) loading = loadGraph().then((g) => { G = g; loadedFor = DATA?.fetched; return g; }).finally(() => { loading = null; });
    return loading;
  }

  // ---------- graph model ----------
  // dots: concepts (kind 'c') + statements (kind 's', id "<concept>#k3", parent concept)
  function build(list) {
    const byId = new Map(list.map((n) => [n.id, n]));
    const courses = [...new Set(list.map((n) => n.course))].sort();
    const concepts = list.map((n) => ({ ...n, kind: 'c', ci: courses.indexOf(n.course), gk: n.course + '|' + (n.station || '') + '|' + n.topic, stmts: [] }));
    const cById = new Map(concepts.map((n) => [n.id, n]));
    const stmts = [];
    for (const n of concepts) n.claims.forEach((c, i) => { const s = { kind: 's', id: n.id + '#' + c.id, cid: c.id, i, text: c.text, parent: n, course: n.course, ci: n.ci, status: n.status, gk: n.gk }; n.stmts.push(s); stmts.push(s); });
    const sById = new Map(stmts.map((s) => [s.id, s]));
    const edges = [];
    for (const n of concepts) for (const p of n.needs) if (cById.has(p) && p !== n.id) edges.push({ a: cById.get(p), b: n });
    // a chain end = the statement if the link names one that exists, else the concept itself
    const endOf = (p) => (p.path && cById.has(p.path) ? (p.claim && sById.get(p.path + '#' + p.claim)) || cById.get(p.path) : null);
    const chains = [];
    for (const n of concepts) for (const c of n.chains) {
      const from = c.premises.map(endOf).filter(Boolean), to = endOf(c.conclusion);
      if (!from.length || !to) continue;
      chains.push({ ...c, owner: n.id, from, to });
    }
    const linked = new Set();
    for (const ch of chains) for (const d of [...ch.from, ch.to]) if (d.kind === 's') linked.add(d.id);
    // inference depth: longest prerequisite chain below a concept (capped, so cycles can't loop forever)
    const depth = new Map(concepts.map((n) => [n.id, 0]));
    for (let i = 0; i < Math.min(concepts.length, 12); i++) for (const e of edges) depth.set(e.b.id, Math.max(depth.get(e.b.id), Math.min(depth.get(e.a.id) + 1, 8)));
    const deg = new Map(concepts.map((n) => [n.id, 0]));
    for (const e of edges) { deg.set(e.a.id, deg.get(e.a.id) + 1); deg.set(e.b.id, deg.get(e.b.id) + 1); }
    for (const n of concepts) { n.depth = depth.get(n.id); n.deg = deg.get(n.id); n.orphan = !n.deg; }
    for (const s of stmts) { s.linked = linked.has(s.id); s.base = !s.linked && s.parent.base.includes(s.cid); }
    const leadsTo = new Map(concepts.map((n) => [n.id, []]));
    for (const e of edges) leadsTo.get(e.a.id).push(e.b.id);
    return { concepts, stmts, dots: [...concepts, ...stmts], cById, sById, nById: cById, edges, chains, courses, leadsTo };
  }

  // per course: statements in total, linked by a chain, marked as base facts (Study → "Connected statements")
  window.graphStats = async function () {
    const g = await getGraph();
    if (!g.stmts.length) return null;
    return g.courses.map((course) => {
      const ss = g.stmts.filter((s) => s.course === course);
      return { course, total: ss.length, linked: ss.filter((s) => s.linked).length, base: ss.filter((s) => s.base).length };
    }).filter((c) => c.total);
  };

  // ---------- layouts: each sets x/y on every dot and returns label anchors ----------
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const topicsOf = (g, course) => {
    const m = new Map();
    for (const n of g.concepts) if (n.course === course) (m.get(n.gk) || m.set(n.gk, { key: n.gk, name: n.topic, station: n.station, nodes: [] }).get(n.gk)).nodes.push(n);
    return [...m.values()].sort((a, b) => (a.station || '').localeCompare(b.station || '') || a.name.localeCompare(b.name, undefined, { numeric: true }));
  };
  const centroid = (ds) => ({ x: ds.reduce((a, d) => a + d.x, 0) / ds.length, y: ds.reduce((a, d) => a + d.y, 0) / ds.length });
  const bbox = (ds) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const d of ds) { x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x); y1 = Math.max(y1, d.y); } return { x0, y0, x1, y1 }; };
  // place per-course blocks in a grid whose shape best matches the screen
  function pack(blocks, aspect, gap) {
    let best = null;
    for (let cols = 1; cols <= blocks.length; cols++) {
      const rows = Math.ceil(blocks.length / cols), cw = Array(cols).fill(0), rh = Array(rows).fill(0);
      blocks.forEach((b, i) => { cw[i % cols] = Math.max(cw[i % cols], b.w); rh[Math.floor(i / cols)] = Math.max(rh[Math.floor(i / cols)], b.h); });
      const W = cw.reduce((a, b) => a + b, 0) + gap * (cols - 1), H = rh.reduce((a, b) => a + b, 0) + gap * (rows - 1);
      const score = Math.abs(Math.log((W / H) / aspect)) + 0.02 * Math.log(W * H);
      if (!best || score < best.score) best = { score, cols, cw, rh };
    }
    blocks.forEach((b, i) => {
      const c = i % best.cols, r = Math.floor(i / best.cols);
      const ox = best.cw.slice(0, c).reduce((a, v) => a + v + gap, 0) + (best.cw[c] - b.w) / 2, oy = best.rh.slice(0, r).reduce((a, v) => a + v + gap, 0) + (best.rh[r] - b.h) / 2;
      const dx = ox - b.box.x0, dy = oy - b.box.y0;
      for (const d of b.dots) { d.x += dx; d.y += dy; }
      for (const a of b.anchors) { a.x += dx; a.y += dy; }
    });
  }
  const sim = (dots, links, forces, ticks) => {
    const s = d3.forceSimulation(dots).force('link', d3.forceLink(links).distance((l) => l.d).strength((l) => l.s)).stop();
    for (const [k, f] of Object.entries(forces)) s.force(k, f);
    for (let i = 0; i < ticks; i++) s.tick();
    for (const d of dots) { delete d.vx; delete d.vy; delete d.index; }
  };
  const twigLinks = (g, d, s) => g.stmts.map((x) => ({ source: x, target: x.parent, d, s }));
  const chainLinks = (g, d, s) => g.chains.flatMap((ch) => ch.from.filter((f) => f !== ch.to).map((f) => ({ source: f, target: ch.to, d, s })));
  const ringStmts = (n, r, a0 = 0, spread = 2 * Math.PI) => n.stmts.forEach((s, i) => { const a = a0 + (spread === 2 * Math.PI ? (spread * i) / n.stmts.length : n.stmts.length === 1 ? spread / 2 : (spread * i) / (n.stmts.length - 1)); s.x = n.x + Math.cos(a) * r; s.y = n.y + Math.sin(a) * r; });

  // web: topics = branches around an empty middle (courses = arcs of the circle), each branch grows outward
  function layWeb(g, aspect) {
    const branches = g.courses.flatMap((c) => topicsOf(g, c).map((t) => ({ ...t, course: c })));
    const w = (t) => 1 + Math.sqrt(t.nodes.length + 0.4 * t.nodes.reduce((a, n) => a + n.stmts.length, 0));
    const gapW = 1.4, total = branches.reduce((a, t) => a + w(t), 0) + gapW * g.courses.length;
    const R0 = Math.max(140, (total * 30) / (2 * Math.PI));
    let cur = -Math.PI / 2, last = null;
    const target = new Map();
    for (const t of branches) {
      if (t.course !== last) { cur += ((gapW / total) * 2 * Math.PI) / (last == null ? 2 : 1); last = t.course; }
      const share = (w(t) / total) * 2 * Math.PI, mid = cur + share / 2; cur += share;
      // a branch: basics near the middle, then outward; every second concept steps a little sideways (twigs off the branch)
      t.nodes.sort((a, b) => a.depth - b.depth || b.stmts.length - a.stmts.length || byTitle(a, b)).forEach((n, j) => {
        const r = R0 + 20 + j * 38, side = j ? (j % 2 ? 1 : -1) * (0.35 + 0.3 * hash(n.id)) : 0, a = mid + side * Math.min(share * 0.42, 60 / r);
        n.x = Math.cos(a) * r; n.y = Math.sin(a) * r; target.set(n, { x: n.x, y: n.y });
        ringStmts(n, 22, a - Math.PI / 2, Math.PI);
      });
    }
    sim(g.dots, [...twigLinks(g, 22, 0.7), ...g.edges.map((e) => ({ source: e.a, target: e.b, d: 60, s: 0.015 })), ...chainLinks(g, 26, 0.1)], {
      charge: d3.forceManyBody().strength((d) => (d.kind === 'c' ? -30 : -12)).distanceMax(70),
      collide: d3.forceCollide((d) => (d.kind === 'c' ? 8 : 5)),
      anchor: (alpha) => { for (const [n, p] of target) { n.vx += (p.x - n.x) * 0.3 * alpha; n.vy += (p.y - n.y) * 0.3 * alpha; } },
      hole: (alpha) => { for (const d of g.dots) { const r = Math.hypot(d.x, d.y) || 1; if (r < R0) { d.vx += (d.x / r) * (R0 - r) * 0.3 * alpha; d.vy += (d.y / r) * (R0 - r) * 0.3 * alpha; } } },
    }, 300);
    const courseA = g.courses.map((c) => { const ns = g.concepts.filter((n) => n.course === c), p = centroid(ns), r = Math.hypot(p.x, p.y) || 1; return { level: 'course', key: c, text: c, x: (p.x / r) * R0 * 0.55, y: (p.y / r) * R0 * 0.55, n: ns.length }; });
    // stretch the circle into an ellipse that matches the screen (wide desktop / tall phone), so less of the screen stays black
    const st = Math.sqrt(clamp(aspect, 0.55, 2.4));
    for (const d of [...g.dots, ...courseA]) { d.x *= st; d.y /= st; }
    return { anchors: courseA, topics: false };
  }

  // float: today's floating layout, tuned (courses closer, topic pull stronger, statements as twigs)
  function layFloat(g, aspect) {
    const R = g.courses.length > 1 ? 34 * Math.sqrt(g.concepts.length) : 0;
    const cc = g.courses.map((_, i) => { const a = (2 * Math.PI * i) / g.courses.length + (aspect < 1 ? -Math.PI / 2 : Math.PI); return { x: Math.cos(a) * R * Math.max(1, aspect) ** 0.5, y: Math.sin(a) * R / Math.max(1, aspect) ** 0.5 }; });
    for (const n of g.concepts) { const c = cc[n.ci], a = hash(n.id) * 2 * Math.PI, r = 20 + hash(n.id + '#') * 70; n.x = c.x + Math.cos(a) * r; n.y = c.y + Math.sin(a) * r; ringStmts(n, 16); }
    const cluster = (alpha) => {
      const m = new Map(); for (const n of g.concepts) { const q = m.get(n.gk) || { x: 0, y: 0, k: 0 }; q.x += n.x; q.y += n.y; q.k++; m.set(n.gk, q); }
      for (const n of g.concepts) { const q = m.get(n.gk), c = cc[n.ci]; n.vx += (q.x / q.k - n.x) * 0.2 * alpha + (c.x - n.x) * 0.04 * alpha; n.vy += (q.y / q.k - n.y) * 0.2 * alpha + (c.y - n.y) * 0.04 * alpha; }
    };
    sim(g.dots, [...twigLinks(g, 16, 0.8), ...g.edges.map((e) => ({ source: e.a, target: e.b, d: 56, s: 0.3 })), ...chainLinks(g, 24, 0.2)], {
      charge: d3.forceManyBody().strength((d) => (d.kind === 'c' ? -60 : -9)).distanceMax(200),
      collide: d3.forceCollide((d) => (d.kind === 'c' ? 10 : 4.6)), cluster,
    }, 320);
    const anchors = [];
    for (const c of g.courses) { const ns = g.dots.filter((d) => d.course === c); const p = centroid(ns); anchors.push({ level: 'course', key: c, text: c, ...p, n: ns.length }); }
    for (const c of g.courses) for (const t of topicsOf(g, c)) { const p = centroid(t.nodes); anchors.push({ level: 'topic', key: t.key, text: t.name, x: p.x, y: Math.min(...t.nodes.map((n) => n.y)) - 18, n: t.nodes.length }); }
    return { anchors, topics: true, hulls: true };
  }

  // rings: per course a tidy radial tree: course (middle) → topics (ring 1) → concepts (ring 2) → statements (ring 3)
  function layRings(g, aspect) {
    const blocks = g.courses.map((c) => {
      const ts = topicsOf(g, c), S = (n) => Math.max(1, n.stmts.length), tot = ts.reduce((a, t) => a + t.nodes.reduce((b, n) => b + S(n), 0), 0) + ts.length * 0.6;
      const r3 = Math.max(70, (tot * 11) / (2 * Math.PI)), r2 = r3 - 28, r1 = Math.max(26, r2 * 0.42);
      const anchors = [{ level: 'course', key: c, text: c, x: 0, y: 0, n: ts.reduce((a, t) => a + t.nodes.length, 0) }], hubs = [];
      let cur = -Math.PI / 2;
      for (const t of ts) {
        const tw = t.nodes.reduce((b, n) => b + S(n), 0), a0 = cur + (0.3 / tot) * 2 * Math.PI, share = (tw / tot) * 2 * Math.PI; cur += share + (0.6 / tot) * 2 * Math.PI;
        const hub = { kind: 'hub', x: Math.cos(a0 + share / 2) * r1, y: Math.sin(a0 + share / 2) * r1, course: c, gk: t.key }; hubs.push(hub);
        const tm = a0 + share / 2; // topic name between its hub and its concepts
        anchors.push({ level: 'topic', key: t.key, text: t.name, x: Math.cos(tm) * (r1 + r2) / 2, y: Math.sin(tm) * (r1 + r2) / 2, n: t.nodes.length });
        let ca = a0;
        for (const n of t.nodes.sort((a, b) => a.depth - b.depth || byTitle(a, b))) {
          const cs = (S(n) / tot) * 2 * Math.PI, mid = ca + cs / 2; ca += cs;
          n.x = Math.cos(mid) * r2; n.y = Math.sin(mid) * r2; n.hub = hub;
          n.stmts.forEach((s, i) => { const a = n.stmts.length === 1 ? mid : ca - cs + (cs * (i + 0.5)) / n.stmts.length; s.x = Math.cos(a) * r3; s.y = Math.sin(a) * r3; });
        }
      }
      const dots = [...g.dots.filter((d) => d.course === c), ...hubs], box = bbox(dots); box.x0 -= 20; box.y0 -= 20; box.x1 += 20; box.y1 += 20;
      return { dots, anchors, hubs, box, w: box.x1 - box.x0, h: box.y1 - box.y0 };
    });
    pack(blocks, aspect, 40);
    return { anchors: blocks.flatMap((b) => b.anchors), hubs: blocks.flatMap((b) => b.hubs), centres: blocks.map((b) => b.anchors[0]), topics: true, levelPx: { topic: 60 } }; // topic names sit close together inside the ring
  }

  // tree: per course, rows by depth (basics at the bottom), barycentre sweeps against crossings; isolated concepts wrap in a bottom row
  function layTree(g, aspect) {
    const blocks = g.courses.map((c) => {
      const ns = g.concepts.filter((n) => n.course === c), loose = ns.filter((n) => n.orphan), tied = ns.filter((n) => !n.orphan);
      const ti = new Map(topicsOf(g, c).map((t, i) => [t.key, i]));
      const rows = []; for (const n of tied) (rows[n.depth] ||= []).push(n);
      for (let i = 0; i < rows.length; i++) rows[i] = (rows[i] || []).sort((a, b) => ti.get(a.gk) - ti.get(b.gk) || byTitle(a, b));
      const fanR = (n) => 14 + 1.6 * n.stmts.length, slot = (n) => Math.max(34, 2 * fanR(n) * Math.sin(0.275 * Math.PI) + 16); // statements fan out above their concept
      const place = (row, y) => { const W = row.reduce((a, n) => a + slot(n), 0); let x = -W / 2; for (const n of row) { n.x = x + slot(n) / 2; n.y = y; x += slot(n); } };
      rows.forEach((r, i) => place(r, -i * 78));
      const nb = (n, up) => g.edges.filter((e) => (up ? e.b === n : e.a === n)).map((e) => (up ? e.a : e.b)).filter((m) => m.course === c);
      for (let sweep = 0; sweep < 6; sweep++) {
        const up = sweep % 2 === 0, order = up ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
        for (const i of order) {
          const r = rows[i]; if (!r.length) continue;
          const bc = new Map(r.map((n) => { const m = nb(n, up); return [n, m.length ? m.reduce((a, q) => a + q.x, 0) / m.length : n.x]; }));
          r.sort((a, b) => bc.get(a) - bc.get(b)); place(r, -i * 78);
        }
      }
      const width = Math.max(260, ...rows.map((r) => r.reduce((a, n) => a + slot(n), 0)));
      let x = -width / 2, y = 78;
      for (const n of loose.sort((a, b) => ti.get(a.gk) - ti.get(b.gk) || byTitle(a, b))) { if (x + slot(n) > width / 2) { x = -width / 2; y += 52; } n.x = x + slot(n) / 2; n.y = y; x += slot(n); }
      for (const n of ns) ringStmts(n, fanR(n), -Math.PI * 0.775, Math.PI * 0.55);
      const dots = g.dots.filter((d) => d.course === c), box = bbox(dots); box.x0 -= 20; box.x1 += 20; box.y0 -= 20; box.y1 += 46;
      const anchors = [{ level: 'course', key: c, text: c, x: (box.x0 + box.x1) / 2, y: box.y1 - 14, n: ns.length }];
      for (const t of topicsOf(g, c)) { const p = centroid(t.nodes); anchors.push({ level: 'topic', key: t.key, text: t.name, x: p.x, y: p.y - 26, n: t.nodes.length }); }
      return { dots, anchors, box, w: box.x1 - box.x0, h: box.y1 - box.y0 };
    });
    pack(blocks, aspect, 50);
    return { anchors: blocks.flatMap((b) => b.anchors), topics: true, arrows: true };
  }

  // median nearest-neighbour distance (world units): tells at which zoom a label level gets room
  function spacing(pts) {
    if (pts.length < 2) return 200;
    const d = pts.map((p) => Math.min(...pts.filter((q) => q !== p).map((q) => Math.hypot(q.x - p.x, q.y - p.y))));
    d.sort((a, b) => a - b); return Math.max(1, d[Math.floor(d.length / 2)]);
  }
  function layout(g, look, aspect) {
    const L = { web: layWeb, float: layFloat, rings: layRings, tree: layTree }[look] || layWeb;
    const res = L(g, aspect);
    // float + tree: widen (or heighten) a picture that is much narrower than the screen, up to 1.6× (rings stay round)
    if (look === 'float' || look === 'tree') {
      const b = bbox(g.dots), ba = (b.x1 - b.x0) / Math.max(1, b.y1 - b.y0), f = clamp(Math.sqrt(aspect / ba), 1 / 1.6, 1.6);
      if (Math.abs(Math.log(f)) > 0.1) for (const d of [...g.dots, ...res.anchors]) { d.x *= f; d.y /= f; }
    }
    const levels = res.topics ? ['course', 'topic', 'concept', 'stmt'] : ['course', 'concept', 'stmt'];
    const sp = { topic: spacing(res.anchors.filter((a) => a.level === 'topic')), concept: spacing(g.concepts), stmt: spacing(g.stmts) };
    return { ...res, look, levels, sp };
  }

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
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const STATUS = { '🔴': 'bad', '🟡': 'warn', '🟢': 'good', '⬜': 'muted' };
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const LEVEL_PX = { topic: 120, concept: 70, stmt: 40 }; // on-screen gap a level needs before its labels show (× zoom timing)
  const FONT = { course: 16, topic: 13, concept: 12, stmt: 11 };

  // ---------- view ----------
  function makeView(root, g) {
    const s0 = gs();
    root.innerHTML = `
      <div class="seg seg-4 g-looks">${LOOKS.map(([k, l]) => `<button data-look="${k}" class="${k === s0.look ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="sub g-look-txt"></p>
      <div class="g-bar">
        <input class="g-search" type="search" placeholder="Search concepts + statements" autocomplete="off" spellcheck="false">
        <button class="icon-btn" data-g="fit" aria-label="Fit graph">⌖</button>
        <button class="icon-btn" data-g="set" aria-label="Graph settings">⚙</button>
      </div>
      <div class="g-chips"></div>
      <div class="g-stage"><canvas></canvas><div class="g-legend"><span class="bad">●</span> gap <span class="warn">●</span> learned <span class="good">●</span> solid <span class="muted">●</span> open</div><div class="g-level"></div></div>`;
    const canvas = root.querySelector('canvas'), stage = root.querySelector('.g-stage'), ctx = canvas.getContext('2d');
    const V = { g, L: null, cam: null, w: 0, h: 0, dpr: 1, dirty: false, hover: null, sel: null, q: '', dim: new Set(LS.get('graphDim', [])), colors: {}, last: null };
    const css = () => { const st = getComputedStyle(document.documentElement); for (const k of ['bg', 'fg', 'muted', 'line', 'accent', 'good', 'warn', 'bad']) V.colors[k] = st.getPropertyValue('--' + k).trim(); V.glass = document.documentElement.dataset.theme === 'glass'; };
    css();
    const mark = () => { if (!V.dirty) { V.dirty = true; requestAnimationFrame(draw); } };
    V.mark = mark;
    const lookTxt = () => { root.querySelector('.g-look-txt').textContent = LOOKS.find(([k]) => k === gs().look)[2]; };
    lookTxt();

    const chips = root.querySelector('.g-chips');
    const drawChips = () => { chips.innerHTML = g.courses.map((c) => `<button class="chip ${V.dim.has(c) ? 'off' : ''}" data-c="${esc(c)}">${esc(c)} <small>${g.concepts.filter((n) => n.course === c).length}</small></button>`).join(''); };
    drawChips();
    chips.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; const c = b.dataset.c; V.dim.has(c) ? V.dim.delete(c) : V.dim.add(c); LS.set('graphDim', [...V.dim]); drawChips(); mark(); });
    root.querySelector('.g-search').addEventListener('input', (e) => { V.q = norm(e.target.value.trim()); mark(); });
    root.querySelector('[data-g=fit]').addEventListener('click', () => { fit(); mark(); });
    root.querySelector('[data-g=set]').addEventListener('click', () => settingsSheet(V));
    root.querySelector('.g-looks').addEventListener('click', (e) => {
      const b = e.target.closest('[data-look]'); if (!b) return;
      saveGs({ look: b.dataset.look }); root.querySelectorAll('[data-look]').forEach((x) => x.classList.toggle('on', x === b)); lookTxt(); relayout(); fit(); mark();
    });

    const conceptOf = (d) => (d.kind === 's' ? d.parent : d);
    const visible = (d) => { if (!V.q) return true; const n = conceptOf(d); return norm(n.title).includes(V.q) || norm(n.topic).includes(V.q) || n.claims.some((c) => norm(c.text).includes(V.q)); };
    const faded = (d) => V.dim.has(d.course);

    function relayout() { V.L = layout(g, gs().look, V.w && V.h ? V.w / V.h : innerWidth / Math.max(1, innerHeight - 260)); }
    const bounds = () => {
      const vs = g.dots.filter(visible).length ? g.dots.filter(visible) : g.dots, b = bbox([...vs, ...(V.L.anchors || []).filter((a) => a.level === 'course')]);
      const pad = 26, x0 = b.x0 - pad, x1 = b.x1 + pad, y0 = b.y0 - pad, y1 = b.y1 + pad;
      return { x0, x1, y0, y1, k: Math.min(V.w / (x1 - x0), V.h / (y1 - y0), 6) };
    };
    function fit() {
      if (!V.w) return;
      const b = bounds();
      V.cam = { k: b.k, x: V.w / 2 - b.k * (b.x0 + b.x1) / 2, y: V.h / 2 - b.k * (b.y0 + b.y1) / 2, kFit: b.k };
    }
    V.fit = fit;
    // zoom where each label level starts (index = level); ≥ 1.3× apart so every level gets its own band
    const levelKs = () => {
      const s = gs(), L = V.L, ks = [0];
      L.levels.slice(1).forEach((lv, i) => { const want = ((L.levelPx?.[lv] || LEVEL_PX[lv]) * s.timing) / L.sp[lv]; ks.push(Math.max(want, i ? ks[i] * 1.5 : V.cam.kFit * 1.3)); });
      return ks;
    };
    V.levelKs = levelKs;
    const resize = () => {
      const r = stage.getBoundingClientRect(); V.dpr = window.devicePixelRatio || 1; V.w = r.width; V.h = r.height;
      canvas.width = Math.round(r.width * V.dpr); canvas.height = Math.round(r.height * V.dpr); canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
      if (!V.w || !V.h) return;
      if (!V.L) relayout();
      if (!V.cam) fit(); else V.cam.kFit = bounds().k;
      mark();
    };
    new ResizeObserver(resize).observe(stage);
    requestAnimationFrame(resize); V.resize = resize;

    const toWorld = (sx, sy) => [(sx - V.cam.x) / V.cam.k, (sy - V.cam.y) / V.cam.k];
    const kMax = () => Math.max(V.cam.kFit * 12, levelKs().slice(-1)[0] * 5);
    const zoomAt = (sx, sy, f) => {
      const k = clamp(V.cam.k * f, V.cam.kFit * 0.5, kMax()), [wx, wy] = toWorld(sx, sy);
      V.cam.k = k; V.cam.x = sx - wx * k; V.cam.y = sy - wy * k; mark();
    };
    // dot radius on screen (px): grows a little with zoom, stays tiny far out (LearnHarness look)
    const dotR = (d) => { const s = gs(), k = V.cam.k, web = V.L.look === 'web';
      return (d.kind === 's' ? clamp(2.2 * k, 1.6, 5) : clamp((web ? 3.4 : 5) * k, web ? 2.4 : 3, web ? 7 : 9)) * s.dotSize; };

    function pick(sx, sy) {
      let best = null, bd = Infinity;
      for (const d of g.dots) {
        if (!visible(d) || faded(d)) continue;
        const dx = d.x * V.cam.k + V.cam.x - sx, dy = d.y * V.cam.k + V.cam.y - sy, dist = Math.hypot(dx, dy);
        if (dist < dotR(d) + 10 && dist < bd) { bd = dist; best = d; }
      }
      return best;
    }

    // pointers: 1 = pan, 2 = pinch; a short press without movement = tap
    const ptr = new Map(); let gesture = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId); ptr.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (ptr.size === 1) gesture = { kind: 'press', x: e.offsetX, y: e.offsetY, hit: pick(e.offsetX, e.offsetY), cam: { ...V.cam } };
      else if (ptr.size === 2) { const [a, b] = [...ptr.values()]; gesture = { kind: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }; }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!ptr.has(e.pointerId)) { const hit = pick(e.offsetX, e.offsetY), h = hit ? hit.id : null; canvas.style.cursor = hit ? 'pointer' : 'grab'; if (h !== V.hover) { V.hover = h; mark(); } return; }
      ptr.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (!gesture) return;
      if (gesture.kind === 'pinch' && ptr.size === 2) {
        const [a, b] = [...ptr.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        V.cam.x += mx - gesture.mx; V.cam.y += my - gesture.my; zoomAt(mx, my, d / gesture.d);
        Object.assign(gesture, { d, mx, my }); return;
      }
      const dx = e.offsetX - gesture.x, dy = e.offsetY - gesture.y;
      if (gesture.kind === 'press' && Math.hypot(dx, dy) > 5) gesture.kind = 'pan';
      if (gesture.kind === 'pan') { V.cam.x = gesture.cam.x + dx; V.cam.y = gesture.cam.y + dy; mark(); }
    });
    const up = (e) => {
      ptr.delete(e.pointerId);
      if (gesture?.kind === 'press' && ptr.size === 0) {
        const hit = gesture.hit;
        V.sel = hit ? conceptOf(hit).id : null; mark();
        if (hit) hit.kind === 's' ? claimSheet(V, hit.parent, hit) : nodeSheet(V, hit);
      }
      if (ptr.size === 0) gesture = null;
      else if (ptr.size === 1) { const [p] = [...ptr.values()]; gesture = { kind: 'pan', x: p[0], y: p[1], cam: { ...V.cam } }; }
    };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { if (V.hover) { V.hover = null; mark(); } });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

    // ---------- draw ----------
    function draw() {
      V.dirty = false;
      if (!V.cam || !V.w || !V.L) return;
      const s = gs(), c = V.colors, L = V.L, k = V.cam.k, dpr = V.dpr;
      const sx = (x) => x * k + V.cam.x, sy = (y) => y * k + V.cam.y;
      const probe = { labels: [], dots: [], segs: [], level: null, levels: new Set() };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, V.w, V.h);
      const vis = g.dots.filter(visible), visSet = new Set(vis.map((d) => d.id));
      const sel = V.sel && g.cById.get(V.sel), near = new Set();
      if (sel) { near.add(sel.id); for (const e of g.edges) { if (e.a === sel) near.add(e.b.id); if (e.b === sel) near.add(e.a.id); } for (const ch of g.chains) { const ns = [...ch.from, ch.to].map(conceptOf); if (ns.includes(sel)) ns.forEach((n) => near.add(n.id)); } }
      const alphaOf = (d) => (faded(d) ? 0.12 : 1) * (sel && !near.has(conceptOf(d).id) ? 0.25 : 1);
      const colOf = (d) => c[STATUS[d.status] || 'muted'];
      const onScreen = (x, y, m = 40) => x > -m && y > -m && x < V.w + m && y < V.h + m;

      // glow: soft light behind every concept in its status colour (areas blend: grey → yellow → green)
      if (s.glow) {
        ctx.globalCompositeOperation = 'lighter';
        const R = Math.max(L.look === 'web' ? 46 : 38, 34 / k) * k;
        for (const n of vis) {
          if (n.kind !== 'c') continue;
          const x = sx(n.x), y = sy(n.y); if (!onScreen(x, y, R)) continue;
          const gr = ctx.createRadialGradient(x, y, 0, x, y, R);
          gr.addColorStop(0, colOf(n)); gr.addColorStop(1, 'transparent');
          ctx.globalAlpha = (n.status === '⬜' ? 0.07 : 0.13) * (faded(n) ? 0.2 : 1); ctx.fillStyle = gr; ctx.fillRect(x - R, y - R, 2 * R, 2 * R);
        }
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      }
      // topic hulls (float look only)
      if (L.hulls) {
        const m = new Map(); for (const n of vis) if (n.kind === 'c') (m.get(n.gk) || m.set(n.gk, []).get(n.gk)).push(n);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        for (const ns of m.values()) {
          const pts = hull(ns.flatMap((n) => [n, ...n.stmts]).map((d) => [sx(d.x), sy(d.y)]));
          ctx.globalAlpha = 0.05 * Math.min(...ns.map(alphaOf)); ctx.fillStyle = c.fg; ctx.strokeStyle = c.fg; ctx.lineWidth = 14 * Math.min(1.6, Math.max(0.6, k));
          ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); if (pts.length > 2) ctx.closePath(); else if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
          ctx.stroke(); if (pts.length > 2) ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      const lw = 0.8 * s.lineWidth;
      const seg = (a, b, x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); if (onScreen(x0, y0, 0) || onScreen(x1, y1, 0)) probe.segs.push([x0, y0, x1, y1, a, b]); };
      const trim = (x0, y0, x1, y1, r0, r1) => { const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy) || 1; return [x0 + (dx / d) * r0, y0 + (dy / d) * r0, x1 - (dx / d) * r1, y1 - (dy / d) * r1, dx / d, dy / d]; };
      // rings: tree lines course → topic → concept
      if (L.hubs) {
        ctx.strokeStyle = c.muted; ctx.lineWidth = lw;
        for (const n of vis) {
          if (n.kind !== 'c' || !n.hub) continue;
          const ctr = L.centres.find((q) => q.key === n.course);
          ctx.globalAlpha = 0.35 * alphaOf(n);
          seg('h:' + n.gk, n.id, ...trim(sx(n.hub.x), sy(n.hub.y), sx(n.x), sy(n.y), 0, dotR(n)).slice(0, 4));
          if (!n.hub.drawn) { n.hub.drawn = true; seg('c:' + n.course, 'h:' + n.gk, sx(ctr.x), sy(ctr.y), sx(n.hub.x), sy(n.hub.y)); }
        }
        for (const h of L.hubs) h.drawn = false;
        ctx.globalAlpha = 0.6; ctx.fillStyle = c.muted;
        for (const h of L.hubs) { ctx.beginPath(); ctx.arc(sx(h.x), sy(h.y), 2, 0, 2 * Math.PI); ctx.fill(); }
      }
      // prerequisites (Braucht). Rings: only for the tapped concept (would cut across the rings otherwise)
      const arrows = L.arrows && k * L.sp.concept > 40;
      ctx.strokeStyle = c.muted; ctx.fillStyle = c.muted; ctx.lineWidth = lw;
      for (const e of g.edges) {
        if (!visSet.has(e.a.id) || !visSet.has(e.b.id)) continue;
        if (L.hubs && !(sel && (e.a === sel || e.b === sel))) continue;
        const len = Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y) / L.sp.concept; // long cross-branch lines stay faint
        ctx.globalAlpha = (L.look === 'web' ? 0.34 : 0.45) * (len > 4 ? 0.45 : 1) * Math.min(alphaOf(e.a), alphaOf(e.b));
        const [x0, y0, x1, y1, ux, uy] = trim(sx(e.a.x), sy(e.a.y), sx(e.b.x), sy(e.b.y), dotR(e.a), dotR(e.b) + 1.5);
        seg(e.a.id, e.b.id, x0, y0, x1, y1);
        if (arrows) { const ah = 6; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - ux * ah - uy * ah * 0.45, y1 - uy * ah + ux * ah * 0.45); ctx.lineTo(x1 - ux * ah + uy * ah * 0.45, y1 - uy * ah - ux * ah * 0.45); ctx.closePath(); ctx.fill(); }
      }
      // statement twigs (statement → its concept)
      ctx.lineWidth = lw * 0.7;
      for (const st of vis) {
        if (st.kind !== 's') continue;
        ctx.globalAlpha = 0.3 * alphaOf(st); ctx.strokeStyle = colOf(st);
        seg(st.id, st.parent.id, ...trim(sx(st.parent.x), sy(st.parent.y), sx(st.x), sy(st.y), dotR(st.parent), dotR(st)).slice(0, 4));
      }
      // chains: premises meet in a junction dot, one line to the result
      ctx.strokeStyle = c.fg; ctx.fillStyle = c.fg; ctx.lineWidth = lw * 1.1; // light, not accent: teal already means "solid"
      for (const ch of g.chains) {
        const all = [...ch.from, ch.to]; if (all.some((d) => !visSet.has(d.id))) continue;
        ctx.globalAlpha = 0.55 * Math.min(...all.map(alphaOf));
        const P = ch.from.map((d) => [sx(d.x), sy(d.y), dotR(d), d.id]), C = [sx(ch.to.x), sy(ch.to.y), dotR(ch.to), ch.to.id];
        if (P.length === 1) { seg(P[0][3], C[3], ...trim(P[0][0], P[0][1], C[0], C[1], P[0][2], C[2] + 1).slice(0, 4)); continue; }
        const mx = P.reduce((a, p) => a + p[0], 0) / P.length, my = P.reduce((a, p) => a + p[1], 0) / P.length, jx = (mx + C[0]) / 2, jy = (my + C[1]) / 2;
        for (const p of P) seg(p[3], 'j:' + ch.raw, ...trim(p[0], p[1], jx, jy, p[2], 0).slice(0, 4));
        seg('j:' + ch.raw, C[3], ...trim(jx, jy, C[0], C[1], 0, C[2] + 1).slice(0, 4));
        ctx.beginPath(); ctx.arc(jx, jy, 1.5, 0, 2 * Math.PI); ctx.fill();
      }
      // dots
      for (const d of vis) {
        const x = sx(d.x), y = sy(d.y), r = dotR(d) * (V.hover === d.id || V.sel === d.id ? 1.25 : 1);
        if (!onScreen(x, y, 10)) continue;
        ctx.globalAlpha = alphaOf(d) * (d.kind === 's' ? 0.9 : 1); ctx.fillStyle = colOf(d);
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
        if (d.kind === 'c' && d.status === '⬜') { ctx.lineWidth = 1; ctx.strokeStyle = c.fg; ctx.globalAlpha *= 0.45; ctx.stroke(); }
        if (V.sel === d.id) { ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.strokeStyle = c.fg; ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 2 * Math.PI); ctx.stroke(); }
        if (onScreen(x, y, 0)) probe.dots.push([x, y, dotR(d)]);
      }
      ctx.globalAlpha = 1;

      // labels: exactly one level; fade out fully before the next level fades in
      const ks = levelKs(); let li = 0; for (let i = 1; i < ks.length; i++) if (k >= ks[i]) li = i;
      const f = 1.12, fadeIn = li ? clamp((k / ks[li] - 1) / (f - 1), 0, 1) : 1, fadeOut = li + 1 < ks.length ? clamp((ks[li + 1] - k) / (ks[li + 1] - ks[li + 1] / f), 0, 1) : 1;
      const level = L.levels[li], la = Math.min(fadeIn, fadeOut);
      probe.level = level; probe.ks = ks; probe.z = k / V.cam.kFit;
      root.querySelector('.g-level').textContent = { course: 'Courses', topic: 'Topics', concept: 'Concepts', stmt: 'Statements' }[level];
      const placed = [[0, V.h - 24, 230, V.h], [V.w - 90, 0, V.w, 26]]; // legend (bottom left) + level tag (top right)
      const dotsXY = probe.dots;
      const fs = Math.max(10, FONT[level] * s.labelSize);
      ctx.textBaseline = 'middle';
      const tryPlace = (text, x, y, opts, a) => {
        ctx.font = `${opts.weight || 500} ${opts.fs}px system-ui, sans-serif`;
        const w = ctx.measureText(text).width, h = opts.fs * 1.25;
        // pass 1: a spot that covers no other dot; pass 2: any free spot
        for (const strict of [true, false]) for (const [ox, oy, al] of opts.spots) {
          let bx = al === 'left' ? x + ox : al === 'right' ? x + ox - w : x + ox - w / 2; const by = y + oy - h / 2;
          if (opts.slide) bx = clamp(bx, Math.max(3, x - w + 8), Math.min(V.w - 3 - w, x - 8)); // course/topic names may slide sideways (but stay over their spot) to stay on screen
          if (bx < 3 || by < 3 || bx + w > V.w - 3 || by + h > V.h - 3) continue;
          if (placed.some((p) => bx < p[2] + 3 && bx + w + 3 > p[0] && by < p[3] + 1 && by + h + 1 > p[1])) continue;
          if (strict && dotsXY.some((d) => Math.hypot(d[0] - x, d[1] - y) > 1 && d[0] + d[2] > bx && d[0] - d[2] < bx + w && d[1] + d[2] > by && d[1] - d[2] < by + h)) continue;
          placed.push([bx, by, bx + w, by + h]);
          ctx.globalAlpha = a; ctx.fillStyle = opts.color; ctx.textAlign = 'left';
          ctx.shadowColor = c.bg; ctx.shadowBlur = 4 * dpr; ctx.fillText(text, bx, by + h / 2); ctx.shadowBlur = 0;
          if (a > 0.02) { probe.labels.push({ box: [bx, by, bx + w, by + h], fs: opts.fs, level: opts.level }); probe.levels.add(opts.level); }
          return true;
        }
        return false;
      };
      const forcedIds = new Set([V.hover, V.sel].filter(Boolean));
      // tapped / hovered dot: its own name always shows (a user action, not part of the zoom stages)
      for (const id of forcedIds) {
        const d = g.cById.get(id) || g.sById.get(id); if (!d || !visible(d)) continue;
        const txt = d.kind === 's' ? plain(d.text).slice(0, 70) : d.title, r = dotR(d) + 4;
        tryPlace(txt, sx(d.x), sy(d.y), { fs: 12.5, weight: 650, color: c.fg, level: 'forced', spots: [[0, r + 7], [0, -r - 7], [r, 0, 'left'], [-r, 0, 'right']] }, 1);
      }
      if (la > 0.02) {
        const ctrX = V.w / 2, ctrY = V.h / 2, dist = (x, y) => Math.hypot(x - ctrX, y - ctrY);
        if (level === 'course' || level === 'topic') {
          const items = L.anchors.filter((a) => a.level === level && onScreen(sx(a.x), sy(a.y), 0) && (level === 'course' || g.concepts.some((n) => n.gk === a.key && visible(n))));
          items.sort((a, b) => b.n - a.n);
          for (const a of items) for (const f2 of [fs, fs * 0.85, Math.max(10, fs * 0.72)]) if (tryPlace(a.text, sx(a.x), sy(a.y), { fs: f2, weight: level === 'course' ? 700 : 600, color: level === 'course' ? c.fg : c.muted, level, slide: true, spots: [[0, 0], [0, -f2 * 1.4], [0, f2 * 1.4], [0, -f2 * 2.8], [0, f2 * 2.8]] }, la * (V.dim.has(a.key.split('|')[0]) ? 0.25 : 1))) break;
        } else if (level === 'concept') {
          const items = vis.filter((d) => d.kind === 'c' && onScreen(sx(d.x), sy(d.y), 0)).sort((a, b) => dist(sx(a.x), sy(a.y)) - dist(sx(b.x), sy(b.y)));
          for (const n of items) { const r = dotR(n) + 2, x = sx(n.x), y = sy(n.y); tryPlace(n.title, x, y, { fs, color: c.fg, level, spots: [[0, r + fs * 0.75], [0, -r - fs * 0.75], [r + 2, 0, 'left'], [-r - 2, 0, 'right']] }, la * alphaOf(n)); }
        } else {
          const items = vis.filter((d) => d.kind === 's' && onScreen(sx(d.x), sy(d.y), 0)).sort((a, b) => dist(sx(a.x), sy(a.y)) - dist(sx(b.x), sy(b.y)));
          const max = clamp(Math.round((k * L.sp.stmt) / 4.5), 22, 64);
          for (const st of items) { const t = plain(st.text), txt = t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t, r = dotR(st) + 3, x = sx(st.x), y = sy(st.y);
            tryPlace(txt, x, y, { fs, color: c.fg, level, spots: [[r, 0, 'left'], [-r, 0, 'right'], [0, r + fs * 0.7], [0, -r - fs * 0.7]] }, la * alphaOf(st)); }
        }
      }
      ctx.globalAlpha = 1;
      V.last = probe;
    }
    V.draw = draw;
    V.focus = (id) => { const n = g.cById.get(id); if (!n || !V.cam) return; V.sel = id; const ks = levelKs(), ci = V.L.levels.indexOf('concept'), k = Math.max(V.cam.k, ks[ci] * 1.2); V.cam.k = k; V.cam.x = V.w / 2 - n.x * k; V.cam.y = V.h / 2 - n.y * k; mark(); };
    V.restyle = () => { css(); if (!V.L || !V.w) resize(); mark(); };
    V.relayout = relayout;
    // test hooks (tools/graph-check.mjs): show one look at one label level, centred on a busy spot
    V.test = {
      look(lk) { saveGs({ look: lk }); root.querySelectorAll('[data-look]').forEach((x) => x.classList.toggle('on', x.dataset.look === lk)); lookTxt(); relayout(); V.sel = V.hover = null; fit(); draw(); return V.L.levels; },
      stage(i) {
        fit(); const ks = levelKs(), lv = V.L.levels[i];
        if (i > 0) {
          const k = i + 1 < ks.length ? Math.sqrt(ks[i] * 1.15 * ks[i + 1] / 1.15) : ks[i] * 1.3;
          const big = [...g.concepts].sort((a, b) => b.stmts.length - a.stmts.length || b.deg - a.deg)[0];
          const course = g.courses.map((c) => g.concepts.filter((n) => n.course === c)).sort((a, b) => b.length - a.length)[0];
          const busiest = lv === 'topic' ? centroid(course) : lv === 'concept' ? centroid(g.concepts.filter((n) => n.gk === big.gk)) : centroid([big, ...big.stmts]);
          V.cam.k = k; V.cam.x = V.w / 2 - busiest.x * k; V.cam.y = V.h / 2 - busiest.y * k;
        }
        draw(); return lv;
      },
      probe: () => V.last,
    };
    return V;
  }

  // ---------- sheets ----------
  const pill = (n) => `<span class="chip ${STATUS[n.status] || ''}">${esc(n.status)} ${esc({ '🔴': 'gap', '🟡': 'learned', '🟢': 'solid', '⬜': 'open' }[n.status] || '')}</span>`;
  const mdx = (s) => esc(String(s)).replace(/\[\[([^\]|#]+)(?:#\^?([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_, p, c, l) => `<b>${l || p.split('/').pop()}</b>`).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\s*\^k\d+\s*$/, '');
  const goChips = (V, ids) => ids.map((id) => V.g.cById.get(id)).filter(Boolean).map((m) => `<button class="chip ${STATUS[m.status] || ''}" data-go="${esc(m.id)}">${esc(m.status)} ${esc(m.title)}</button>`).join('').replace(/^(.+)$/, '<div class="chips">$1</div>');
  const wireGo = (V) => (root) => root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.go; V.focus(id); nodeSheet(V, V.g.cById.get(id)); }));
  const chainText = (ch) => `${ch.premises.map((p) => esc(p.label || p.text || '')).join(' <span class="muted">+</span> ')} <span class="muted">→</span> <b>${esc(ch.conclusion.label || '')}</b>${/\(auto [^)]*\)\s*$/.test(ch.raw) ? ' <small class="muted">(auto)</small>' : ''}`;
  const chainsOf = (V, n, st) => V.g.chains.filter((ch) => [...ch.from, ch.to].some((d) => (st ? d === st : d === n || d.parent === n)));
  const stmtTag = (st) => (st.linked ? '<small class="good">linked</small>' : st.base ? '<small class="muted">plain fact</small>' : '<small class="warn">loose</small>');

  function nodeSheet(V, n) {
    const leads = V.g.leadsTo.get(n.id) || [], chs = chainsOf(V, n);
    const sec = (title, inner) => (inner ? `<h3>${title}</h3>${inner}` : '');
    const ul = (arr) => (arr.length ? `<ul class="g-list">${arr.map((t) => `<li>${mdx(t)}</li>`).join('')}</ul>` : '');
    openSheet(esc(n.title), `
      <div class="chips">${pill(n)}<span class="chip">${esc(n.course)}${n.station ? ' · ' + esc(n.station) : ''}</span><span class="chip">${esc(n.topic)}</span></div>
      ${n.last_reviewed ? `<p class="sub">Last reviewed ${esc(short(n.last_reviewed))}${n.last_score ? ' · ' + esc(n.last_score) : ''}</p>` : ''}
      ${sec('Aussagen', n.stmts.length ? `<ol class="g-list">${n.stmts.map((st) => `<li>${mdx(st.text)} ${stmtTag(st)}</li>`).join('')}</ol>` : '')}
      ${sec('Braucht', goChips(V, n.needs))}
      ${sec('Führt zu', goChips(V, leads))}
      ${sec('Ketten', chs.length ? `<ul class="g-list">${chs.map((ch) => `<li>${chainText(ch)}</li>`).join('')}</ul>` : '')}
      ${Object.entries(n.extra).map(([t, arr]) => sec(t, ul(arr))).join('')}
      <button class="primary" data-close-show>Show in graph</button>`, (root) => {
      wireGo(V)(root);
      root.querySelector('[data-close-show]').addEventListener('click', () => { closeSheet(); V.focus(n.id); });
    });
  }
  function claimSheet(V, n, st) {
    const chs = chainsOf(V, n, st);
    openSheet(esc(n.title) + ' · Aussage', `
      <div class="chips">${pill(n)}<span class="chip">${esc(n.topic)}</span></div>
      <p class="g-claim">${mdx(st.text)}</p>
      <p class="sub">${stmtTag(st)}</p>
      ${chs.length ? `<h3>Ketten</h3><ul class="g-list">${chs.map((ch) => `<li>${chainText(ch)}</li>`).join('')}</ul>` : `<p class="sub">${st.base ? 'Marked as a plain fact (no “why” needed).' : 'No chain uses this statement yet.'}</p>`}
      ${goChips(V, [n.id])}`, wireGo(V));
  }
  function settingsSheet(V) {
    const s = gs();
    const slider = (key, label, min, max, step, help) => `<label class="g-slider">${label} <output>${s[key]}</output><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}"></label><p class="sub g-help">${help}</p>`;
    openSheet('Graph settings', `
      ${slider('timing', 'Zoom timing', 0.5, 2, 0.05, 'When names switch to the next level while you zoom in. Lower = sooner, higher = you zoom in further first.')}
      ${slider('dotSize', 'Dot size', 0.6, 2, 0.1, 'Size of every dot (concepts and statements).')}
      ${slider('lineWidth', 'Line width', 0.5, 2.5, 0.1, 'Thickness of all lines.')}
      ${slider('labelSize', 'Text size', 0.9, 1.6, 0.05, 'Size of the names. Bigger text = fewer names fit at once.')}
      <label class="g-check"><input type="checkbox" data-k="glow" ${s.glow ? 'checked' : ''}> Glow</label>
      <p class="sub g-help">Soft light behind each concept in its status colour: grey = open, yellow = learned, green = solid, red = gap.</p>
      <button data-reset>Back to defaults</button>
      <button class="primary" data-close>Done</button>`, (root) => {
      root.querySelectorAll('input[type=range]').forEach((i) => i.addEventListener('input', () => { saveGs({ [i.dataset.k]: Number(i.value) }); i.previousElementSibling.textContent = i.value; V.mark(); }));
      root.querySelector('[data-k=glow]').addEventListener('change', (e) => { saveGs({ glow: e.target.checked }); V.mark(); });
      root.querySelector('[data-reset]').addEventListener('click', () => { LS.set('graphSettings2', { look: gs().look }); settingsSheet(V); V.mark(); });
      root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
    });
  }

  // ---------- entry (called from renderStudy() in v2.js) ----------
  window.renderGraph = async function () {
    const root = document.getElementById('graph');
    if (typeof d3 === 'undefined') { root.innerHTML = '<p class="status">Graph library missing (vendor/d3-force.min.js).</p>'; return; }
    if (view && view.g === G && loadedFor === DATA?.fetched) { view.restyle(); return; }
    if (!view) root.innerHTML = '<p class="status">Loading graph…</p>';
    try {
      const g = await getGraph();
      if (!g.concepts.length) { root.innerHTML = '<article class="card"><h2>Graph</h2><p class="sub">No concept nodes yet. They appear once drill writes <code>courses/&lt;Course&gt;/graph/</code> notes.</p></article>'; view = null; return; }
      if (view && view.g === g) { view.restyle(); return; }
      view = makeView(root, g); window.graphView = view;
    } catch (e) { root.innerHTML = `<p class="status">Couldn’t load the graph: ${esc(e.message)}</p>`; }
  };
  window.graphThemeChanged = () => view?.restyle();
})();
