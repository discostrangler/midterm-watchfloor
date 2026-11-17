// Polls vs Kalshi, whole cycle, on one daily timeline for the selected race (or nationally for control / other markets).
// Data: data/polls_kalshi/<ST>.json, US.json (tools/build_polls_kalshi.py). Polls: nominee head-to-heads from Wikipedia and
// VoteHub (Subhrajit's collect/polls_full.py); placed at field END date or at the date VoteHub ADDED them (toggle).
// Kalshi: trades and dollars per day over all the race's events; quoted mid of the D contract at the end of each ET day.
// Readouts at the cursor only use whole days before the cursor's day (no look-ahead).
(() => {
  'use strict';
  const ET = 'America/New_York';
  const fMD = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'});
  const fYMD = new Intl.DateTimeFormat('en-CA', {timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit'});
  const css = (v) => getComputedStyle(document.getElementById('watchfloor')).getPropertyValue(v).trim() || '#888';
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const usd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`);
  const mg = (v) => (v == null ? '—' : Math.abs(v) < 0.05 ? 'tied' : `${v > 0 ? 'D' : 'R'} +${Math.abs(v).toFixed(1)}`);
  const CTRL = ['CONTROLS-2026', 'CONTROLH-2026'];
  const SRC = ['Wikipedia', 'VoteHub', 'Wikipedia + VoteHub'];
  dash.load('pk:US', 'data/polls_kalshi/US.json');

  let day0 = Date.UTC(2024, 10, 5);                                   // replaced by meta.day0
  const dayUTC = (i) => day0 + i * 86400000;                          // day i as a UTC date (labels only)
  const dayOf = (t) => { const [y, m, d] = fYMD.format(new Date(t * 1000)).split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - day0) / 86400000); };
  const tOfDay = (i) => (dayUTC(i) + 17 * 3600000) / 1000;            // noon ET (approx.) of day i, for moving the cursor
  const lbl = (i) => fMD.format(new Date(dayUTC(i)));

  function source() {                                                 // {kind, rec, label, note} for the selected market
    const id = WF.race, I = dash.data('night_races');
    const national = () => { const d = dash.data('pk:US'); return d.status === 'ok' ? {kind: 'us', rec: d.raw.us, meta: d.raw.meta, label: 'National: generic ballot polls · Senate + House control markets'}
      : {status: d.status, retry: d.status === 'error' ? () => dash.load('pk:US', 'data/polls_kalshi/US.json') : null, label: 'National view'}; };
    if (!id || CTRL.includes(id)) return national();
    if (I.status !== 'ok') return {status: I.status};
    const r = I.raw.races[id];
    if (!r) return {...national(), note: 'This market is not one of the midterm races, so the national view is shown.'};
    const k = `pk:${r.state}`;
    if (dash.data(k).status === 'idle') dash.load(k, `data/polls_kalshi/${r.state}.json`);
    const d = dash.data(k);
    if (d.status !== 'ok') return {status: d.status, retry: d.status === 'error' ? () => dash.load(k, `data/polls_kalshi/${r.state}.json`) : null, label: r.label};
    const rec = d.raw.races[id];
    return rec ? {kind: 'race', rec, meta: d.raw.meta, label: r.label} : {status: 'error'};
  }

  function series(S, mode) {
    const pollDay = (p) => (mode === 'added' ? p[1] : p[0]);
    const all = S.rec.polls, polls = all.filter((p) => pollDay(p) != null).map((p) => ({p, d: pollDay(p), m: p[2] - p[3]})).sort((a, b) => a.d - b.d);
    const k = S.kind === 'us' ? merge(Object.values(S.rec.markets).map((x) => x.k)) : S.rec.k;
    const mids = S.kind === 'us' ? CTRL.map((id) => ({id, mid: S.rec.markets[id].mid})) : [{id: 'D', mid: S.rec.mid}];
    return {polls, hidden: all.length - polls.length, k, mids};
  }
  function merge(lists) { const m = new Map(); for (const l of lists) for (const [d, n, u] of l) { const x = m.get(d) || [d, 0, 0]; x[1] += n; x[2] += u; m.set(d, x); } return [...m.values()].sort((a, b) => a[0] - b[0]); }
  const midAt = (mid, d) => { let v; for (const [i, x] of mid) { if (i > d) break; v = x; } return v; };   // value in effect at the end of day d

  function draw(box, S, X, m) {
    const W = Math.max(320, box.clientWidth || 900), ml = 64, mr = 16, rows = [['margin', 110], ['polls', 46], ['trades', 46], ['usd', 46], ['mid', 70]];
    const ROWLAB = {margin: S.kind === 'us' ? 'Generic ballot D − R' : 'Poll margin D − R', polls: 'Polls', trades: 'Kalshi trades', usd: 'Kalshi $', mid: S.kind === 'us' ? 'Control P(D)' : 'Quoted mid P(D)'};
    let y0 = 34; const Y = {};   // the strip above the rows holds the poll-size key
    for (const [k, h] of rows) { Y[k] = {top: y0, h}; y0 += h + 8; }
    const H = y0 + 18, [a, b] = X.dom, x = d3.scaleLinear([a, b + 1], [ml, W - mr]);
    const svg = d3.select(box).html('').append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').style('display', 'block').attr('role', 'img')
      .attr('aria-label', `${S.label}: ${X.polls.length} polls and Kalshi trades, dollars and quoted midpoint from ${lbl(a)} to ${lbl(b)}, ${X.bin === 1 ? 'per day' : 'per week'}. The text below the chart gives the values up to the cursor.`);
    const g = svg.append('g');
    for (const [k] of rows) {
      g.append('text').attr('x', ml + 4).attr('y', Y[k].top + 10).attr('class', 'wf-nt-lab').text(ROWLAB[k]);   // inside the row: the margin holds the axis numbers
      g.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', Y[k].top + Y[k].h + 0.5).attr('y2', Y[k].top + Y[k].h + 0.5).attr('stroke', css('--wf-grid'));
    }
    // 1. each poll's margin; the line = average of the latest five polls up to that day
    const mmax = Math.max(5, d3.max(X.polls, (p) => Math.abs(p.m)) || 5), ym = d3.scaleLinear([-mmax, mmax], [Y.margin.top + Y.margin.h - 8, Y.margin.top + 8]);   // room for the largest circles
    g.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', ym(0)).attr('y2', ym(0)).attr('stroke', css('--wf-line2')).attr('stroke-dasharray', '3 3');
    [mmax, -mmax].forEach((v) => g.append('text').attr('x', ml - 6).attr('y', ym(v) + (v > 0 ? 9 : -2)).attr('text-anchor', 'end').attr('class', 'wf-nt-ax').text(mg(v)));
    const avg = X.polls.map((p, i) => ({d: p.d, v: d3.mean(X.polls.slice(Math.max(0, i - 4), i + 1), (q) => q.m)}));
    g.append('path').datum(avg).attr('d', d3.line().x((p) => x(p.d + 0.5)).y((p) => ym(p.v)).curve(d3.curveStepAfter)).attr('fill', 'none').attr('stroke', css('--wf-fg')).attr('stroke-width', 1.3).attr('opacity', 0.8);
    // circle AREA proportional to the number of people polled (p[7]); the largest 5% are capped so one huge online
    // panel doesn't shrink every other dot; no published sample size -> a small square
    const ns = X.polls.map((p) => p.p[7]).filter(Boolean).sort(d3.ascending), cap = Math.max(1000, d3.quantile(ns, 0.95) || 1000);
    const rs = d3.scaleSqrt([0, cap], [0, 8]).clamp(true), col = (p) => (p.m >= 0 ? css('--wf-dem') : css('--wf-rep'));
    const sized = X.polls.filter((p) => p.p[7]).sort((p, q) => q.p[7] - p.p[7]);   // big first, so small dots stay on top
    const tt = (p) => `${p.p[4]} · ${lbl(p.d)} · ${mg(p.m)} · ${p.p[7] ? `${d3.format(',')(p.p[7])} people` : 'sample size not published'}${p.p[6] ? ` · sponsored by the ${p.p[6] === 'D' ? 'Democratic' : 'Republican'} side` : ''}`;
    g.append('g').selectAll('circle').data(sized).join('circle').attr('cx', (p) => x(p.d + 0.5)).attr('cy', (p) => ym(p.m)).attr('r', (p) => Math.max(1.2, rs(p.p[7])))
      .attr('fill', (p) => (p.p[6] ? 'none' : col(p))).attr('fill-opacity', 0.45).attr('stroke', col).attr('stroke-width', 1)
      .append('title').text(tt);
    g.append('g').selectAll('rect').data(X.polls.filter((p) => !p.p[7])).join('rect').attr('x', (p) => x(p.d + 0.5) - 2).attr('y', (p) => ym(p.m) - 2).attr('width', 4).attr('height', 4)
      .attr('fill', 'none').attr('stroke', col).attr('stroke-width', 1).append('title').text(tt);
    // size key, top right of the row
    const keyN = [500, 1000, cap].filter((v, i, arr) => arr.indexOf(v) === i && v <= cap);
    let kx = W - mr - 8;
    for (const v of keyN.slice().reverse()) {
      const r = rs(v); g.append('circle').attr('cx', kx - r).attr('cy', 13).attr('r', r).attr('fill', 'none').attr('stroke', css('--wf-muted'));
      g.append('text').attr('x', kx - r).attr('y', 31).attr('text-anchor', 'middle').attr('class', 'wf-nt-ax').text(v >= 1000 ? `${+(v / 1000).toFixed(1)}k${v === cap && ns.length && ns[ns.length - 1] > cap ? '+' : ''}` : v);
      kx -= 2 * r + 14;
    }
    g.append('text').attr('x', kx).attr('y', 17).attr('text-anchor', 'end').attr('class', 'wf-nt-ax').text(`people polled${X.polls.some((p) => !p.p[7]) ? ' · □ = not published' : ''}`);
    // 2-4. counts per bin (same bins for polls and Kalshi)
    const nb = Math.ceil((b - a + 1) / X.bin), bins = Array.from({length: nb}, () => ({p: 0, n: 0, u: 0}));
    const bi = (d) => Math.floor((d - a) / X.bin);
    for (const p of X.polls) if (p.d >= a && p.d <= b) bins[bi(p.d)].p++;
    for (const [d, n, u] of X.k) if (d >= a && d <= b) { bins[bi(d)].n += n; bins[bi(d)].u += u; }
    const bar = (key, f, col, fmt) => {
      const real = d3.max(bins, f) || 0, yb = d3.scaleSqrt([0, real || 1], [0, Y[key].h - 12]);   // square root: the last week is ~100x the first months
      bins.forEach((q, i) => { const v = f(q); if (v) g.append('rect').attr('x', x(a + i * X.bin)).attr('width', Math.max(1, x(a + X.bin) - x(a) - 1)).attr('y', Y[key].top + Y[key].h - yb(v)).attr('height', yb(v)).attr('fill', col).attr('opacity', 0.8); });
      g.append('text').attr('x', W - mr).attr('y', Y[key].top + 9).attr('text-anchor', 'end').attr('class', 'wf-nt-ax')
        .text(!real ? 'none' : W < 640 ? `max ${fmt(real)}/${X.bin === 1 ? 'day' : 'wk'}` : `max ${fmt(real)} per ${X.bin === 1 ? 'day' : 'week'} · square-root scale`);
    };
    bar('polls', (q) => q.p, css('--wf-ind'), (v) => v);
    bar('trades', (q) => q.n, css('--wf-muted'), (v) => d3.format(',')(v));
    bar('usd', (q) => q.u, css('--wf-amber'), usd);
    // 5. quoted mid of the D contract at each day's end (control: Senate and House)
    const yq = d3.scaleLinear([0, 1], [Y.mid.top + Y.mid.h, Y.mid.top]);
    g.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', yq(0.5)).attr('y2', yq(0.5)).attr('stroke', css('--wf-line2')).attr('stroke-dasharray', '3 3');
    ['100%', '0%'].forEach((t, j) => g.append('text').attr('x', ml - 6).attr('y', yq(1 - j) + (j ? -2 : 9)).attr('text-anchor', 'end').attr('class', 'wf-nt-ax').text(t));
    X.mids.forEach(({id, mid}, j) => {
      const pts = []; for (let i = 0; i < mid.length; i++) { const [d, v] = mid[i], e = i + 1 < mid.length ? mid[i + 1][0] : b + 1;
        if (e < a || d > b) continue; pts.push({d: Math.max(a, d), v: typeof v === 'number' ? v : null}, {d: Math.min(b + 1, e), v: typeof v === 'number' ? v : null}, {d: Math.min(b + 1, e), v: null}); }
      g.append('path').datum(pts).attr('d', d3.line().defined((p) => p.v != null).x((p) => x(p.d)).y((p) => yq(p.v)))
        .attr('fill', 'none').attr('stroke', j ? css('--wf-dem-t') : css('--wf-dem')).attr('stroke-width', 1.4).attr('stroke-dasharray', j ? '4 2' : null);
      if (S.kind === 'us') g.append('text').attr('x', W - mr).attr('y', Y.mid.top + 9 + j * 11).attr('text-anchor', 'end').attr('class', 'wf-nt-ax').text(`${id === 'CONTROLS-2026' ? 'Senate' : 'House'} ${j ? 'dashed' : 'solid'}`);
    });
    // time axis: months
    for (let i = a; i <= b; i++) { const dt = new Date(dayUTC(i)); if (dt.getUTCDate() !== 1) continue;
      const pxMonth = (W - ml - mr) / ((b - a + 1) / 30.44), every = [1, 2, 3, 4, 6, 12].find((k) => pxMonth * k >= 58) || 12, mo = dt.getUTCMonth();
      if (mo % every) continue;
      g.append('line').attr('x1', x(i)).attr('x2', x(i)).attr('y1', 34).attr('y2', H - 16).attr('stroke', css('--wf-grid'));
      g.append('text').attr('x', x(i)).attr('y', H - 4).attr('text-anchor', x(i) > W - mr - 30 ? 'end' : 'middle').attr('class', 'wf-nt-ax').text(dt.toLocaleString('en-US', {timeZone: 'UTC', month: 'short', ...(mo === 0 ? {year: 'numeric'} : {})})); }
    // election day, cursor, hover
    const eday = Math.round((Date.UTC(2026, 10, 3) - day0) / 86400000);
    if (eday >= a && eday <= b) g.append('line').attr('x1', x(eday)).attr('x2', x(eday)).attr('y1', 34).attr('y2', H - 16).attr('stroke', css('--wf-faint')).attr('stroke-dasharray', '2 3');
    const cur = svg.append('line').attr('y1', 34).attr('y2', H - 16).attr('stroke', css('--wf-amber')).attr('stroke-width', 1.5).style('pointer-events', 'none');
    const hov = svg.append('line').attr('y1', 34).attr('y2', H - 16).attr('stroke', css('--wf-fg')).attr('stroke-opacity', 0.35).attr('stroke-dasharray', '2 3').style('display', 'none').style('pointer-events', 'none');
    const dayAt = (ev) => Math.max(a, Math.min(b, Math.floor(x.invert(d3.pointer(ev, svg.node())[0]))));
    const show = (d, poll, px, py) => {                                  // the values for day d's bin (and one poll), as a visible tip + live text
      const i = bi(d), q = bins[i], s = a + i * X.bin, e = Math.min(b, s + X.bin - 1);
      const inBin = X.polls.filter((p) => p.d >= s && p.d <= e);
      hov.style('display', null).attr('x1', x(d + 0.5)).attr('x2', x(d + 0.5));
      m.tipB.textContent = `${S.label} · ${X.bin === 1 ? lbl(s) : `${lbl(s)} – ${lbl(e)}`}`;
      m.tipS.textContent = (poll ? `${tt(poll)} — ` : '') + `${q.p} poll${q.p === 1 ? '' : 's'}${inBin.length ? ` (average ${mg(d3.mean(inBin, (p) => p.m))})` : ''} · ${d3.format(',')(q.n)} trades · ${usd(q.u)}`
        + X.mids.map(({id, mid}) => { const v = midAt(mid, e); return ` · ${S.kind === 'us' ? (id === 'CONTROLS-2026' ? 'Senate' : 'House') : 'quoted mid'} ${typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : v === 'closed' ? 'closed' : '—'}`; }).join('');
      m.tip.hidden = false; m.tip.style.left = `${Math.max(0, Math.min(px + 12, box.clientWidth - 280))}px`; m.tip.style.top = `${Math.max(0, py - 54)}px`;
      m.live.textContent = `${m.tipB.textContent}: ${m.tipS.textContent}`;
    };
    const moveCursor = (d) => {                                          // the page cursor, when the dashboard's campaign window covers day d
      const t = tOfDay(d), [c0, c1] = [Date.UTC(2026, 9, 4, 4) / 1000, Date.UTC(2026, 10, 12, 5) / 1000];
      if (t < c0 || t > c1) { m.note.textContent = 'The page cursor only covers Oct 4 – Nov 12, 2026; hover or use the arrow keys for values elsewhere.'; return; }
      if (t < WF.range[0] || t > WF.range[1]) document.querySelector('.wf [data-range=campaign]').click();
      const sc = document.getElementById('wf-scrub'); sc.value = t; sc.dispatchEvent(new Event('input'));
    };
    const hide = () => { hov.style('display', 'none'); m.tip.hidden = true; };
    let kd = null, kp = -1;                                                  // keyboard position: day and poll index
    svg.attr('tabindex', 0).attr('aria-label', `${svg.attr('aria-label')} Keyboard: Left and Right step one ${X.bin === 1 ? 'day' : 'week'}, Shift with Left or Right jumps to the previous or next poll, Home and End go to the ends, Enter moves the page cursor there.`)
      .on('pointermove', (ev) => { const [px, py] = d3.pointer(ev, box); show(dayAt(ev), null, px, py); })
      .on('pointerleave blur', hide)
      .on('click', (ev) => moveCursor(dayAt(ev)))
      .on('keydown', (ev) => {
        if (kd == null) { kd = Math.max(a, Math.min(b, dayOf(WF.t))); kp = X.polls.findLastIndex((p) => p.d <= kd); }
        if (ev.key === 'Enter') { ev.preventDefault(); moveCursor(kd); return; }
        if (ev.shiftKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
          kp = ev.key === 'ArrowLeft' ? (X.polls.findLastIndex((p) => p.d < kd) ?? -1) : X.polls.findIndex((p) => p.d > kd);
          if (kp < 0) { m.live.textContent = 'No more polls in that direction.'; ev.preventDefault(); return; }
          kd = X.polls[kp].d;
        } else if (ev.key === 'ArrowLeft') kd -= X.bin; else if (ev.key === 'ArrowRight') kd += X.bin;
        else if (ev.key === 'Home') kd = a; else if (ev.key === 'End') kd = b;
        else return;
        ev.preventDefault(); kd = Math.max(a, Math.min(b, kd));
        const poll = ev.shiftKey && kp >= 0 ? X.polls[kp] : null;
        show(kd, poll, x(kd + 0.5), poll ? ym(poll.m) : Y.margin.top + 20);
      });
    return {cur, x, a, b};
  }

  function readout(p, S, X) {                                          // up to the cursor: whole days before the cursor's day only
    const cd = dayOf(WF.t), before = X.polls.filter((q) => q.d < cd), last5 = before.slice(-5), wk = (d) => d >= cd - 7 && d < cd;
    const k7 = X.k.filter(([d]) => wk(d)), mids = X.mids.map(({id, mid}) => [id, midAt(mid, cd - 1)]);
    p.textContent = `${S.label}, up to ${lbl(cd - 1)} (the day before the cursor): ${before.length} poll${before.length === 1 ? '' : 's'}`
      + (last5.length ? `, latest ${last5.length} average ${mg(d3.mean(last5, (q) => q.m))} (latest: ${before[before.length - 1].p[4]}, ${mg(before[before.length - 1].m)}, ${X.mode === 'added' ? 'added' : 'field ended'} ${lbl(before[before.length - 1].d)})` : '')
      + `. Last 7 days: ${before.filter((q) => wk(q.d)).length} polls, ${d3.format(',')(d3.sum(k7, (r) => r[1]))} Kalshi trades, ${usd(d3.sum(k7, (r) => r[2]))}. `
      + mids.map(([id, v]) => `${S.kind === 'us' ? (id === 'CONTROLS-2026' ? 'Senate control' : 'House control') : 'Quoted mid'} at the end of that day: ${typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : v === 'closed' ? 'trading closed' : 'no quote'}`).join(' · ') + '.';
  }

  dash.draw('pk', {
    mount(root) {
      const m = {mode: 'end', key: '', chart: root.querySelector('[data-pk=chart]'), note: root.querySelector('[data-pk=note]'), tip: root.querySelector('.wf-tip'), live: root.querySelector('[data-pk=live]')};
      m.tipB = m.tip.querySelector('b'); m.tipS = m.tip.querySelector('span');
      root.querySelectorAll('[data-pkmode]').forEach((bt) => bt.addEventListener('click', () => {
        m.mode = bt.dataset.pkmode; root.querySelectorAll('[data-pkmode]').forEach((z) => z.setAttribute('aria-pressed', String(z === bt))); m.key = ''; dash.draw('pk');
      }));
      return m;
    },
    update(root, m) {
      const S = source(), q = (s) => root.querySelector(s);
      if (!S.rec) {
        const sub = q('[data-pk=sub]');
        sub.textContent = S.status === 'error' ? `${S.label ? `${S.label}: ` : ''}the poll / Kalshi timeline file did not load. ` : `Loading${S.label ? ` ${S.label}` : ''}…`;
        if (S.retry) { const bt = el('button', 'wf-btn', 'Retry'); bt.type = 'button'; bt.addEventListener('click', () => { S.retry(); dash.draw('pk'); }); sub.append(bt); }
        m.chart.replaceChildren(); m.key = ''; m.ov = null; m.tip.hidden = true;
        q('[data-pk=read]').textContent = ''; m.note.textContent = ''; m.live.textContent = '';
        return;
      }
      day0 = Date.parse(`${S.meta.day0}T00:00:00Z`);
      const X = series(S, m.mode); X.mode = m.mode;
      const firsts = [X.polls[0]?.d, X.k[0]?.[0], ...X.mids.map(({mid}) => mid[0]?.[0])].filter((v) => v != null);
      const b = S.meta.days - 1, a = Math.max(0, Math.min(b - 60, (firsts.length ? Math.min(...firsts) : 0) - 7));
      X.dom = [a, b]; X.bin = b - a + 1 <= 150 ? 1 : 7;
      q('[data-pk=sub]').textContent = `${S.label} · ${X.polls.length} ${S.kind === 'us' ? 'generic-ballot' : 'head-to-head'} poll${X.polls.length === 1 ? '' : 's'}${X.hidden ? ` (${X.hidden} without a usable VoteHub added date are hidden)` : ''} · ${X.bin === 1 ? 'per day' : 'per week'}`;
      const key = `${WF.race}|${m.mode}|${m.chart.clientWidth}`;
      if (key !== m.key || !m.chart.isConnected || !m.chart.firstChild) { m.key = key; m.tip.hidden = true; m.ov = draw(m.chart, S, X, m); m.note.textContent = S.note || ''; }
      const cd = dayOf(WF.t);
      m.ov.cur.attr('x1', m.ov.x(cd)).attr('x2', m.ov.x(cd)).style('display', cd >= m.ov.a && cd <= m.ov.b ? null : 'none');
      readout(q('[data-pk=read]'), S, X);
    },
  });
})();
