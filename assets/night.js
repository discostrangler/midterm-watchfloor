// Election-night control view: Kalshi quotes + exact trades (our API pull) and what was on air (stream transcripts, private).
// Data: data/night_control.json, data/night_trades/<event>.json, private/night_private.json (built by tools/build_night.py).
// Follows the page cursor (WF.t). Each source keeps its own clock: quotes at candle end, trades at execution,
// transcript = stream start + video offset, chat = YouTube send time.
(() => {
  'use strict';
  const ZOOM = 600, NEAR = 60, CTRL_IDS = ['CONTROLS-2026', 'CONTROLH-2026'];
  dash.load('night_control', 'data/night_control.json');
  dash.load('night_private', 'private/night_private.json');   // absent on the public site: the on-air block says so

  const ET = 'America/New_York';
  const fT = new Intl.DateTimeFormat('en-US', {timeZone: ET, hour: 'numeric', minute: '2-digit'});
  const fS = new Intl.DateTimeFormat('en-US', {timeZone: ET, hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3});
  const fY = new Intl.DateTimeFormat('en-US', {timeZone: ET, year: 'numeric'});
  const fMD = new Intl.DateTimeFormat('en-US', {timeZone: ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  const D = (t) => new Date(t * 1000);
  const cents = (p) => (p == null ? '—' : `${(p * 100).toFixed(1)}¢`);
  const age = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
  const css = (v) => getComputedStyle(document.getElementById('watchfloor')).getPropertyValue(v).trim() || '#888';
  const setT = (t) => { const s = document.getElementById('wf-scrub'); s.value = t; s.dispatchEvent(new Event('input')); };
  const nc = () => { const d = dash.data('night_control'); return d.status === 'ok' ? d.raw : null; };
  const trades = (e) => { const k = `nt:${e}`; if (dash.data(k).status === 'idle') dash.load(k, `data/night_trades/${e}.json`); const d = dash.data(k); return d.status === 'ok' ? d.data : null; };
  // the two control markets, plus the race picked on the map / dropdown when it has a minute-quote export
  // every Watchfloor race: index -> one file per state (tools/build_races_night.py)
  dash.load('night_races', 'data/night_races.json');
  const STATUS_NOTE = {
    'settled before window': 'Kalshi settled this race before election night, so it has no quotes or trades in this window. Its settlement is shown below.',
    'closed before window': 'Trading in this race closed before election night, so it has no quotes in this window.',
    'no D/R contracts': 'No Democratic / Republican contract pair was found for this race.',
  };
  function shown(N) {
    const id = WF.race, evs = N.events.slice();
    if (!id || CTRL_IDS.includes(id)) return {evs, note: ''};
    const I = dash.data('night_races');
    if (I.status !== 'ok') return {evs, note: I.status === 'error' ? 'The race index (data/night_races.json) is missing.' : 'Loading the race index…'};
    const r = I.raw.races[id];
    if (!r) return {evs, note: 'This market is not one of the 504 midterm races, so it has no election-night export here.'};
    const k = `ns:${r.state}`; if (dash.data(k).status === 'idle') dash.load(k, `data/night_state/${r.state}.json`);
    const d = dash.data(k);
    if (d.status === 'ok' && d.raw.races[id]) evs.push(d.raw.races[id]);
    const sparse = r.open_minutes && r.quote_minutes < 0.25 * r.open_minutes ? `${r.label} had a two-sided quote (carried forward from its last observed candle) for only ${r.quote_minutes} of its ${r.open_minutes} open minutes tonight, with ${r.trades} trades; check the quote age and spread.` : '';
    return {evs, note: d.status === 'error' ? `Could not load ${r.state}'s races.` : d.status !== 'ok' ? `Loading ${r.label}…` : STATUS_NOTE[r.status] || sparse};
  }
  // the latest quote observed at or before the cursor: never one from a candle that had not ended yet
  function quoteAt(N, q, t) {
    for (let i = Math.min(qi(N, t), q.bid.length - 1); i >= 0; i--) if (q.bid[i] != null && q.ask[i] != null) return {bid: q.bid[i], ask: q.ask[i], t: N.window[0] + (i + 1) * 60, two: q.bid[i] > 0 && q.ask[i] < 1};
    return null;
  }
  const tradesOf = (e) => e.trades || trades(e.event);
  const lowerBound = (rows, t) => { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m + 1; else hi = m; } return lo; };
  const pD = (r) => (r[1] === 0 ? r[3] : 1 - r[3]);                 // a trade's price as P(Democrats)
  const backsD = (r) => (r[1] === 0) === (r[2] === 1);              // bought YES on D or NO on R
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  // quote at the cursor = the last minute candle that ENDED at or before it
  const qi = (N, t) => Math.floor((t - N.window[0]) / 60) - 1;

  // ---------------------------------------------------------------- whole-night chart (built once per width)
  function overview(box, N, evs) {
    const W = box.clientWidth || 900, RH = 118, ml = 64, mr = 12, [A, B] = N.window;
    const svg = d3.select(box).html('').append('svg').attr('viewBox', `0 0 ${W} ${RH * evs.length + 22}`).attr('width', '100%').style('display', 'block');
    const x = d3.scaleLinear([A, B], [ml, W - mr]);
    evs.forEach((e, k) => {
      const q = e.quotes.D, n = q.bid.length, T = (i) => A + (i + 1) * 60, top = k * RH + 8, bot = top + RH - 18;
      const two = (i) => q.bid[i] != null && q.ask[i] != null && q.bid[i] > 0 && q.ask[i] < 1, ii = d3.range(n).filter(two);
      const lo = d3.min(ii, (i) => q.bid[i]) ?? 0, hi = d3.max(ii, (i) => q.ask[i]) ?? 1;
      const y = d3.scaleLinear([Math.max(0, lo - 0.03), Math.min(1, hi + 0.03)], [bot, top]);
      const g = svg.append('g'), idx = d3.range(n), has = two;
      y.ticks(4).forEach((v) => { g.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', css('--wf-grid'));
        g.append('text').attr('x', ml - 6).attr('y', y(v) + 3).attr('text-anchor', 'end').attr('class', 'wf-nt-ax').text(`${Math.round(v * 100)}¢`); });
      g.append('text').attr('x', 4).attr('y', top + 10).attr('class', 'wf-nt-lab').text(e.label);
      g.append('path').attr('d', d3.area().defined(has).x((i) => x(T(i))).y0((i) => y(q.bid[i])).y1((i) => y(q.ask[i]))(idx)).attr('fill', css('--wf-dem')).attr('opacity', 0.28);
      g.append('path').attr('d', d3.line().defined(has).x((i) => x(T(i))).y((i) => y((q.bid[i] + q.ask[i]) / 2))(idx)).attr('fill', 'none').attr('stroke', css('--wf-dem-t')).attr('stroke-width', 1.2);
      g.append('g').selectAll('circle').data(idx.filter((i) => q.last[i] != null)).join('circle').attr('cx', (i) => x(T(i))).attr('cy', (i) => y(q.last[i])).attr('r', 1.1).attr('fill', css('--wf-fg')).attr('opacity', 0.7);
      [['close_ts', '4 3', 'trading stops'], ['settle_ts', '1 3', 'settles']].forEach(([f, dash_, lab]) => {
        if (!e[f] || e[f] > B || e[f] < A) return;
        g.append('line').attr('x1', x(e[f])).attr('x2', x(e[f])).attr('y1', top).attr('y2', bot).attr('stroke', css('--wf-amber')).attr('stroke-dasharray', dash_);
        g.append('text').attr('x', x(e[f]) + 3).attr('y', f === 'close_ts' ? top + 9 : top + 20).attr('class', 'wf-nt-ax').style('fill', css('--wf-amber')).text(`${lab} ${fT.format(D(e[f]))}`); });
    });
    const ax = svg.append('g');
    for (let t = A; t <= B; t += 7200) ax.append('text').attr('x', x(t)).attr('y', RH * evs.length + 16).attr('text-anchor', 'middle').attr('class', 'wf-nt-ax').text(fT.format(D(t)));
    const cur = svg.append('line').attr('y1', 4).attr('y2', RH * evs.length).attr('stroke', css('--wf-amber')).attr('stroke-width', 1.5).style('pointer-events', 'none');
    svg.style('cursor', 'crosshair').on('click', (ev) => setT(x.invert(d3.pointer(ev, svg.node())[0])));
    return {W, x, cur, key: evs.map((e) => e.event).join()};
  }

  // ---------------------------------------------------------------- ±10 min around the cursor: every trade against the quote
  function zoom(cv, N, e, t) {
    const dpr = devicePixelRatio || 1, W = cv.clientWidth || 440, H = 170, ml = 44, mr = 8, mt = 8, mb = 18;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = `${H}px`;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const a = t - ZOOM, b = t + ZOOM, X = (v) => ml + ((v - a) / (b - a)) * (W - ml - mr), rows = tradesOf(e) || [], q = e.quotes.D, A = N.window[0];
    const i0 = lowerBound(rows, a), i1 = lowerBound(rows, b), pts = [];
    for (let i = Math.max(0, qi(N, a)); i <= qi(N, b) && i < q.bid.length; i++) if (q.bid[i] != null && q.ask[i] != null && q.bid[i] > 0 && q.ask[i] < 1) pts.push([A + (i + 1) * 60, q.bid[i], q.ask[i]]);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[2]); }
    for (let i = i0; i < i1; i++) { const v = pD(rows[i]); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    g.font = `500 10.5px ${css('--wf-mono')}`; g.fillStyle = css('--wf-faint');
    if (!isFinite(lo)) { g.fillText('no quotes or trades within 10 min of the cursor', ml, H / 2); return 0; }
    const pad = Math.max(0.004, (hi - lo) * 0.12); lo -= pad; hi += pad;
    const Y = (v) => mt + ((hi - v) / (hi - lo)) * (H - mt - mb);
    g.strokeStyle = css('--wf-grid'); g.lineWidth = 1;
    for (let k = 0; k <= 3; k++) { const v = lo + ((hi - lo) * k) / 3; g.beginPath(); g.moveTo(ml, Y(v)); g.lineTo(W - mr, Y(v)); g.stroke(); g.fillText(`${(v * 100).toFixed(1)}¢`, 2, Y(v) + 3); }
    for (let m = Math.ceil(a / 300) * 300; m <= b; m += 300) g.fillText(fT.format(D(m)), X(m) - 16, H - 4);
    for (let i = i0; i < i1; i++) {                                   // trades: one dot each, area ~ contracts
      const r = rows[i]; g.fillStyle = backsD(r) ? css('--wf-dem') : css('--wf-rep'); g.globalAlpha = 0.55;
      g.beginPath(); g.arc(X(r[0]), Y(pD(r)), Math.max(1, Math.min(7, Math.sqrt(r[4]) / 12)), 0, 6.3); g.fill();
    }
    g.globalAlpha = 1;
    [[1, css('--wf-ok')], [2, css('--wf-amber')]].forEach(([j, col]) => {   // bid and ask at each candle end
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.3; g.beginPath();
      pts.forEach((p, n) => (n ? g.lineTo(X(p[0]), Y(p[j])) : g.moveTo(X(p[0]), Y(p[j])))); g.stroke();
      pts.forEach((p) => g.fillRect(X(p[0]) - 1.5, Y(p[j]) - 1.5, 3, 3));
    });
    g.strokeStyle = css('--wf-amber'); g.lineWidth = 1; g.beginPath(); g.moveTo(X(t), mt); g.lineTo(X(t), H - mb); g.stroke();
    return i1 - i0;
  }

  // ---------------------------------------------------------------- readout, nearby trades, on air
  function readout(box, N, evs, t) {
    box.replaceChildren();
    for (const e of evs) {
      const open = t < e.close_ts, qt = quoteAt(N, e.quotes.D, Math.min(t, e.close_ts ?? t)), rows = tradesOf(e);
      const card = el('div', 'wf-nt-card'); card.append(el('h3', null, `${e.label} · Democratic contract`));
      const add = (l, v, sub) => { const r = el('div', 'wf-nt-row'); r.append(el('span', 'wf-nt-k', l), el('span', 'wf-nt-v', v)); if (sub) r.append(el('span', 'wf-nt-s', sub)); card.append(r); };
      const seen = qt ? `observed ${fT.format(D(qt.t))}, ${age(t - qt.t)} before the cursor` : 'no two-sided quote yet in this window';
      add('Bid / ask', open && qt ? `${cents(qt.bid)} / ${cents(qt.ask)}` : '— / —', open ? seen : qt ? `no quotes after trading stops · last was ${cents(qt.bid)} / ${cents(qt.ask)}, ${fT.format(D(qt.t))}` : 'trading has stopped');
      add('Quoted mid', open && qt && qt.two ? cents((qt.bid + qt.ask) / 2) : '—', open && qt ? (qt.two ? `spread ${cents(qt.ask - qt.bid)}` : 'one-sided book: no two-sided quote, so no midpoint') : '');
      if (rows) { const j = lowerBound(rows, t + 1e-9) - 1, r = rows[j];
        add('Last trade', r ? cents(pD(r)) : '—', r ? `${age(t - r[0])} before the cursor · ${fS.format(D(r[0]))}${r[1] ? ' · on the Republican contract, shown as 1 − price' : ''}` : 'none yet in this window'); }
      else add('Last trade', '…', 'loading trades');
      const st = (x) => (x ? fMD.format(D(x)) + (fY.format(D(x)) === '2026' ? '' : `, ${fY.format(D(x))}`) : 'not yet');
      add('Status', open ? 'Trading' : !e.settle_ts || t < e.settle_ts ? 'Trading closed, not settled' : `Settled for ${e.result}`, `Kalshi trading close ${st(e.close_ts)} · settlement ${st(e.settle_ts)} · neither is a media call`);
      box.append(card);
    }
  }
  function nearby(ol, head, evs, t) {
    const out = [];
    for (const e of evs) { const rows = tradesOf(e); if (!rows) continue; for (let i = lowerBound(rows, t - NEAR), n = lowerBound(rows, t + NEAR); i < n; i++) out.push([e.label, rows[i]]); }
    out.sort((p, q) => q[1][0] - p[1][0]);
    head.textContent = `${out.length.toLocaleString()} trades, ${Math.round(d3.sum(out, (d) => d[1][4])).toLocaleString()} contracts within ${NEAR} s of the cursor${out.length > 80 ? ' · largest 80 shown' : ''}`;
    const show = out.length > 80 ? out.slice().sort((p, q) => q[1][4] - p[1][4]).slice(0, 80).sort((p, q) => q[1][0] - p[1][0]) : out;
    ol.replaceChildren(...show.map(([ch, r]) => { const li = el('li', `wf-nt-tr ${backsD(r) ? 'is-d' : 'is-r'}`);
      li.append(el('span', 'wf-nt-tt', fS.format(D(r[0]))), el('span', null, ch), el('span', null, `${r[2] ? 'YES' : 'NO'} ${r[1] ? 'R' : 'D'}`), el('span', null, `P(D) ${cents(pD(r))}`), el('span', null, `${r[4].toLocaleString()} contracts`)); return li; }));
    if (!show.length) ol.append(el('li', 'wf-nt-empty', 'No trades this close to the cursor.'));
  }
  function onAir(box, N, t, all) {
    box.replaceChildren();
    const P = dash.data('night_private');
    if (P.status === 'loading') box.append(el('p', 'wf-hint', 'Loading transcripts…'));
    else if (P.status !== 'ok') box.append(el('p', 'wf-hint', 'Transcripts and chat messages are kept in the private research version. Here: each stream on air, a link to the original video at this moment, and how many chat messages were sent in the last full minute before the cursor.'));
    const SR = dash.data('streams'), urls = new Map(SR.status === 'ok' ? SR.data.map((x) => [x.stream_id, x.url]) : []);
    const CH = dash.data('chat'), chat = new Map(), hasChat = new Set();
    if (CH.status === 'ok') for (const r of CH.data) { hasChat.add(r.stream_id); if (r.t === Math.floor(t / 60) * 60 - 60) chat.set(r.stream_id, r.messages); }
    for (const s of N.streams) {
      if (t < s.start || t > s.start + s.dur) continue;
      if (s.clock !== 'chat-verified' && !all) continue;
      const row = el('div', 'wf-nt-air'), h = el('div', 'wf-nt-airh');
      h.append(el('b', s.lean === 'L' ? 'is-d' : 'is-r', s.streamer), el('span', `wf-nt-badge is-${s.clock}`, s.clock === 'chat-verified' ? `clock checked against chat: chat-derived start is ${s.chat_minus_start_s >= 0 ? '+' : ''}${s.chat_minus_start_s} s, shown, not applied` : s.clock === 'upload' ? 'not a live stream: placed by upload time' : 'clock not checked (no chat)'),
        el('span', 'wf-nt-s', `${age(t - s.start)} into the stream`));
      row.append(h);
      const url = urls.get(s.stream_id), off = Math.max(0, Math.floor(t - s.start)), line = el('p', 'wf-nt-links');
      if (url) {
        const at = url.includes('twitch.tv') ? `?t=${Math.floor(off / 3600)}h${Math.floor(off / 60) % 60}m${off % 60}s` : `${url.includes('?') ? '&' : '?'}t=${off}s`;
        const a = el('a', null, `Watch the original at ${fT.format(D(t))} ↗`); a.href = url + at; a.target = '_blank'; a.rel = 'noopener noreferrer';
        line.append(a);
      }
      line.append(el('span', 'wf-nt-s', hasChat.has(s.stream_id) ? ` · chat: ${(chat.get(s.stream_id) || 0).toLocaleString()} messages in the minute to ${fT.format(new Date(Math.floor(t / 60) * 60 * 1000))}` : ' · no chat replay for this stream'));
      row.append(line);
      if (P.status === 'ok') {
        const tx = (P.raw.transcripts[s.stream_id] || []).filter((g) => g[0] <= t + 20 && g[1] >= t - 45);
        for (const g of tx) { const p = el('p', `wf-nt-tx${g[0] <= t && g[1] >= t ? ' is-now' : ''}`); p.append(el('span', 'wf-nt-tt', fT.format(D(g[0]))), document.createTextNode(g[2])); row.append(p); }
        if (!tx.length) row.append(el('p', 'wf-nt-empty', 'no transcript segment at this moment'));
        const ch = (P.raw.chat[s.stream_id] || []).filter((m) => Math.abs(m[0] - t) <= 30).slice(0, 8);
        if (ch.length) { const c = el('p', 'wf-nt-chat'); c.append(el('span', 'wf-nt-tt', 'chat ±30 s'), document.createTextNode(ch.map((m) => m[1]).join('  ·  '))); row.append(c); }
      }
      box.append(row);
    }
    if (!box.querySelector('.wf-nt-air')) box.append(el('p', 'wf-nt-empty', 'No stream with a checked clock was on air at the cursor.'));
  }

  dash.draw('night', {
    mount(root) {
      const q = (s) => root.querySelector(s), m = {ov: null, all: false};
      q('[data-nt=all]').addEventListener('change', (ev) => { m.all = ev.target.checked; dash.draw('night'); });
      return m;
    },
    update(root, m) {
      const N = nc(), q = (s) => root.querySelector(s);
      if (!N) { q('[data-nt=status]').textContent = dash.data('night_control').status === 'error' ? 'night_control.json is missing: run tools/build_night.py' : 'Loading…'; return; }
      const [A, B] = N.window, t = Math.min(B, Math.max(A, WF.t)), box = q('[data-nt=overview]'), {evs, note} = shown(N);
      q('[data-nt=status]').textContent = [WF.t < A || WF.t > B ? `The cursor is outside election night; showing ${fT.format(D(t))} ET.` : '', note].filter(Boolean).join(' ');
      const key = evs.map((e) => e.event).join();
      if (!m.ov || m.ov.W !== (box.clientWidth || 900) || m.ov.key !== key) m.ov = overview(box, N, evs);
      m.ov.cur.attr('x1', m.ov.x(t)).attr('x2', m.ov.x(t));
      const zs = q('[data-nt=zooms]');
      if (zs.dataset.key !== key) { zs.dataset.key = key; zs.replaceChildren(...evs.map(() => { const d = el('div'); d.append(el('h3', 'wf-nt-h'), document.createElement('canvas')); return d; })); }
      evs.forEach((e, k) => { const d = zs.children[k], n = zoom(d.querySelector('canvas'), N, e, t);
        d.querySelector('h3').textContent = `${e.label} · ±10 min · ${tradesOf(e) ? `${n.toLocaleString()} trades` : 'loading trades…'}`; });
      readout(q('[data-nt=readout]'), N, evs, t);
      nearby(q('[data-nt=near]'), q('[data-nt=nearh]'), evs, t);
      onAir(q('[data-nt=air]'), N, t, m.all);
    },
  });
})();
