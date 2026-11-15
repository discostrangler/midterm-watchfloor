// Midterm Watchfloor page logic. Data: data/*.json (built by build_site_data.py). Runtime: assets/dash.js. Charts: d3 v7.
(() => {
  'use strict';
  const ET = 'America/New_York';
  const F = {
    time: new Intl.DateTimeFormat('en-US', {timeZone: ET, hour: 'numeric', minute: '2-digit'}),
    hour: new Intl.DateTimeFormat('en-US', {timeZone: ET, hour: 'numeric'}),
    day: new Intl.DateTimeFormat('en-US', {timeZone: ET, weekday: 'short', month: 'short', day: 'numeric'}),
    md: new Intl.DateTimeFormat('en-US', {timeZone: ET, month: 'short', day: 'numeric'}),
    iso: new Intl.DateTimeFormat('en-CA', {timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit'}),
  };
  const D = (t) => new Date(t * 1000);
  const etDate = (t) => F.iso.format(D(t));
  const when = (t) => `${F.md.format(D(t))}, ${F.time.format(D(t))}`;
  const U = (y, m, d, h) => Date.UTC(y, m - 1, d, h) / 1000;
  // ET is UTC-4 until 2 AM on Nov 1, 2026 and UTC-5 after; the window holds no other change.
  const etOff = (t) => (t < U(2026, 11, 1, 6) ? 4 : 5) * 3600;
  const N0 = U(2026, 11, 3, 22), N1 = U(2026, 11, 4, 16);   // per-minute detail window (Reddit, bets): Nov 3 5 PM - Nov 4 11 AM ET
  const RANGES = {night: [U(2026, 11, 3, 23), U(2026, 11, 4, 13)], week: [U(2026, 11, 1, 4), U(2026, 11, 9, 5)], campaign: [U(2026, 10, 4, 4), U(2026, 11, 12, 5)]};
  const C = {dem: '#3d8bff', rep: '#ff4d5a', ind: '#b48cff', mid: '#4a4f63', idle: '#25303d', none: '#121a24', fg: '#dbe4ee', muted: '#8a9bb0',
    amber: '#f0b44c', house: '#86b6ff', senate: '#e9eef5', social: '#c77dff', bsky: '#5fb3ff'};
  const DATASETS = ['states_geo', 'races', 'race_odds', 'milestones', 'control', 'gas', 'oil', 'weather_state', 'weather_grid', 'turnout_races',
    'turnout_daily', 'streams', 'chat', 'polymarket', 'bets_flow', 'bets_state', 'big_bets', 'reddit_hourly', 'reddit_night', 'bluesky', 'moments',
    'kalshi_cats', 'kalshi_big', 'stocks', 'markets_index', 'kalshi_index', 'polls', 'heatmap'];
  const WF = window.WF = {t: U(2026, 11, 4, 3), range: RANGES.night.slice(), rangeKey: 'night', layer: 'races', office: 'Senate', state: null,
    race: 'CONTROLS-2026', moment: null, mperiod: null, embedsOn: false, tape: 'market', playing: false, timer: null};

  // ------------------------------------------------------------------ helpers
  const ok = (id) => dash.data(id).status === 'ok';
  const rowsOf = (id) => { const d = dash.data(id); return d.status === 'ok' && Array.isArray(d.data) ? d.data : []; };
  const stat = (id) => dash.data(id).status;
  const cache = new Map();
  function memo(key, deps, build) {
    const ds = deps.map((id) => dash.data(id).data);
    const c = cache.get(key);
    if (c && c.ds.every((x, i) => x === ds[i])) return c.v;
    const v = build(...ds.map((x) => x || []));
    cache.set(key, {ds, v});
    return v;
  }
  function group(arr, key, sortKey) {
    const g = new Map();
    for (const r of arr) { const k = key(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    if (sortKey) for (const s of g.values()) s.sort((a, b) => (a[sortKey] < b[sortKey] ? -1 : a[sortKey] > b[sortKey] ? 1 : 0));
    return g;
  }
  function lastAt(s, v, k = 't') {
    if (!s || !s.length || s[0][k] > v) return null;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m][k] <= v) lo = m; else hi = m - 1; }
    return s[lo];
  }
  function firstIdx(s, v, k = 't') {   // first index with s[i][k] >= v
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m][k] < v) lo = m + 1; else hi = m; }
    return lo;
  }
  function sumBetween(s, a, b, f) { let x = 0; for (let i = firstIdx(s, a); i < s.length && s[i].t < b; i++) x += f(s[i]); return x; }
  // sum of rows whose bin [t, t + r) ENDED in (b - span, b]: replay readouts never count activity after the cursor (bins <= 1 h)
  function sumDone(s, b, span, f, defR) {
    let x = 0;
    for (let i = firstIdx(s, b - span - 3600); i < s.length && s[i].t < b; i++) { const e = s[i].t + (s[i].r || defR); if (e > b - span && e <= b) x += f(s[i]); }
    return x;
  }
  const fullHour = (h) => `${F.time.format(D(h))}–${F.time.format(D(h + 3600))} ET, full hour`;
  // spread each row's value over the bins its [t, t + r) interval overlaps
  function binSum(rows, a, b, nb, val, defR) {
    const bw = (b - a) / nb, out = new Float64Array(nb);
    for (const d of rows) {
      const r = d.r || defR, s = d.t, e = d.t + r;
      if (e <= a || s >= b) continue;
      const v = val(d);
      if (!v) continue;
      const lo = Math.max(s, a), hi = Math.min(e, b);
      for (let k = Math.floor((lo - a) / bw); k < nb; k++) {
        const bs = a + k * bw, be = bs + bw, ov = Math.min(hi, be) - Math.max(lo, bs);
        if (ov > 0) out[k] += (v * ov) / r;
        if (be >= hi) break;
      }
    }
    return out;
  }
  function ticks(a, b, W) {
    const span = b - a, target = Math.max(3, Math.floor(W / 95));
    const steps = [900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 345600, 604800];
    const step = steps.find((s) => span / s <= target) || 604800;
    const out = [];
    if (step < 86400) { for (let t = Math.ceil((a - etOff(a)) / step) * step + etOff(a); t <= b; t += step) out.push(t); }
    else {
      const days = step / 86400;
      let d = new Date(`${etDate(a)}T00:00:00Z`);
      for (let i = 0; i < 400; i++) {
        const t = d.getTime() / 1000 + etOff(d.getTime() / 1000 + 5 * 3600);
        if (t > b) break;
        if (t >= a) out.push(t);
        d = new Date(d.getTime() + days * 86400000);
      }
    }
    return {out, step};
  }
  const tickLabel = (t, step) => (step >= 86400 || (t - etOff(t)) % 86400 === 0 ? F.md.format(D(t)) : F.hour.format(D(t)));
  const median = (xs) => { if (!xs.length) return 0; const s = xs.slice().sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pct1 = (p) => `${(p * 100).toFixed(1)}%`;
  const fmtInt = d3.format(',');
  const fmtVotes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}K`);
  const fmtN = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(x >= 1e8 ? 0 : 1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}K` : x >= 10 || x === 0 ? `${Math.round(x)}` : x.toFixed(x < 1 ? 2 : 1));
  const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}K` : x >= 1 || x === 0 ? `$${Math.round(x)}` : `$${x.toFixed(2)}`);
  const signed = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`;
  const cents = (p) => `${Math.round(p * 100)}¢`;
  const party = (w) => ({D: 'Democrats', R: 'Republicans'}[w] || 'other');
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

  // ------------------------------------------------------------------ indexes
  const RX = () => memo('races', ['races'], (races) => ({
    byState: group(races, (r) => r.state),
    byId: new Map(races.map((r) => [r.race_id, r])),
    calls: races.filter((r) => r.called_ts && r.winner).sort((a, b) => a.called_ts - b.called_ts),
  }));
  const ODDS = () => memo('odds', ['race_odds'], (o) => group(o, (r) => r.race_id, 't'));
  const CTRL = () => memo('ctrl', ['control'], (c) => group(c, (r) => r.chamber, 't'));
  const GAS = () => memo('gas', ['gas'], (g) => ({
    m: new Map(g.map((r) => [`${r.state}|${r.date}`, r])),
    byState: group(g, (r) => r.state, 'date'),
    ext: d3.extent(g.filter((r) => r.state !== 'US'), (r) => r.price),
  }));
  const OIL = () => memo('oil', ['oil'], (o) => group(o, (r) => r.series, 'date'));
  const WX = () => memo('wx', ['weather_state'], (w) => new Map(w.map((r) => [`${r.state}|${r.date}`, r])));
  const TURN = () => memo('turn', ['turnout_races', 'turnout_daily'], (tr, td) => ({byState: group(tr, (r) => r.state), daily: group(td, (r) => r.race_id, 't')}));
  const CHAT = () => memo('chat', ['chat'], (c) => { const m = new Map(); for (const r of c) m.set(r.t, (m.get(r.t) || 0) + r.messages); return m; });
  const CHATSPAN = () => memo('chatspan', ['chat'], (c) => d3.extent(c, (r) => r.t));
  const NAMES = () => memo('names', ['states_geo'], (g) => new Map(((g && g.features) || []).map((f) => [f.properties.state, f.properties.name])));
  const FLOW = () => memo('flow', ['bets_flow'], (f) => f.slice().sort((a, b) => a.t - b.t));
  const BST = () => memo('bst', ['bets_state'], (b) => ({
    m: new Map(b.map((r) => [`${r.state}|${r.t}`, r])), byState: group(b, (r) => r.state, 't'), max: d3.max(b, (r) => r.usd) || 1e6}));
  const BIG = () => memo('big', ['big_bets'], (b) => b.slice().sort((p, q) => p.t - q.t));
  // Reddit: national subreddits (state 'US') as one series, per minute on election night when that file exists
  const RED_US = () => memo('redus', ['reddit_hourly', 'reddit_night'], (h, n) => {
    const night = n.length > 0;
    const rows = h.filter((r) => r.state === 'US' && !(night && r.t >= N0 && r.t < N1)).map((r) => ({t: r.t, r: 3600, c: r.comments, p: r.posts}));
    for (const r of n) rows.push({t: r.t, r: 60, c: r.comments, p: r.posts});
    return rows.sort((a, b) => a.t - b.t);
  });
  const RED_ST = () => memo('redst', ['reddit_hourly'], (h) => {
    const byState = group(h.filter((r) => r.state !== 'US'), (r) => r.state, 't');
    const usual = new Map(), sub = new Map();
    for (const [st, s] of byState) { usual.set(st, median(s.map((r) => r.comments))); sub.set(st, s[0].sub); }
    return {byState, usual, sub};
  });
  const BSKY = () => memo('bsky', ['bluesky'], (b) => ({all: b.slice().sort((p, q) => p.t - q.t), byState: group(b, (r) => r.state, 't')}));
  const MOMENTS = () => memo('moments', ['moments'], (m) => m.slice().sort((a, b) => a.t - b.t));
  const closeT = (ds) => Date.parse(`${ds}T16:00:00Z`) / 1000 + etOff(Date.parse(`${ds}T20:00:00Z`) / 1000);   // 4 PM ET close
  const STK = () => memo('stk', ['stocks'], (rows) => group(rows.map((r) => ({...r, t: closeT(r.date)})), (r) => r.series, 't'));

  const ctrlRow = (ev) => rowsOf('milestones').find((m) => m.event === ev);
  function raceInfo(id) {
    if (id === 'CONTROLS-2026' || id === 'CONTROLH-2026') {
      const chamber = id === 'CONTROLS-2026' ? 'Senate' : 'House', ms = ctrlRow(id) || {};
      return {race_id: id, label: `${chamber} control`, office: 'Control', state: 'US', chamber, winner: ms.winner || '', called_ts: ms.settled_ts || null, volume: ms.volume || 0};
    }
    const r = ok('races') ? RX().byId.get(id) || null : null;
    if (r || !ok('markets_index')) return r;
    const m = MIDX().get(id);
    if (m && m.cat === 'midterms') return {race_id: id, label: m.label, office: 'Control', state: 'US', winner: m.party_winner || '', called_ts: m.called_ts, volume: m.volume};
    return m ? {race_id: id, label: m.label, office: 'Market', cat: m.cat, state: 'US', winner: m.winner, called_ts: m.called_ts, volume: m.volume, night_usd: m.night_usd} : null;
  }
  const MIDX = () => memo('midx', ['markets_index'], (rows) => new Map(rows.map((m) => [m.id, m])));
  // One status for the market card and the election-night panel: data/night_races.json (our catalog's close_time and
  // settlement_ts; tools/build_races_night.py). Control markets: data/night_control.json. Falls back to races.json.
  dash.load('night_races', 'data/night_races.json');
  const whenY = (t) => `${when(t)}${new Date(t * 1000).getUTCFullYear() === 2026 ? '' : `, ${new Date(t * 1000).getUTCFullYear()}`}`;
  function nightOf(id) {
    const nc = dash.data('night_control');
    const c = nc.status === 'ok' ? nc.raw.events.find((x) => x.event === id) : null;
    if (c) return {ev: c, win: nc.raw.window};
    const ix = dash.data('night_races'), n = ix.status === 'ok' ? ix.raw.races[id] : null;
    if (!n) return null;
    const k = `ns:${n.state}`; if (stat(k) === 'idle') dash.load(k, `data/night_state/${n.state}.json`);
    const d = dash.data(k);
    return {n, ev: d.status === 'ok' ? d.raw.races[id] : null, win: ix.raw.meta.window};
  }
  function marks(id) {
    const x = nightOf(id), r = raceInfo(id);
    if (x && x.ev) return {close: x.ev.close_ts, settle: x.ev.settle_ts, result: x.ev.result};
    if (x && x.n) return {close: x.n.close_ts, settle: x.n.settle_ts, result: x.n.result};
    return {close: null, settle: r && r.called_ts, result: r && r.winner};
  }
  function statusLine(id, t) {
    const k = marks(id);
    if (k.settle && t >= k.settle) return `Kalshi settled for ${party(k.result)}, ${whenY(k.settle)}`;
    if (k.close && t >= k.close) return `Kalshi trading closed ${whenY(k.close)}, not settled yet`;
    return `Trading at the cursor${k.close ? ` · trading closes ${whenY(k.close)}` : ''}`;
  }
  // latest two-sided quote on the Democratic contract observed at or before t (election night only)
  function quotedMid(id, t) {
    const x = nightOf(id);
    if (!x || !x.ev || t < x.win[0] || t > x.win[1]) return null;
    const q = x.ev.quotes.D, tt = Math.min(t, x.ev.close_ts || t);
    for (let i = Math.min(Math.floor((tt - x.win[0]) / 60) - 1, q.bid.length - 1); i >= 0; i--)
      if (q.bid[i] != null && q.ask[i] != null) return {bid: q.bid[i], ask: q.ask[i], t: x.win[0] + (i + 1) * 60, closed: t >= (x.ev.close_ts || Infinity), one: !(q.bid[i] > 0 && q.ask[i] < 1)};
    return {none: true};
  }
  function emptyMsg(s) {
    const lab = s.r ? s.r.label : s.id, k = marks(s.id);
    if (k.settle && k.settle < RANGES.campaign[0]) return `${lab}: Kalshi settled this market for ${party(k.result)} on ${whenY(k.settle)}, before Oct 4, when the market card's trade data starts. There are no prices or trades to chart.`;
    if (s.ds && s.ds.error && /HTTP 404/.test(s.ds.error)) return `${lab}: this copy of the site does not include its market file (HTTP 404), so the card cannot show its prices or trades. That says nothing about whether it traded.`;
    return `${lab}: the market data did not load (${s.ds && s.ds.error ? s.ds.error : 'unknown error'}). This is a download problem, not a lack of trades: use Retry.`;
  }
  const raceUrl = (id) => `data/race/${encodeURIComponent(id)}.json`;
  const failedDays = new Map();   // day files that did not load: listed under the tape, re-requested when "This market" is clicked
  const evOf = (tk) => tk.slice(0, tk.lastIndexOf('-'));
  function raceFor(st, office) {
    const list = (RX().byState.get(st) || []).filter((r) => r.office === office);
    return list.find((r) => !r.special) || list[0] || null;
  }
  const primaryRace = (st) => raceFor(st, 'Senate') || raceFor(st, 'Governor');
  function pDem(r, t) {
    if (!r) return null;
    if (r.called_ts && t >= r.called_ts && (r.winner === 'D' || r.winner === 'R')) return {p: r.winner === 'D' ? 1 : 0, settled: true};
    const row = lastAt(ODDS().get(r.race_id), t);
    return row ? {p: row.p_dem, gap: row.p_dem == null, closed: !!row.closed, row, settled: false} : null;
  }
  function houseAt(st, t) {
    const hs = (RX().byState.get(st) || []).filter((r) => r.office === 'House');
    let d = 0, rr = 0, o = 0;
    for (const x of hs) if (x.called_ts && x.called_ts <= t) { if (x.winner === 'D') d++; else if (x.winner === 'R') rr++; else o++; }
    return {n: hs.length, d, r: rr, o, open: hs.length - d - rr - o};
  }
  function turnoutAt(st, t) {
    const tr = TURN().byState.get(st) || [];
    const race = tr.find((x) => x.office === 'Senate') || tr.find((x) => x.office === 'Governor');
    if (!race) return null;
    const row = lastAt(TURN().daily.get(race.race_id), t);
    return {race, row, ratio: row && race.baseline_votes ? row.implied_votes / race.baseline_votes : null};
  }
  function socialAt(st, t) {
    if (!ok('reddit_hourly')) return null;
    const S = RED_ST(), row = lastAt(S.byState.get(st), t);
    if (!row || row.t < t - 3600) return {sub: S.sub.get(st), row: null};
    const usual = S.usual.get(st) || 0;
    return {sub: row.sub, row, usual, ratio: usual > 0 ? row.comments / usual : null};
  }
  const bskyAt = (st, t) => (ok('bluesky') ? lastAt(BSKY().byState.get(st), t) : null);

  const partyScale = d3.scaleLinear().domain([0, 0.5, 1]).range([C.rep, C.mid, C.dem]).interpolate(d3.interpolateLab).clamp(true);
  const rainScale = d3.scaleSqrt().domain([0, 25]).range(['#16222e', '#36c5d6']).clamp(true);
  const turnScale = d3.scaleLinear().domain([0.8, 1, 1.2]).range(['#e2734a', '#3a4654', '#46d39a']).interpolate(d3.interpolateLab).clamp(true);
  const socialScale = d3.scaleLog().domain([0.5, 1.4, 4]).range(['#1a2430', '#46405e', '#c77dff']).interpolate(d3.interpolateLab).clamp(true);
  const betsScale = () => d3.scaleLog().domain([1e3, Math.sqrt(1e3 * Math.max(1e4, BST().max)), Math.max(1e4, BST().max)]).range(['#17222e', '#6b5a2a', '#ffd166']).interpolate(d3.interpolateLab).clamp(true);
  const gasScale = () => { const [a, b] = GAS().ext[0] != null ? GAS().ext : [3, 5]; return d3.scaleLinear().domain([a, (a + b) / 2, b]).range(['#1f3446', '#9a7a33', '#ffb347']).interpolate(d3.interpolateLab).clamp(true); };

  function fillFor(st, t) {
    const day = F.md.format(D(t));
    const need = {races: ['races'], bets: ['bets_state'], social: ['reddit_hourly'], gas: ['gas'], rain: ['weather_state'], turnout: ['turnout_races', 'turnout_daily']}[WF.layer];
    if (need.some((id) => stat(id) === 'error')) return {fill: C.none, text: 'This layer\'s data is not available'};
    if (need.some((id) => !ok(id))) return {fill: C.none, text: 'Loading…'};
    if (WF.layer === 'races') {
      if (WF.office === 'House') {
        const h = houseAt(st, t);
        if (!h.n) return {fill: C.none, text: 'No House race in the data'};
        if (h.n === h.open) return {fill: C.idle, text: `${h.n} House seats · none settled yet`};
        return {fill: partyScale(0.5 + (h.d - h.r) / (2 * h.n)), text: `${h.n} House seats · settled D ${h.d}, R ${h.r}${h.o ? `, other ${h.o}` : ''} · ${h.open} open`};
      }
      const r = raceFor(st, WF.office);
      if (!r) return {fill: C.none, text: `No ${WF.office} race in 2026`};
      const x = pDem(r, t);
      if (!x) return {fill: C.idle, text: `${r.label} · no price at this time`};
      if (x.settled) return {fill: x.p ? C.dem : C.rep, text: `${r.label} · settled ${r.winner} at ${when(r.called_ts)}`};
      if (x.closed) return {fill: C.idle, text: `${r.label} · trading closed ${when(x.row.t)}, not settled yet`};
      if (x.gap) return {fill: C.idle, text: `${r.label} · no two-sided quote at this time (since ${when(x.row.t)})`};
      return {fill: partyScale(x.p), text: `${r.label} · P(D) ${pct1(x.p)}, quoted mid`};
    }
    if (WF.layer === 'bets') {
      const h = Math.floor(t / 3600) * 3600, b = BST().m.get(`${st}|${h}`);
      return b ? {fill: betsScale()(Math.max(1e3, b.usd)), text: `${usd(b.usd)} in ${fmtInt(b.bets)} bets on this state's races, ${fullHour(h)}`}
        : {fill: C.none, text: `No bets on this state's races, ${fullHour(h)}`};
    }
    if (WF.layer === 'social') {
      const s = socialAt(st, t), bs = bskyAt(st, t - 600);   // last 10-min Bluesky bin that ended by the cursor
      const bText = bs && bs.t > t - 1200 ? ` · Bluesky: ${bs.posts} top posts in the 10 min to ${F.time.format(D(bs.t + 600))}` : '';
      if (!s || !s.row) return {fill: C.none, text: `${s && s.sub ? `r/${s.sub}: no count for this hour` : 'No subreddit tracked'}${bText}`};
      return {fill: s.ratio == null ? C.idle : socialScale(Math.max(0.5, s.ratio)),
        text: `r/${s.sub}: ${fmtInt(s.row.comments)} comments, ${fmtInt(s.row.posts)} posts, ${fullHour(s.row.t)}${s.ratio != null ? ` (${s.ratio.toFixed(1)}× its usual hour)` : ''}${bText}`};
    }
    if (WF.layer === 'gas') {
      const g = GAS().m.get(`${st}|${etDate(t)}`);
      return g ? {fill: gasScale()(g.price), text: `AAA regular $${g.price.toFixed(3)} on ${day}`} : {fill: C.none, text: `No AAA state market on ${day}`};
    }
    if (WF.layer === 'rain') {
      const w = WX().get(`${st}|${etDate(t)}`);
      return w ? {fill: rainScale(w.prcp_mm), text: `${w.prcp_mm.toFixed(1)} mm average on ${day} · ${Math.round(w.wet_share * 100)}% of ${w.stations} stations had 2.5 mm or more`} : {fill: C.none, text: `No station data for ${day}`};
    }
    const x = turnoutAt(st, t);
    if (!x) return {fill: C.none, text: 'No statewide turnout market'};
    if (!x.row) return {fill: C.idle, text: `${x.race.office} turnout market · not trading yet`};
    const imp = `${x.race.office} turnout market puts 50/50 at ${fmtVotes(x.row.implied_votes)} votes${x.row.flag ? ` (${x.row.flag} its ladder)` : ''}`;
    if (x.ratio == null) return {fill: C.idle, text: `${imp} · no comparison year`};
    return {fill: turnScale(x.ratio), text: `${imp} · ${signed(x.ratio - 1)} vs ${fmtVotes(x.race.baseline_votes)} in ${x.race.baseline_year}`};
  }

  // ------------------------------------------------------------------ state + redraw plumbing
  const CURSOR_DRAWS = ['map', 'feed', 'clock', 'scrub', 'scrub-clock', 'kpi-sen', 'kpi-house', 'kpi-called', 'kpi-bets', 'kpi-reddit', 'kpi-gas',
    'kpi-wti', 'kpi-chat', 'lanes', 'st-races', 'st-spark', 'st-bets', 'st-bets-spark', 'st-social', 'st-gas', 'st-gas-spark', 'st-rain', 'st-turnout',
    'tape', 'tape-sub', 'mkt-vol', 'mkt-head', 'mkt-chart', 'mkt-table', 'kpi-kalshi', 'kpi-spx', 'moments', 'moment-tabs', 'moment-detail', 'mkt-polls', 'heatmap', 'night'];
  const STATE_DRAWS = ['map', 'st-name', 'st-races', 'st-spark', 'st-bets', 'st-bets-spark', 'st-social', 'st-gas', 'st-gas-spark', 'st-rain', 'st-turnout'];
  const RACE_DRAWS = ['race-select', 'mkt-vol', 'mkt-q', 'mkt-th', 'mkt-chart-hint', 'mkt-head', 'mkt-chart', 'mkt-table', 'mkt-polls', 'st-races', 'tape', 'tape-sub', 'night', 'heatmap'];
  const redraw = (names) => names.forEach((n) => dash.draw(n));
  function setT(t) {
    const [a, b] = WF.range;
    WF.t = Math.round(Math.min(b, Math.max(a, t)) / 60) * 60;
    redraw(CURSOR_DRAWS);
  }
  function pick(st, {race = true} = {}) {
    WF.state = st;
    if (race && ok('races')) { const r = primaryRace(st); if (r) WF.race = r.race_id; }
    redraw(STATE_DRAWS); redraw(RACE_DRAWS);
  }
  function pickRace(id) {
    WF.race = id;
    if (dash.data(`race:${id}`).error) dash.load(`race:${id}`, raceUrl(id));   // picking a market again retries a failed download
    const r = raceInfo(id);
    if (r && r.state && r.state !== 'US' && r.state !== WF.state) { WF.state = r.state; redraw(STATE_DRAWS); }
    redraw(RACE_DRAWS);
  }
  function pickMoment(m) {
    WF.moment = m.id;
    WF.mperiod = null;
    if (m.t < WF.range[0] || m.t > WF.range[1]) {
      const k = ['night', 'week', 'campaign'].find((r) => m.t >= RANGES[r][0] && m.t <= RANGES[r][1]) || 'campaign';
      WF.rangeKey = k; WF.range = RANGES[k].slice(); syncUI();
    }
    if (m.race_id) WF.race = m.race_id;
    if (m.state && m.state !== 'US') WF.state = m.state;
    redraw(STATE_DRAWS); redraw(RACE_DRAWS);
    setT(Math.ceil(m.t / 60) * 60);   // the cursor is per minute: round UP so a settlement moment shows as settled
  }
  const stepSize = () => Math.max(60, Math.round((WF.range[1] - WF.range[0]) / 400 / 60) * 60);

  function syncUI() {
    document.querySelectorAll('.wf [data-layer]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layer === WF.layer)));
    document.querySelectorAll('.wf [data-office]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.office === WF.office)));
    document.querySelectorAll('.wf [data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === WF.rangeKey)));
    document.querySelectorAll('.wf [data-tape]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tape === WF.tape)));
    const office = document.getElementById('wf-office');
    if (office) office.hidden = WF.layer !== 'races';
    const want = WF.layer === 'races' ? (WF.office === 'House' ? 'house' : 'races') : WF.layer;
    document.querySelectorAll('.wf [data-legend]').forEach((l) => { l.hidden = l.dataset.legend !== want; });
    document.querySelectorAll('.wf [data-play-btn]').forEach((b) => {
      b.setAttribute('aria-pressed', String(WF.playing));
      b.querySelectorAll('[data-play]').forEach((s) => { s.hidden = (s.dataset.play === 'running') !== WF.playing; });
    });
  }
  function stop() { WF.playing = false; if (WF.timer) clearInterval(WF.timer); WF.timer = null; syncUI(); }
  function play() {
    if (WF.t >= WF.range[1]) WF.t = WF.range[0];
    WF.playing = true; WF.moment = null; syncUI();
    WF.timer = setInterval(() => {
      const next = WF.t + Math.max(60, Math.round((WF.range[1] - WF.range[0]) / 480 / 60) * 60);
      setT(next);
      if (next >= WF.range[1]) stop();
    }, 110);
  }
  document.querySelectorAll('.wf [data-layer]').forEach((b) => b.addEventListener('click', () => {
    WF.layer = b.dataset.layer; syncUI(); redraw(['map', 'leg-gas-min', 'leg-gas-max', 'leg-bets-max']);
  }));
  document.querySelectorAll('.wf [data-office]').forEach((b) => b.addEventListener('click', () => { WF.office = b.dataset.office; syncUI(); dash.draw('map'); }));
  document.querySelectorAll('.wf [data-range]').forEach((b) => b.addEventListener('click', () => {
    WF.rangeKey = b.dataset.range; WF.range = RANGES[WF.rangeKey].slice(); syncUI();
    setT(WF.t < WF.range[0] || WF.t > WF.range[1] ? WF.range[0] : WF.t);
    redraw(['st-spark']);
  }));
  document.querySelectorAll('.wf [data-play-btn]').forEach((b) => b.addEventListener('click', () => (WF.playing ? stop() : play())));
  document.querySelectorAll('.wf [data-tape]').forEach((b) => b.addEventListener('click', () => {
    WF.tape = b.dataset.tape; syncUI();
    if (WF.tape === 'market') for (const [k, url] of failedDays) dash.load(k, url);
    redraw(['tape', 'tape-sub']);
  }));
  const scrub = document.getElementById('wf-scrub');
  scrub.addEventListener('input', () => { if (WF.playing) stop(); WF.moment = null; setT(+scrub.value); });
  document.getElementById('wf-race-select').addEventListener('change', (e) => pickRace(e.target.value));

  dash.onData((id) => {
    if (id === 'races' && !WF.state && ok('races')) {
      const top = rowsOf('races').filter((r) => r.office === 'Senate').sort((a, b) => b.volume - a.volume)[0];
      WF.state = top ? top.state : null;
    }
  });

  // ------------------------------------------------------------------ header and reading strip
  const stamp = (m) => (m && m.settled_ts ? `${F.time.format(D(m.settled_ts))} ET on ${F.md.format(D(m.settled_ts))}` : '—');
  dash.draw('tk-sen-winner', (el) => { const m = ctrlRow('CONTROLS-2026'); el.textContent = m ? `the ${party(m.winner)}` : '—'; });
  dash.draw('tk-house-winner', (el) => { const m = ctrlRow('CONTROLH-2026'); el.textContent = m ? `the ${party(m.winner)}` : '—'; });
  dash.draw('tk-sen-time', (el) => { el.textContent = stamp(ctrlRow('CONTROLS-2026')); });
  dash.draw('tk-house-time', (el) => { el.textContent = stamp(ctrlRow('CONTROLH-2026')); });
  dash.draw('tk-bigbet', (el) => {
    const b = ok('big_bets') && ok('races') ? BIG().reduce((x, y) => (!x || y.usd > x.usd ? y : x), null) : null;
    const r = b && raceInfo(b.race_id);
    if (!b || !r) { el.textContent = ''; return; }
    const won = r.winner ? (r.winner === b.backs ? 'and won' : 'and lost') : '';
    el.textContent = `The largest bet with real doubt in it was ${usd(b.usd)} backing the ${party(b.backs)} in ${r.label} at ${cents(b.price)}, ${when(b.t)}, ${won}.`.replace(', .', '.');
  });

  const clockText = () => `${F.day.format(D(WF.t))} · ${F.time.format(D(WF.t))}`;
  dash.draw('clock', (el) => { el.textContent = clockText(); });
  dash.draw('scrub-clock', (el) => { el.textContent = clockText(); });
  dash.draw('scrub', (el) => { el.min = WF.range[0]; el.max = WF.range[1]; el.value = WF.t; el.setAttribute('aria-valuetext', clockText()); });
  const ctrlTxt = (r) => (!r ? '—' : r.closed ? 'closed' : r.p_dem == null ? 'no quote' : pct1(r.p_dem));
  const kpiCtrl = (chamber) => (el) => {
    const r = ok('control') ? lastAt(CTRL().get(chamber), WF.t) : null, ms = ctrlRow(`CONTROL${chamber[0]}-2026`);
    el.classList.remove('is-d', 'is-r');
    el.textContent = ctrlTxt(r);
    el.title = !r ? '' : r.closed ? `Trading closed ${when(r.t)}; Kalshi had not settled it yet` : r.p_dem == null ? `No two-sided quote since ${when(r.t)}`
      : ms && ms.settled_ts && WF.t >= ms.settled_ts ? `Settled ${when(ms.settled_ts)}` : `Quoted mid, observed ${when(r.t)}`;
    if (r && r.p_dem != null) el.classList.add(r.p_dem >= 0.5 ? 'is-d' : 'is-r');
  };
  dash.draw('kpi-sen', kpiCtrl('Senate'));
  dash.draw('kpi-house', kpiCtrl('House'));
  dash.draw('kpi-called', (el) => { el.textContent = ok('races') ? fmtInt(RX().calls.filter((r) => r.called_ts <= WF.t).length) : '—'; });
  dash.draw('kpi-total', (el) => { el.textContent = ok('races') ? fmtInt(rowsOf('races').length) : '—'; });
  dash.draw('kpi-bets', (el) => {
    if (!ok('bets_flow')) { el.textContent = stat('bets_flow') === 'error' ? 'n/a' : '—'; return; }
    const s = FLOW(), sum = (f) => sumDone(s, WF.t, 3600, f, 600);
    const d = sum((x) => x.d), r = sum((x) => x.rr), o = sum((x) => x.o);
    const tot = d + r + o;
    el.textContent = usd(tot);
    el.classList.toggle('is-d', tot > 0 && d > r);
    el.classList.toggle('is-r', tot > 0 && r >= d);
    el.title = tot ? `${Math.round((100 * d) / tot)}% backing D, ${Math.round((100 * r) / tot)}% backing R` : '';
  });
  dash.draw('kpi-kalshi', (el) => {
    if (!ok('kalshi_cats')) { el.textContent = stat('kalshi_cats') === 'error' ? 'n/a' : '—'; return; }
    el.textContent = fmtN(sumDone(rowsOf('kalshi_cats'), WF.t, 3600, (r) => r.n, 3600));   // last full hour ended by the cursor
  });
  dash.draw('kpi-spx', (el) => {
    const s = ok('stocks') ? STK().get('SP500') : null, r = s ? lastAt(s, WF.t) : null;
    if (!r) { el.textContent = '—'; return; }
    const prev = s[s.indexOf(r) - 1];
    el.textContent = fmtInt(Math.round(r.value));
    el.classList.toggle('is-d', false); el.classList.toggle('is-r', false);
    el.title = prev ? `${r.date} close: ${((r.value / prev.value - 1) * 100).toFixed(1)}% vs the day before` : r.date;
  });
  dash.draw('kpi-reddit', (el) => {
    if (!ok('reddit_hourly')) { el.textContent = stat('reddit_hourly') === 'error' ? 'n/a' : '—'; return; }
    const s = RED_US(), inNight = ok('reddit_night') && WF.t >= N0 + 600 && WF.t < N1;
    const span = inNight ? 600 : 3600;   // per-minute bins on election night, else the last full hour
    const c = sumDone(s, WF.t, span, (r) => r.c, 3600);
    el.textContent = `${fmtInt(Math.round(c / (span / 60)))}`;
  });
  dash.draw('kpi-gas', (el) => {
    const g = ok('gas') ? GAS().m.get(`US|${etDate(WF.t)}`) : null;
    el.textContent = g ? `$${g.price.toFixed(3)}` : '—';
  });
  dash.draw('kpi-wti', (el) => {
    const o = ok('oil') ? lastAt(OIL().get('WTI'), etDate(WF.t), 'date') : null;
    el.textContent = o ? `$${o.price.toFixed(2)}` : '—';
  });
  dash.draw('kpi-chat', (el) => {
    const [a, b] = ok('chat') ? CHATSPAN() : [null, null];
    if (a == null || WF.t < a || WF.t > b + 60) { el.textContent = '—'; return; }
    el.textContent = fmtInt(CHAT().get(Math.floor(WF.t / 60) * 60 - 60) || 0);   // last full minute before the cursor
  });
  dash.draw('leg-gas-min', (el) => { el.textContent = ok('gas') && GAS().ext[0] != null ? `$${GAS().ext[0].toFixed(2)}` : '—'; });
  dash.draw('leg-gas-max', (el) => { el.textContent = ok('gas') && GAS().ext[1] != null ? `$${GAS().ext[1].toFixed(2)}` : '—'; });
  dash.draw('leg-bets-max', (el) => { el.textContent = ok('bets_state') ? usd(BST().max) : '—'; });

  // ------------------------------------------------------------------ map
  dash.draw('map', {
    mount(el) {
      const box = d3.select(el);
      const msg = box.append('p').attr('class', 'wf-msg');
      const svg = box.append('svg').attr('class', 'wf-map-svg').attr('role', 'img')
        .attr('aria-label', 'Map of U.S. states colored by the chosen layer at the cursor time');
      const g = {states: svg.append('g'), dots: svg.append('g'), rings: svg.append('g'), labels: svg.append('g').attr('class', 'wf-labels')};
      const tip = box.append('div').attr('class', 'wf-tip').attr('hidden', '');
      return {box, msg, svg, g, tip, tipB: tip.append('b'), tipS: tip.append('span'), w: 0};
    },
    update(el, m) {
      const geo = dash.data('states_geo');
      if (geo.status !== 'ok' || !geo.data || !geo.data.features) {
        m.svg.attr('hidden', ''); m.msg.attr('hidden', null).text(geo.status === 'error' ? 'Failed to load the map.' : 'Loading map…'); return;
      }
      m.msg.attr('hidden', ''); m.svg.attr('hidden', null);
      const feats = geo.data.features;
      const W = Math.max(280, Math.floor(el.clientWidth || 800)), H = Math.round(W * 0.6);
      let resized = false;
      if (m.w !== W) {
        m.w = W; resized = true;
        m.proj = d3.geoAlbersUsa().fitExtent([[8, 8], [W - 8, H - 8]], {type: 'FeatureCollection', features: feats});
        m.path = d3.geoPath(m.proj);
        m.cent = new Map(feats.map((f) => [f.properties.state, m.path.centroid(f)]));
        m.svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
      }
      const t = WF.t;
      const info = new Map(feats.map((f) => [f.properties.state, fillFor(f.properties.state, t)]));
      m.info = info;
      const showTip = (ev, f) => {
        const [x, y] = d3.pointer(ev, el);
        m.tipB.text(f.properties.name); m.tipS.text(m.info.get(f.properties.state).text);
        m.tip.attr('hidden', null).style('left', `${Math.max(0, Math.min(x + 14, el.clientWidth - 270))}px`).style('top', `${Math.max(0, y - 10)}px`);
      };
      const paths = m.g.states.selectAll('path').data(feats, (f) => f.properties.state).join((en) => en.append('path').attr('class', 'wf-st').attr('tabindex', 0)
        .on('click', (ev, f) => pick(f.properties.state))
        .on('keydown', (ev, f) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(f.properties.state); } }));
      paths.on('pointermove', showTip).on('pointerleave', () => m.tip.attr('hidden', ''));
      if (resized || paths.attr('d') == null) paths.attr('d', m.path);
      paths.style('fill', (f) => info.get(f.properties.state).fill)
        .classed('is-sel', (f) => f.properties.state === WF.state)
        .attr('aria-label', (f) => `${f.properties.name}: ${info.get(f.properties.state).text}`);
      paths.filter('.is-sel').raise();

      const recent = WF.layer === 'races' && ok('races') ? RX().calls.filter((r) => r.office === WF.office && r.called_ts <= t && r.called_ts > t - 1800) : [];
      const okC = (st) => m.cent.get(st) && !isNaN(m.cent.get(st)[0]);
      m.g.rings.selectAll('circle').data(recent.filter((r) => okC(r.state)), (r) => r.race_id).join('circle').attr('class', 'wf-ring')
        .attr('cx', (r, i) => m.cent.get(r.state)[0] + (r.office === 'House' ? ((i % 5) - 2) * 4 : 0))
        .attr('cy', (r) => m.cent.get(r.state)[1]).attr('r', 9)
        .style('stroke', (r) => (r.winner === 'D' ? C.dem : r.winner === 'R' ? C.rep : C.ind));

      const dots = WF.layer === 'rain' && etDate(t) === '2026-11-03' && ok('weather_grid')
        ? rowsOf('weather_grid').map((d) => ({d, p: m.proj([d.lon, d.lat])})).filter((x) => x.p) : [];
      m.g.dots.selectAll('circle').data(dots, (x) => `${x.d.lat},${x.d.lon}`).join('circle')
        .attr('cx', (x) => x.p[0]).attr('cy', (x) => x.p[1]).attr('r', (x) => Math.min(4.2, 0.7 + Math.sqrt(x.d.prcp_mm) * 0.7))
        .style('fill', (x) => rainScale(x.d.prcp_mm)).style('opacity', (x) => (x.d.prcp_mm < 0.5 ? 0.12 : 0.9)).style('pointer-events', 'none');

      const lab = W >= 640 ? feats.filter((f) => okC(f.properties.state)) : [];
      m.g.labels.selectAll('text').data(lab, (f) => f.properties.state).join('text')
        .attr('x', (f) => m.cent.get(f.properties.state)[0]).attr('y', (f) => m.cent.get(f.properties.state)[1] + 3).text((f) => f.properties.state);
    },
  });

  // ------------------------------------------------------------------ list helpers (settlement feed, bet tape, moments)
  function emptyList(ol, text) { d3.select(ol).selectAll('li').data([text], (d) => d).join('li').attr('class', 'wf-feed-empty').text((d) => d); }
  function feedList(ol, items, render) {
    d3.select(ol).selectAll('li').data(items, (d) => d.key).join((en) => {
      const li = en.append('li');
      li.append('span').attr('class', 'wf-feed-t');
      li.append('span').attr('class', 'wf-chip');
      li.append('span').attr('class', 'wf-feed-l');
      li.append('span').attr('class', 'wf-feed-k');
      return li;
    }).each(function (d) { render(d3.select(this), d); });
  }
  const activate = (sel, fn) => sel.on('click', (ev, d) => fn(d)).on('keydown', (ev, d) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fn(d); } });

  dash.draw('feed', (ol) => {
    if (!ok('races')) { emptyList(ol, stat('races') === 'error' ? 'Failed to load races.' : 'Loading…'); return; }
    const t = WF.t;
    const items = RX().calls.filter((r) => r.called_ts <= t).map((r) => ({key: r.race_id, ts: r.called_ts, kind: r.office, label: r.label, winner: r.winner, state: r.state}));
    for (const m of rowsOf('milestones')) if (m.settled_ts && m.settled_ts <= t) items.push({key: m.event, ts: m.settled_ts, kind: 'Control', label: `${m.chamber} control`, winner: m.winner, state: null});
    items.sort((a, b) => b.ts - a.ts || (a.kind === 'Control' ? -1 : 1));
    const top = items.slice(0, 60);
    if (!top.length) { emptyList(ol, 'No race settled yet at the cursor time. Drag the timeline forward.'); return; }
    feedList(ol, top, (li, d) => {
      li.attr('class', `wf-feed-i${d.kind === 'Control' ? ' is-ctrl' : ''}${d.ts > t - 1800 ? ' is-new' : ''}`).attr('tabindex', d.state ? 0 : null);
      li.select('.wf-feed-t').text(when(d.ts));
      li.select('.wf-chip').attr('class', `wf-chip wf-chip-${(d.winner || 'i').toLowerCase()}`).text(d.winner || '?');
      li.select('.wf-feed-l').text(d.label);
      li.select('.wf-feed-k').text(d.kind);
    });
    activate(d3.select(ol).selectAll('li.wf-feed-i'), (d) => { if (d.state) { pick(d.state, {race: false}); pickRace(d.key); } });
  });

  // ------------------------------------------------------------------ state dossier
  dash.draw('st-name', (el) => { el.textContent = WF.state ? (NAMES().get(WF.state) || WF.state) : '—'; });
  dash.draw('st-races', (ul) => {
    const sel = d3.select(ul);
    if (!ok('races') || !WF.state) { sel.selectAll('li').data(['—'], (d) => d).join('li').text((d) => d); return; }
    const t = WF.t, list = RX().byState.get(WF.state) || [];
    const statewide = list.filter((r) => r.office !== 'House').sort((a, b) => (a.office === b.office ? a.special - b.special : a.office === 'Senate' ? -1 : 1));
    const h = houseAt(WF.state, t);
    const items = statewide.map((r) => ({key: r.race_id, r})).concat(h.n ? [{key: 'house', h}] : []);
    if (!items.length) { sel.selectAll('li').data(['No 2026 race in the data.'], (d) => d).join('li').text((d) => d); return; }
    sel.selectAll('li').data(items, (d) => d.key).join('li').each(function (d) {
      const li = d3.select(this);
      li.selectAll('*').remove();
      if (d.h) {
        const v = li.append('div').attr('class', 'wf-race-btn').style('cursor', 'default');
        v.append('span').attr('class', 'wf-race-l').text('House');
        v.append('span').attr('class', 'wf-race-v').text(`${d.h.n} seats · D ${d.h.d} · R ${d.h.r}${d.h.o ? ` · other ${d.h.o}` : ''} settled · ${d.h.open} open`);
        return;
      }
      const r = d.r, x = pDem(r, t);
      const b = li.append('button').attr('type', 'button').attr('class', `wf-race-btn${r.race_id === WF.race ? ' is-on' : ''}`)
        .attr('aria-pressed', String(r.race_id === WF.race)).on('click', () => pickRace(r.race_id));
      b.append('span').attr('class', 'wf-race-l').text(r.office + (r.special ? ' (special)' : ''));
      const v = b.append('span').attr('class', 'wf-race-v');
      if (x && x.settled) {
        v.append('span').attr('class', `wf-chip wf-chip-${r.winner.toLowerCase()}`).text(r.winner);
        v.append('span').text(`settled ${when(r.called_ts)}`);
      } else if (x && x.closed) {
        v.append('span').text(`trading closed ${when(x.row.t)}, not settled yet`);
      } else if (x && x.gap) {
        v.append('span').text(`no two-sided quote at this time (since ${when(x.row.t)})`);
      } else if (x) {
        v.append('span').attr('class', 'wf-pbar').append('span').style('width', `${x.p * 100}%`);
        v.append('span').text(`P(D) ${pct1(x.p)} · quoted mid`);
      } else {
        v.append('span').text('no price at this time');
      }
      b.append('span').attr('class', 'wf-race-vol').text(`${fmtInt(r.volume)} contracts traded`);
    });
  });

  function spark(el, cfg) {
    const W = Math.max(200, Math.floor(el.clientWidth || 300)), H = 74, ml = 34, mr = 8, mt = 6, mb = 16;
    const box = d3.select(el);
    let svg = box.select('svg');
    if (svg.empty()) { box.selectAll('*').remove(); svg = box.append('svg').attr('role', 'img'); }
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('aria-label', cfg.aria);
    svg.selectAll('*').remove();
    const x = d3.scaleLinear().domain(cfg.xd).range([ml, W - mr]);
    const y = d3.scaleLinear().domain(cfg.yd).range([H - mb, mt]);
    for (const v of cfg.yticks) {
      svg.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y(v)).attr('y2', y(v)).style('stroke', v === cfg.ref ? '#3a4a5e' : '#152030').style('stroke-dasharray', v === cfg.ref ? '3 3' : null);
      svg.append('text').attr('x', ml - 4).attr('y', y(v) + 3).attr('text-anchor', 'end').text(cfg.yfmt(v));
    }
    return {svg, x, y, W, H, ml, mr, mt, mb};
  }
  const sparkMsg = (el, text) => { d3.select(el).selectAll('*').remove(); d3.select(el).append('p').attr('class', 'wf-st-line wf-dim').text(text); };
  const cursorRule = (g, t) => { if (t >= g.x.domain()[0] && t <= g.x.domain()[1]) g.svg.append('line').attr('x1', g.x(t)).attr('x2', g.x(t)).attr('y1', g.mt).attr('y2', g.H - g.mb).style('stroke', C.amber).style('stroke-width', 1.5); };

  dash.draw('st-spark', (el) => {
    const r = WF.state && ok('races') ? primaryRace(WF.state) : null;
    const s = r && ok('race_odds') ? ODDS().get(r.race_id) : null;
    if (!s || !s.length) { sparkMsg(el, r ? 'No hourly prices for this race.' : 'No statewide race here.'); return; }
    const [a, b] = WF.range;
    const prev = lastAt(s, a);
    const pts = (prev ? [{...prev, t: a}] : []).concat(s.filter((d) => d.t > a && d.t <= b));
    if (!pts.length) { sparkMsg(el, 'No prices in this window.'); return; }
    if (pts[pts.length - 1].t < b) pts.push({...pts[pts.length - 1], t: b});   // rows are change-only: the last one holds to the window end
    const g = spark(el, {xd: [a, b], yd: [0, 1], yticks: [0, 0.5, 1], ref: 0.5, yfmt: (v) => `${v * 100}%`, aria: `${r.label}: chance Democrats win, over the time window`});
    const has = (d) => d.p_dem != null;   // null = no two-sided quote: drawn as a gap
    const area = d3.area().defined(has).x((d) => g.x(d.t)).y0(g.y(0.5)).y1((d) => g.y(d.p_dem)).curve(d3.curveStepAfter);
    const id = `wfclip${Math.random().toString(36).slice(2, 8)}`;
    const defs = g.svg.append('defs');
    defs.append('clipPath').attr('id', `${id}d`).append('rect').attr('x', 0).attr('y', 0).attr('width', g.W).attr('height', g.y(0.5));
    defs.append('clipPath').attr('id', `${id}r`).append('rect').attr('x', 0).attr('y', g.y(0.5)).attr('width', g.W).attr('height', g.H);
    g.svg.append('path').datum(pts).attr('d', area).attr('clip-path', `url(#${id}d)`).style('fill', C.dem).style('opacity', 0.35);
    g.svg.append('path').datum(pts).attr('d', area).attr('clip-path', `url(#${id}r)`).style('fill', C.rep).style('opacity', 0.35);
    g.svg.append('path').datum(pts).attr('d', d3.line().defined(has).x((d) => g.x(d.t)).y((d) => g.y(d.p_dem)).curve(d3.curveStepAfter)).style('fill', 'none').style('stroke', C.fg).style('stroke-width', 1.4);
    cursorRule(g, WF.t);
    if (r.called_ts && r.called_ts >= a && r.called_ts <= b) g.svg.append('circle').attr('cx', g.x(r.called_ts)).attr('cy', g.y(r.winner === 'D' ? 1 : 0)).attr('r', 3.5).style('fill', r.winner === 'D' ? C.dem : C.rep);
    g.svg.append('text').attr('x', g.ml).attr('y', g.H - 3).text(`${r.label} · quoted mid`);
    g.svg.append('text').attr('x', g.W - g.mr).attr('y', g.H - 3).attr('text-anchor', 'end').text(`${F.md.format(D(a))} – ${F.md.format(D(b))}`);
  });

  dash.draw('st-bets', (el) => {
    if (!WF.state) { el.textContent = '—'; return; }
    if (!ok('bets_state')) { el.textContent = stat('bets_state') === 'error' ? 'Bet data is not available.' : 'Loading…'; return; }
    const s = BST().byState.get(WF.state) || [];
    const h = Math.floor(WF.t / 3600) * 3600, row = BST().m.get(`${WF.state}|${h}`);
    const tot = sumBetween(s, RANGES.campaign[0], h, (r) => r.usd);   // completed hours only
    const big = ok('big_bets') && ok('races') ? BIG().filter((b) => b.t <= WF.t && (raceInfo(b.race_id) || {}).state === WF.state).reduce((x, y) => (!x || y.usd > x.usd ? y : x), null) : null;
    const br = big && raceInfo(big.race_id);
    el.textContent = `${row ? usd(row.usd) : '$0'} in ${fullHour(h)} (per-state bets are hourly, so this includes bets after the cursor) · ${usd(tot)} from Oct 4 to ${F.time.format(D(h))}${big ? ` · largest so far: ${usd(big.usd)} backing ${big.backs} in ${br.label} at ${cents(big.price)}` : ''}`;
  });
  dash.draw('st-bets-spark', (el) => {
    if (!WF.state || !ok('bets_state')) { d3.select(el).selectAll('*').remove(); return; }
    const s = BST().byState.get(WF.state) || [];
    const [a, b] = WF.range;
    const nb = Math.max(12, Math.min(160, Math.round((b - a) / 3600)));
    const bins = binSum(s, a, b, nb, (r) => r.usd, 3600), mx = d3.max(bins) || 1;
    const g = spark(el, {xd: [a, b], yd: [0, mx], yticks: [0, mx], ref: null, yfmt: (v) => (v ? usd(v) : '0'), aria: `Dollars bet per hour on ${WF.state}'s races over the time window`});
    const bw = (g.W - g.ml - g.mr) / nb;
    bins.forEach((v, k) => { if (v) g.svg.append('rect').attr('x', g.ml + k * bw).attr('width', Math.max(1, bw - 1)).attr('y', g.y(v)).attr('height', g.y(0) - g.y(v)).style('fill', '#ffd166').style('opacity', 0.8); });
    cursorRule(g, WF.t);
    g.svg.append('text').attr('x', g.ml).attr('y', g.H - 3).text(`$ bet per ${nb === Math.round((b - a) / 3600) ? 'hour' : 'bin'}, ${F.md.format(D(a))} – ${F.md.format(D(b))}`);
  });
  dash.draw('st-social', (el) => {
    if (!WF.state) { el.textContent = '—'; return; }
    const parts = [];
    if (!ok('reddit_hourly')) parts.push(stat('reddit_hourly') === 'error' ? 'Reddit counts are not available yet.' : 'Loading Reddit…');
    else {
      const s = socialAt(WF.state, WF.t);
      if (!s || !s.sub) parts.push('No state subreddit tracked.');
      else if (!s.row) parts.push(`r/${s.sub}: no count for this hour.`);
      else parts.push(`r/${s.sub}: ${fmtInt(s.row.comments)} comments and ${fmtInt(s.row.posts)} posts in ${fullHour(s.row.t)} (state subreddit counts are hourly)${s.ratio != null ? `, ${s.ratio.toFixed(1)}× its usual hour (${fmtInt(Math.round(s.usual))})` : ''}.`);
    }
    if (ok('bluesky')) {
      const s = BSKY().byState.get(WF.state) || [];
      const n = sumDone(s, WF.t, 3600, (r) => r.posts, 600), likes = sumDone(s, WF.t, 3600, (r) => r.likes, 600), end = Math.floor(WF.t / 600) * 600;
      const inWin = s.length && WF.t >= s[0].t && WF.t <= s[s.length - 1].t + 3600;
      parts.push(inWin ? `Bluesky: ${n} top posts about the state's races in the hour to ${F.time.format(D(end))} (${fmtInt(likes)} likes).` : 'Bluesky sample covers Nov 3 11 AM – Nov 4 3 PM ET.');
    }
    el.textContent = parts.join(' ');
  });
  dash.draw('st-gas', (el) => {
    const g = WF.state && ok('gas') ? GAS().m.get(`${WF.state}|${etDate(WF.t)}`) : null;
    el.textContent = g ? `$${g.price.toFixed(3)}` : WF.state && ok('gas') ? 'No AAA market that day' : '—';
  });
  dash.draw('st-gas-spark', (el) => {
    if (!ok('gas') || !WF.state) { d3.select(el).selectAll('*').remove(); return; }
    const toT = (ds) => Date.parse(`${ds}T17:00:00Z`) / 1000;
    const us = GAS().byState.get('US') || [], st = GAS().byState.get(WF.state) || [];
    const all = us.concat(st);
    if (!all.length) { d3.select(el).selectAll('*').remove(); return; }
    const [lo, hi] = d3.extent(all, (d) => d.price);
    const pad = Math.max(0.05, (hi - lo) * 0.1);
    const yd = [Math.floor((lo - pad) * 10) / 10, Math.ceil((hi + pad) * 10) / 10];
    const g = spark(el, {xd: [toT('2026-10-01'), toT('2026-11-12')], yd, yticks: [yd[0], yd[1]], ref: null, yfmt: (v) => `$${v.toFixed(1)}`, aria: `AAA regular gas in ${WF.state} and the US, Oct 1 to Nov 12`});
    const line = d3.line().x((d) => g.x(toT(d.date))).y((d) => g.y(d.price));
    g.svg.append('path').datum(us).attr('d', line).style('fill', 'none').style('stroke', C.muted).style('stroke-width', 1.2).style('stroke-dasharray', '3 2');
    if (WF.state !== 'US') g.svg.append('path').datum(st).attr('d', line).style('fill', 'none').style('stroke', '#ffb347').style('stroke-width', 1.6);
    cursorRule(g, toT(etDate(WF.t)));
    g.svg.append('text').attr('x', g.ml).attr('y', g.H - 3).text(`${WF.state} solid · US dashed`);
  });
  dash.draw('st-rain', (el) => {
    const w = WF.state && ok('weather_state') ? WX().get(`${WF.state}|${etDate(WF.t)}`) : null;
    if (!w) { el.textContent = WF.state && ok('weather_state') ? `No station data for ${F.md.format(D(WF.t))} (weather covers Oct 4 – Nov 5).` : '—'; return; }
    el.textContent = `${F.md.format(D(WF.t))}: ${w.prcp_mm.toFixed(2)} mm average rain · ${Math.round(w.wet_share * 100)}% of ${w.stations} stations had 2.5 mm or more${w.tmax_c != null ? ` · average high ${w.tmax_c.toFixed(1)} °C` : ''}`;
  });
  dash.draw('st-turnout', (el) => {
    const x = WF.state && ok('turnout_races') && ok('turnout_daily') ? turnoutAt(WF.state, WF.t) : null;
    if (!x) { el.textContent = WF.state ? 'No statewide turnout market here.' : '—'; return; }
    const r = x.race;
    const head = x.row
      ? `${r.office} turnout: the market puts 50/50 at ${fmtInt(x.row.implied_votes)} votes${x.row.flag ? ` (${x.row.flag} its ladder)` : ''} as of ${F.md.format(D(x.row.t))} 6 PM`
      : `${r.office} turnout market: not trading yet at the cursor`;
    const base = r.baseline_votes ? ` · ${r.baseline_year} midterm Senate total ${fmtInt(r.baseline_votes)}${x.ratio != null ? ` (${signed(x.ratio - 1)})` : ''}` : ' · no comparison year';
    const meta = ` · ${r.strikes} strikes from ${fmtInt(r.strike_min)} to ${fmtInt(r.strike_max)} · ${fmtInt(r.volume)} contracts traded${r.spread_eve != null ? ` · ${Math.round(r.spread_eve * 100)}¢ average spread on election eve` : ''}${r.settled_bucket ? ` · settled: ${r.settled_bucket}` : ''}`;
    el.textContent = head + base + meta;
  });

  // ------------------------------------------------------------------ market card, laid out the way Kalshi shows a market
  const OUT_COLORS = ['#b48cff', '#46d39a', '#ffb347', '#36c5d6', '#ff6bcb'];
  const outColor = (o, i) => (o.party === 'D' ? C.dem : o.party === 'R' ? C.rep : OUT_COLORS[i % OUT_COLORS.length]);
  dash.draw('race-select', (sel) => {
    if (!ok('races')) return;
    if (!sel.options.length) {
      const add = (parent, r) => { const o = document.createElement('option'); o.value = r.race_id; o.textContent = `${r.label}${r.office === 'House' ? ' (House)' : ''}`; parent.append(o); };
      const g0 = document.createElement('optgroup'); g0.label = 'Chamber control'; g0.dataset.ctrl = '1';
      ['CONTROLS-2026', 'CONTROLH-2026'].forEach((id) => add(g0, raceInfo(id)));
      sel.append(g0);
      for (const office of ['Senate', 'Governor', 'House']) {
        const g = document.createElement('optgroup'); g.label = `${office} · by volume`;
        rowsOf('races').filter((r) => r.office === office).sort((a, b) => b.volume - a.volume).forEach((r) => add(g, r));
        sel.append(g);
      }
    }
    if (ok('markets_index') && !sel.querySelector('optgroup[data-other]')) {
      const g0 = sel.querySelector('optgroup[data-ctrl]');
      for (const m of rowsOf('markets_index').filter((x) => x.cat === 'midterms')) {
        const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; if (g0) g0.append(o);
      }
      for (const [cat, , , long] of CATS.filter(([c]) => c !== 'midterms')) {
        const list = rowsOf('markets_index').filter((m) => m.cat === cat);
        if (!list.length) continue;
        const g = document.createElement('optgroup'); g.label = `Kalshi · ${long} · most traded`; g.dataset.other = cat;
        list.sort((a, b) => b.night_usd - a.night_usd || b.volume - a.volume).forEach((m) => {
          const o = document.createElement('option'); o.value = m.id;
          o.textContent = `${m.label.length > 60 ? m.label.slice(0, 59) + '…' : m.label}${m.sub && !m.label.includes(m.sub) ? ` (${m.sub})` : ''}`;
          g.append(o);
        });
        sel.append(g);
      }
    }
    sel.value = WF.race;
  });
  function raceData(id) {
    const key = `race:${id}`;
    if (stat(key) === 'idle') {
      // races settled before the card's trade data starts (Oct 4) have no file: don't request one
      const ix = dash.data('night_races');
      if (ix.status === 'idle' || ix.status === 'loading') return {status: 'loading', data: null, raw: null};
      const k = marks(id);
      if (k.settle && k.settle < RANGES.campaign[0]) return {status: 'error', data: null, raw: null, skipped: true};
      dash.load(key, raceUrl(id));
    }
    return dash.data(key);
  }
  function dayData(id, day) {
    const key = `day:${id}:${day}`;
    const url = `data/trades/${encodeURIComponent(id)}/${day}.json`;
    if (stat(key) === 'idle') dash.load(key, url);
    const d = dash.data(key);
    if (d.status === 'error') failedDays.set(key, url); else failedDays.delete(key);
    return d;
  }
  // px rows are bins [t, t + r): the last trade in the bin (midterm races; 1 min on election night, 10 min otherwise) or, for
  // the other indexed events, an hourly bid/ask midpoint (else last trade). A bin's price is only known once the bin has
  // ENDED, so each series point is stamped at t + r; the volume bars keep the bin start and length.
  // ponytail: hourly rows are assumed to start at their stamp; if they are candle ENDS, the card is one hour late, never early
  const MKT = (id) => memo(`mkt:${id}`, [`race:${id}`], () => {
    const raw = dash.data(`race:${id}`).raw || {};
    const hourly = /hourly prices/.test((raw.meta || {}).inputs || '');
    const outs = raw.outcomes || [], ser = outs.map(() => []), all = [];
    for (const [t, i, p, n] of raw.px || []) {
      if (!ser[i]) continue;
      const r = t >= N0 && t < N1 ? 60 : hourly ? 3600 : 600;
      ser[i].push({t: t + r, p, n}); all.push({t, r, n});
    }
    ser.forEach((s) => s.sort((a, b) => a.t - b.t));
    return {outs, ser, raw, hourly, all: all.sort((a, b) => a.t - b.t)};
  });
  const priceWord = (mk) => (mk && mk.hourly ? 'price' : 'last trade');
  const outSettle = (o, r) => (o.result === 'yes' || o.result === 'no') && o.settled_ts ? {t: o.settled_ts, p: o.result === 'yes' ? 1 : 0}
    : r && r.office !== 'Market' && r.winner && r.called_ts ? {t: r.called_ts, p: o.party === r.winner ? 1 : 0} : null;
  function chanceAt(mk, i, t, r) {
    const o = mk.outs[i], st = outSettle(o, r);
    if (st && t >= st.t) return {p: st.p, settled: true};
    const row = lastAt(mk.ser[i], t);
    return row ? {p: row.p, settled: false} : null;
  }
  const mktState = () => {
    const id = WF.race, r = raceInfo(id), ds = raceData(id);
    return {id, r, ds, mk: ds.status === 'ok' ? MKT(id) : null};
  };
  const notReady = (el, s) => { el.textContent = s.ds.status === 'error' ? emptyMsg(s) : 'Loading…'; };

  dash.draw('mkt-vol', (el) => {
    const r = raceInfo(WF.race);
    if (!r) { el.textContent = ''; return; }
    const parts = [];
    if (r.office === 'Market') {
      if (r.night_usd) parts.push(`${usd(r.night_usd)} bet on election night`);
      if (r.volume) parts.push(`${fmtN(r.volume)} contracts all-time`);
      if (r.called_ts && WF.t >= r.called_ts) parts.push(`Settled${r.winner ? `: ${r.winner}` : ''}, ${when(r.called_ts)}`);
      else parts.push('Open at the cursor');
      el.textContent = parts.join(' · '); return;
    }
    if (r.volume) parts.push(`${usd(r.volume)} vol`);
    parts.push(statusLine(WF.race, WF.t));
    el.textContent = parts.join(' · ');
  });
  dash.draw('mkt-th', (el) => { const s = mktState(); el.textContent = s.mk && s.mk.hourly ? 'Price' : 'Last trade'; });
  dash.draw('mkt-chart-hint', (el) => {
    const s = mktState();
    el.textContent = `${s.mk && s.mk.hourly ? 'Chance = hourly bid/ask midpoint, else last trade (per minute on election night)' : 'Chance = last traded YES price'} · the amber line is the cursor`;
  });
  dash.draw('mkt-q', (el) => {
    const s = mktState();
    el.textContent = (s.mk && s.mk.raw.question) || (s.r ? s.r.label : '—');
  });
  dash.draw('mkt-head', (el) => {
    clear(el);
    const s = mktState();
    if (!s.mk) {
      notReady(el, s);
      if (s.ds.error && !/HTTP 404/.test(s.ds.error)) { const b = document.createElement('button'); b.type = 'button'; b.className = 'wf-btn'; b.textContent = 'Retry';
        b.addEventListener('click', () => dash.load(`race:${s.id}`, raceUrl(s.id))); el.append(' ', b); }
      return;
    }
    const {mk, r} = s, a = WF.range[0];
    const cur = mk.outs.map((o, i) => ({o, i, c: chanceAt(mk, i, WF.t, r), s0: chanceAt(mk, i, Math.max(a, RANGES.campaign[0]), r)}))
      .sort((p, q) => (q.c ? q.c.p : -1) - (p.c ? p.c.p : -1));
    const lead = cur[0];
    if (lead && lead.c) {
      const box = document.createElement('div'); box.className = 'wf-mkt-lead';
      const v = document.createElement('div'); v.className = 'wf-mkt-lead-v';
      v.textContent = `${Math.round(lead.c.p * 100)}%`;
      const small = document.createElement('small'); small.textContent = lead.c.settled ? 'settled' : priceWord(mk); v.append(small);
      if (lead.s0 && !lead.c.settled) {
        const d = Math.round((lead.c.p - lead.s0.p) * 100);
        if (d) { const ch = document.createElement('span'); ch.className = `wf-chg ${d > 0 ? 'up' : 'down'}`; ch.textContent = `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}`; ch.title = 'Change since the start of the chart window, in points'; v.append(ch); }
      }
      const l = document.createElement('div'); l.className = 'wf-mkt-lead-l'; l.textContent = `${lead.o.label} · at ${F.time.format(D(WF.t))} ET, ${F.md.format(D(WF.t))}`;
      box.append(v, l); el.append(box);
    }
    const keys = document.createElement('div'); keys.className = 'wf-mkt-keys';
    cur.forEach(({o, i, c}) => {
      const k = document.createElement('span'), dot = document.createElement('i'), b = document.createElement('b');
      dot.style.background = outColor(o, i); b.textContent = c ? `${Math.round(c.p * 100)}%` : '—';
      k.append(dot, document.createTextNode(o.label), b); keys.append(k);
    });
    el.append(keys);
    const qm = r && r.office !== 'Market' ? quotedMid(WF.race, WF.t) : null, note = document.createElement('p');
    note.className = 'wf-hint wf-mkt-pricenote';
    note.textContent = (mk.hourly
      ? 'Percentages are Kalshi prices for the last full hour before the cursor: the hourly bid/ask midpoint, else the last trade (per minute on election night).'
      : 'Percentages are last trade prices: the last trade in the last full minute before the cursor on election night, in the last full 10 minutes otherwise.')
      + (!qm ? '' : qm.none ? ' Quoted midpoint: no two-sided quote yet tonight.'
        : qm.one ? ` Quoted midpoint: none; the book was one-sided at ${F.time.format(D(qm.t))} (bid ${(qm.bid * 100).toFixed(1)}¢ / ask ${(qm.ask * 100).toFixed(1)}¢).`
        : qm.closed ? ` Quoted midpoint: none after trading closed (last was ${cents((qm.bid + qm.ask) / 2)}, ${F.time.format(D(qm.t))}).`
          : ` Quoted midpoint, Democratic contract: ${((qm.bid + qm.ask) * 50).toFixed(1)}¢ (bid ${(qm.bid * 100).toFixed(1)}¢ / ask ${(qm.ask * 100).toFixed(1)}¢, observed ${F.time.format(D(qm.t))}, ${Math.round((WF.t - qm.t) / 60)} min before the cursor).`);
    el.append(note);
    const k = marks(WF.race), x = nightOf(WF.race);
    if (x && (x.ev || x.n)) {
      const go = document.createElement('button'); go.type = 'button'; go.className = 'wf-btn';
      const inNight = WF.t >= RANGES.night[0] && WF.t <= RANGES.night[1];
      const target = inNight ? WF.t : Math.max(RANGES.night[0], Math.min(RANGES.night[1], (k.close || RANGES.night[1]) - 900));
      const why = k.close && k.close - 900 === target ? '15 min before trading closed' : k.close && k.close < RANGES.night[0] ? 'start of the election-night window; trading had already closed'
        : 'near the end of the election-night window; trading was still open';
      go.textContent = inNight ? 'Show its election-night quotes, trades and streams' : `Election night: jump to ${F.time.format(D(target))} ET (${why}) and show quotes, trades and streams`;
      go.addEventListener('click', () => {
        if (WF.playing) stop();
        if (WF.rangeKey !== 'night') { WF.rangeKey = 'night'; WF.range = RANGES.night.slice(); syncUI(); }
        setT(target); redraw(['st-spark']);
        document.querySelector('.wf-night').scrollIntoView({behavior: 'smooth', block: 'start'});
      });
      el.append(go);
    }
  });

  dash.draw('mkt-chart', {
    mount(el) {
      const box = d3.select(el);
      const msg = box.append('p').attr('class', 'wf-msg');
      const svg = box.append('svg').attr('role', 'img');
      const tip = box.append('div').attr('class', 'wf-tip').attr('hidden', '');
      return {msg, svg, tip, tipB: tip.append('b'), tipS: tip.append('span')};
    },
    update(el, m) {
      const s = mktState();
      if (!s.mk) { m.svg.attr('hidden', ''); m.msg.attr('hidden', null).text(s.ds.status === 'error' ? emptyMsg(s) : 'Loading trades…'); return; }
      m.msg.attr('hidden', ''); m.svg.attr('hidden', null);
      const {mk, r} = s, [a, b] = WF.range;
      const W = Math.max(280, Math.floor(el.clientWidth || 700)), ml = 6, mr = 44, PT = 10, PH = 214, VB = 236, VH = 34, H = VB + VH + 24;
      const x = d3.scaleLinear().domain([a, b]).range([ml, W - mr]);
      const y = d3.scaleLinear().domain([0, 1]).range([PH, PT]);
      const svg = m.svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H)
        .attr('aria-label', `${r ? r.label : s.id}: chance of each outcome over the chart window, with contracts traded`);
      svg.selectAll('*').remove();
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        svg.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y(v)).attr('y2', y(v)).style('stroke', '#1c2836').style('stroke-dasharray', '2 4');
        svg.append('text').attr('x', W - mr + 6).attr('y', y(v) + 3.5).text(`${v * 100}%`);
      }
      const settledAt = r && r.winner && r.called_ts ? r.called_ts : null;
      const lines = mk.outs.map((o, i) => {
        const ser = mk.ser[i], prev = lastAt(ser, a);
        const st = outSettle(o, r);
        const pts = (prev && (!st || prev.t < st.t) ? [{t: a, p: prev.p}] : []).concat(ser.filter((d) => d.t > a && d.t <= b && (!st || d.t < st.t)));
        if (st && st.t > a && st.t <= b) pts.push({t: st.t, p: st.p});
        else if (st && st.t <= a) pts.push({t: a, p: st.p});
        if (pts.length && pts[pts.length - 1].t < b) pts.push({t: b, p: pts[pts.length - 1].p});
        return {o, i, pts};
      });
      if (!mk.all.some((d) => d.t >= a && d.t <= b)) svg.append('text').attr('x', ml + 6).attr('y', PT + 14).style('fill', C.muted)
        .text(mk.hourly ? `No prices between ${F.md.format(D(a))} and ${F.md.format(D(b))}; lines carry the last price before this view.`
          : `No trades between ${F.md.format(D(a))} and ${F.md.format(D(b))}; lines carry the last trade before this view.`);
      for (const ln of lines.slice().reverse()) {
        if (!ln.pts.length) continue;
        svg.append('path').datum(ln.pts).attr('d', d3.line().x((d) => x(d.t)).y((d) => y(d.p)).curve(d3.curveStepAfter))
          .style('fill', 'none').style('stroke', outColor(ln.o, ln.i)).style('stroke-width', 2).style('stroke-linejoin', 'round');
      }
      // contracts traded, all outcomes, faint bars under the chart
      const nb = Math.max(30, Math.min(200, Math.floor((W - ml - mr) / 5))), bw = (b - a) / nb;
      const vols = binSum(mk.all, a, b, nb, (d) => d.n, 600), vmax = d3.max(vols) || 1;
      const bwPx = Math.max(1, (W - ml - mr) / nb - 1);
      for (let k = 0; k < nb; k++) if (vols[k]) svg.append('rect').attr('x', x(a + k * bw)).attr('width', bwPx).attr('y', VB + VH - (vols[k] / vmax) * VH).attr('height', (vols[k] / vmax) * VH).style('fill', '#3a4a5e');
      const binLabel = bw >= 3600 ? `${Math.round(bw / 3600)} h` : `${Math.max(1, Math.round(bw / 60))} min`;
      svg.append('text').attr('x', W - mr + 6).attr('y', VB + 9).text(fmtN(vmax));
      svg.append('text').attr('x', ml).attr('y', VB + 9).text(`contracts per ${binLabel}`);
      const {out, step} = ticks(a, b, W - ml - mr);
      for (const t of out) svg.append('text').attr('x', x(t)).attr('y', VB + VH + 16).attr('text-anchor', x(t) < ml + 20 ? 'start' : 'middle').text(tickLabel(t, step));
      if (settledAt && settledAt >= a && settledAt <= b) {
        svg.append('line').attr('x1', x(settledAt)).attr('x2', x(settledAt)).attr('y1', PT).attr('y2', VB + VH).style('stroke', '#5d6d82').style('stroke-dasharray', '3 3');
        svg.append('text').attr('x', x(settledAt) + 4).attr('y', (PT + PH) / 2).text('settled');
      }
      // cursor, with each outcome's chance labelled on the right of its dot
      if (WF.t >= a && WF.t <= b) {
        const cx = x(WF.t);
        svg.append('line').attr('x1', cx).attr('x2', cx).attr('y1', PT).attr('y2', VB + VH).style('stroke', C.amber).style('stroke-width', 1.5);
        const marks = mk.outs.map((o, i) => ({o, i, c: chanceAt(mk, i, WF.t, r)})).filter((d) => d.c).sort((p, q) => q.c.p - p.c.p);
        let lastY = -Infinity;
        for (const d of marks) {
          const cy = y(d.c.p), ly = Math.max(cy, lastY + 14); lastY = ly;
          svg.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 4).style('fill', outColor(d.o, d.i)).style('stroke', '#0e151e').style('stroke-width', 2);
          const right = cx < W - mr - 120;
          svg.append('text').attr('x', right ? cx + 8 : cx - 8).attr('y', ly + 4).attr('text-anchor', right ? 'start' : 'end')
            .style('fill', outColor(d.o, d.i)).style('font', '600 11.5px ui-monospace, monospace').style('paint-order', 'stroke').style('stroke', '#0e151e').style('stroke-width', 4).style('stroke-linejoin', 'round').text(`${d.o.label.length > 22 ? d.o.label.slice(0, 21) + '…' : d.o.label} ${Math.round(d.c.p * 100)}%`);
        }
      }
      const hover = svg.append('line').style('stroke', C.fg).style('stroke-opacity', 0.35).style('stroke-dasharray', '2 3').style('display', 'none').style('pointer-events', 'none');
      svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - mr).attr('height', VB + VH).style('fill', 'transparent').style('cursor', 'crosshair')
        .on('pointermove', (ev) => {
          const [px, py] = d3.pointer(ev, el), t = x.invert(d3.pointer(ev, svg.node())[0]);
          hover.style('display', null).attr('x1', x(t)).attr('x2', x(t)).attr('y1', PT).attr('y2', VB + VH);
          m.tipB.text(`${F.day.format(D(t))} · ${F.time.format(D(t))} · ${priceWord(mk)}`);
          m.tipS.text(mk.outs.map((o, i) => { const c = chanceAt(mk, i, t, r); return `${o.label} ${c ? Math.round(c.p * 100) + '%' : '—'}`; }).join(' · '));
          m.tip.attr('hidden', null).style('left', `${Math.max(0, Math.min(px + 12, el.clientWidth - 270))}px`).style('top', `${Math.max(0, py - 50)}px`);
        })
        .on('pointerleave', () => { hover.style('display', 'none'); m.tip.attr('hidden', ''); })
        .on('click', (ev) => { if (WF.playing) stop(); WF.moment = null; setT(x.invert(d3.pointer(ev, svg.node())[0])); });
    },
  });

  const POLLS = () => memo('polls', ['polls'], (rows) => group(rows, (r) => r.race_id, 't'));
  dash.draw('mkt-polls', (el) => {
    clear(el);
    const r = raceInfo(WF.race);
    if (!r || r.office === 'Market' || r.office === 'Control' || !ok('polls')) return;
    const all = POLLS().get(WF.race) || [], upto = all.filter((p) => p.t <= WF.t);
    const mg = (v) => (Math.abs(v) < 0.05 ? 'Tied' : `${v > 0 ? 'D' : 'R'} +${Math.abs(v).toFixed(1)}`);
    const span = (cls, text) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; return s; };
    const h = document.createElement('p'); h.className = 'wf-mkt-polls-h';
    if (!all.length) { h.textContent = 'Polls: no public general-election poll for this race since Aug 1.'; el.append(h); return; }
    const last = upto.slice(-5), avg = last.length ? d3.mean(last, (p) => p.D - p.R) : null;
    h.textContent = upto.length ? `Polls · average of the latest ${last.length} up to the cursor: ${mg(avg)}` : `Polls · ${all.length} in this race, none before the cursor`;
    if (avg != null) h.classList.add(avg > 0 ? 'is-d' : avg < 0 ? 'is-r' : 'x');
    el.append(h);
    if (!upto.length) return;
    const ul = document.createElement('ul'); ul.className = 'wf-mkt-polls-l';
    const last2 = (n) => (n ? n.trim().split(/\s+/).pop() : '');
    for (const p of upto.slice(-8).reverse()) {
      const li = document.createElement('li'), m = p.D - p.R;
      const who = span(null, p.pollster); if (p.partisan) who.append(Object.assign(document.createElement('small'), {textContent: ` (${p.partisan})`}));
      const res = span(null, `${last2(p.D_name) || 'D'} ${p.D} – ${last2(p.R_name) || 'R'} ${p.R}`);
      if (p.sample && p.sample !== 'nan') res.append(Object.assign(document.createElement('small'), {textContent: ` · ${p.sample}`}));
      const mm = span(`wf-poll-m ${m > 0 ? 'is-d' : m < 0 ? 'is-r' : ''}`, mg(m));
      li.append(span('wf-poll-d', F.md.format(D(p.t))), who, res, mm);
      li.title = `${p.date}: ${p.pollster}${p.partisan ? ` (${p.partisan})` : ''}, ${p.D_name || 'D'} ${p.D}%, ${p.R_name || 'R'} ${p.R}% (${p.source})`;
      ul.append(li);
    }
    el.append(ul);
    const src = document.createElement('p'); src.className = 'wf-hint';
    src.textContent = `${upto.length} poll${upto.length === 1 ? '' : 's'} since Aug 1 · Wikipedia (CC BY-SA 4.0) and VoteHub (CC BY 4.0) · (D)/(R) = pollster working for a party`;
    el.append(src);
  });
  dash.draw('mkt-table', (tb) => {
    clear(tb);
    const s = mktState();
    const row = (cells) => { const tr = document.createElement('tr'); cells.forEach((c) => tr.append(c)); tb.append(tr); };
    const td = (text, cls) => { const e = document.createElement('td'); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    if (!s.mk) { const c = td(null); c.colSpan = 5; notReady(c, s); row([c]); return; }
    const {mk, r} = s;
    mk.outs.map((o, i) => ({o, i, c: chanceAt(mk, i, WF.t, r)})).sort((p, q) => (q.c ? q.c.p : -1) - (p.c ? p.c.p : -1)).forEach(({o, i, c}) => {
      const name = td(null), dot = document.createElement('i'); dot.style.background = outColor(o, i); name.append(dot, document.createTextNode(o.label));
      const chance = td(c ? `${Math.round(c.p * 100)}%` : '—', 'wf-mkt-chance');
      const yes = td(null), no = td(null), ys = document.createElement('span'), ns = document.createElement('span');
      if (c && c.settled) {
        ys.className = `wf-yes ${c.p ? 'wf-won' : 'wf-lost'}`; ys.textContent = c.p ? 'Won' : 'Lost';
        ns.className = `wf-no ${c.p ? 'wf-lost' : 'wf-won'}`; ns.textContent = c.p ? 'Lost' : 'Won';
      } else {
        ys.className = 'wf-yes'; ys.textContent = c ? `Yes ${cents(c.p)}` : 'Yes —';
        ns.className = 'wf-no'; ns.textContent = c ? `No ${cents(1 - c.p)}` : 'No —';
      }
      yes.append(ys); no.append(ns);
      const traded = mk.ser[i].reduce((acc, d) => acc + (d.t <= WF.t ? d.n : 0), 0);
      row([name, chance, yes, no, td(fmtN(traded))]);
    });
  });

  // ------------------------------------------------------------------ trades: every bet in the market, or the biggest bets
  const CATS = [['midterms', 'Midterms', '#f0b44c', 'Midterm races'], ['politics', 'Politics', '#b48cff', 'Other elections & politics'],
    ['sports', 'Sports', '#46d39a', 'Sports'], ['crypto', 'Crypto', '#ff9f43', 'Crypto'], ['parlays', 'Parlay', '#ff6bcb', 'Parlays (combos)'],
    ['stocks', 'Stocks', '#e2e8f0', 'Stock indexes'], ['finance', 'Finance', '#5fb3ff', 'Finance & economics'], ['weather', 'Weather', '#36c5d6', 'Weather & climate'],
    ['other', 'Other', '#6b7a8f', 'Everything else']];
  const CAT = Object.fromEntries(CATS.map(([g, label, col]) => [g, {label, col}]));
  const KCATS = () => memo('kcats', ['kalshi_cats'], (rows) => group(rows, (r) => r.g, 't'));
  const KBIG = () => memo('kbig', ['kalshi_big'], (b) => b.slice().sort((p, q) => p.t - q.t));
  dash.draw('tape-sub', (el) => {
    const r = raceInfo(WF.race);
    if (WF.tape === 'market' && WF.tapeNote) { el.textContent = WF.tapeNote; return; }
    el.textContent = WF.tape === 'market' ? `The latest 120 bets in ${r ? r.label : 'this market'} up to the cursor (from its last three trading days at most), newest first. One bet = one order; amber = $10K or more.`
      : WF.tape === 'mid' ? 'The largest midterm bets (priced 3–97¢) up to the cursor, newest first.'
        : 'The largest bets anywhere on Kalshi (priced 3–97¢) up to the cursor. Covers Nov 3 5 PM – Nov 4 11 AM ET.';
  });
  function tapeMarket(ol) {
    const s = mktState();
    WF.tapeNote = '';
    if (s.ds.status !== 'ok') { emptyList(ol, s.ds.status === 'error' ? emptyMsg(s) : 'Loading…'); return; }
    const days = (s.mk.raw.days || []).filter((d) => d <= etDate(WF.t));
    if (!days.length) { emptyList(ol, 'No bets in this market yet at the cursor time.'); return; }
    const out = [], skipped = [];
    for (let j = days.length - 1; j >= 0 && out.length < 120 && j >= days.length - 3; j--) {
      const dd = dayData(s.id, days[j]);
      if (dd.status === 'loading' || dd.status === 'idle') { if (!out.length) { emptyList(ol, 'Loading trades…'); return; } break; }
      if (dd.status !== 'ok') { skipped.push(days[j]); continue; }
      const rows = dd.data;
      for (let i = rows.length - 1; i >= 0 && out.length < 120; i--) if (rows[i][0] <= WF.t) out.push(rows[i]);
    }
    WF.tapeNote = skipped.length ? `Trades for ${skipped.join(', ')} did not load, so bets from those days are missing here. Click "This market" to retry.` : '';
    if (!out.length) { emptyList(ol, WF.tapeNote || 'No bets in this market yet at the cursor time.'); return; }
    feedList(ol, out.map((b) => ({key: `${b[0]}|${b[1]}|${b[2]}|${b[4]}|${b[5]}`, t: b[0], i: b[1], yes: b[2], price: b[3], n: b[4], usd: b[5]})), (li, d) => {
      const o = s.mk.outs[d.i] || {label: '?'};
      li.attr('class', `wf-feed-i wf-trade-i${d.usd >= 10000 ? ' is-big' : ''}`).attr('tabindex', null);
      li.select('.wf-feed-t').text(F.time.format(D(d.t)));
      li.select('.wf-chip').attr('class', `wf-chip ${d.yes ? 'wf-side-yes' : 'wf-side-no'}`).text(d.yes ? 'Yes' : 'No');
      li.select('.wf-feed-l').text(`${o.label} · ${fmtN(d.n)} @ ${cents(d.price)}`).attr('title', `${d.yes ? 'Bought Yes' : 'Bought No'} on ${o.label}: ${fmtInt(Math.round(d.n))} contracts at ${cents(d.price)}, ${when(d.t)}`);
      li.select('.wf-feed-k').attr('class', 'wf-feed-k wf-feed-usd').text(usd(d.usd));
    });
  }
  function tapeMid(ol) {
    if (!ok('big_bets')) { emptyList(ol, stat('big_bets') === 'error' ? 'Bet data is not available.' : 'Loading…'); return; }
    const t = WF.t, s = BIG(), out = [];
    for (let i = firstIdx(s, t + 1) - 1; i >= 0 && out.length < 80; i--) out.push(s[i]);
    if (!out.length) { emptyList(ol, 'No large bets yet at the cursor time.'); return; }
    feedList(ol, out.map((b) => ({...b, key: `${b.race_id}|${b.t}|${b.usd}`})), (li, d) => {
      const r = raceInfo(d.race_id);
      li.attr('class', `wf-feed-i${d.t > t - 1800 ? ' is-new' : ''}${d.race_id === WF.race ? ' is-sel' : ''}`).attr('tabindex', 0);
      li.select('.wf-feed-t').text(when(d.t));
      li.select('.wf-chip').attr('class', `wf-chip wf-chip-${d.backs.toLowerCase()}`).attr('style', null).text(d.backs === 'O' ? '·' : d.backs);
      li.select('.wf-feed-l').text(`${r ? r.label : d.race_id} · backs ${party(d.backs)} @ ${cents(d.price)}`);
      li.select('.wf-feed-k').attr('class', 'wf-feed-k wf-feed-usd').text(usd(d.usd));
    });
    activate(d3.select(ol).selectAll('li.wf-feed-i'), (d) => pickRace(d.race_id));
  }
  function tapeAll(ol) {
    if (!ok('kalshi_big')) { emptyList(ol, stat('kalshi_big') === 'error' ? 'Whole-exchange data is not available yet.' : 'Loading…'); return; }
    const t = WF.t, s = KBIG(), out = [];
    for (let i = firstIdx(s, t + 1) - 1; i >= 0 && out.length < 80; i--) out.push(s[i]);
    if (!out.length) { emptyList(ol, t < N0 ? 'Whole-exchange bets start Nov 3 at 5 PM ET. Move the cursor there.' : 'No large bets yet at the cursor time.'); return; }
    feedList(ol, out.map((b) => ({...b, key: `${b.ticker}|${b.t}|${b.usd}`})), (li, d) => {
      const c = CAT[d.g] || CAT.other;
      const open = d.race_id || (ok('markets_index') && MIDX().has(evOf(d.ticker)) ? evOf(d.ticker) : null);
      li.attr('class', `wf-feed-i${d.t > t - 600 ? ' is-new' : ''}${open ? ' is-link' : ''}`).attr('tabindex', open ? 0 : null).attr('title', open ? 'Open this market' : null);
      li.select('.wf-feed-t').text(F.time.format(D(d.t)));
      li.select('.wf-chip').attr('class', 'wf-chip').style('background', c.col).text(c.label);
      const r = d.race_id ? raceInfo(d.race_id) : null, sfx = d.ticker.split('-').pop();
      const what = r ? `${r.label} · ${d.outcome || ({D: 'Democratic', R: 'Republican'}[sfx] || sfx)}` : d.title ? `${d.title}${d.outcome && !d.title.includes(d.outcome) ? ` · ${d.outcome}` : ''}` : d.ticker;
      li.select('.wf-feed-l').text(`${d.side} @ ${cents(d.price)} · ${what}`).attr('title', `${d.side} at ${cents(d.price)}: ${what} (${d.ticker})`);
      li.select('.wf-feed-k').attr('class', 'wf-feed-k wf-feed-usd').text(usd(d.usd));
    });
    activate(d3.select(ol).selectAll('li.wf-feed-i'), (d) => {
      const id = d.race_id || (ok('markets_index') && MIDX().has(evOf(d.ticker)) ? evOf(d.ticker) : null);
      if (id) { WF.tape = 'market'; syncUI(); pickRace(id); }
    });
  }
  dash.draw('tape', (ol) => (WF.tape === 'market' ? tapeMarket(ol) : WF.tape === 'all' ? tapeAll(ol) : tapeMid(ol)));

  // ------------------------------------------------------------------ key moments
  const KIND = {control: 'Control', call: 'Settled', swing: 'Swing', bet: 'Big bet', social: 'Reddit surge', stocks: 'Stocks'};
  const periodOf = (t) => (t < N0 ? 'before' : t < N1 ? 'night' : 'after');
  const momPeriod = () => { if (WF.mperiod) return WF.mperiod; const c = currentMoment(); return periodOf(c ? c.t : WF.t); };
  function currentMoment() {
    const ms = MOMENTS();
    if (WF.moment) return ms.find((m) => m.id === WF.moment) || null;
    return lastAt(ms, WF.t);
  }
  dash.draw('moments', (ol) => {
    if (!ok('moments')) { emptyList(ol, stat('moments') === 'error' ? 'Key moments are not available.' : 'Loading…'); return; }
    const cur = currentMoment(), per = momPeriod();
    feedList(ol, MOMENTS().filter((m) => (m.period || periodOf(m.t)) === per).map((m) => ({...m, key: m.id})), (li, d) => {
      li.attr('class', `wf-feed-i wf-mom-i${cur && cur.id === d.id ? ' is-sel' : ''}${d.t > WF.t ? ' wf-dim' : ''}`).attr('tabindex', 0)
        .attr('aria-current', cur && cur.id === d.id ? 'true' : null);
      li.select('.wf-feed-t').text(per === 'night' ? F.time.format(D(d.t)) : F.md.format(D(d.t))).attr('title', when(d.t));
      li.select('.wf-chip').attr('class', 'wf-chip wf-chip-k').text(KIND[d.kind] || d.kind);
      li.select('.wf-feed-l').text(d.title).attr('title', d.title);
      li.select('.wf-feed-k').remove();
    });
    activate(d3.select(ol).selectAll('li.wf-feed-i'), (d) => { if (WF.playing) stop(); pickMoment(d); });
  });
  dash.draw('moment-tabs', (el) => {
    const per = ok('moments') ? momPeriod() : 'night';
    const n = (k) => (ok('moments') ? MOMENTS().filter((m) => (m.period || periodOf(m.t)) === k).length : 0);
    el.querySelectorAll('[data-mperiod]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mperiod === per));
      if (!b.dataset.label) b.dataset.label = b.textContent;
      b.textContent = ok('moments') ? `${b.dataset.label} · ${n(b.dataset.mperiod)}` : b.dataset.label;
    });
  });
  document.querySelectorAll('.wf [data-mperiod]').forEach((b) => b.addEventListener('click', () => { WF.mperiod = b.dataset.mperiod; redraw(['moments', 'moment-tabs']); }));
  function loadScript(src, id) {
    const old = document.getElementById(id);
    if (old) old.remove();
    const s = document.createElement('script');
    s.id = id; s.async = true; s.src = src; s.charset = 'utf-8';
    document.body.append(s);
  }
  function renderEmbeds(box, posts) {
    clear(box);
    for (const p of posts) {
      const card = document.createElement('div'); card.className = 'wf-embed';
      const bq = document.createElement('blockquote');
      const a = document.createElement('a'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      if (p.platform === 'bluesky') {
        bq.className = 'bluesky-embed';
        bq.setAttribute('data-bluesky-uri', p.uri);
        bq.setAttribute('data-bluesky-embed-color-mode', 'dark');
        a.textContent = `View this post on Bluesky (${when(p.t)}, ${fmtInt(p.likes)} likes)`;
      } else if (p.platform === 'x') {
        bq.className = 'twitter-tweet';
        bq.setAttribute('data-theme', 'dark');
        bq.setAttribute('data-dnt', 'true');
        a.textContent = `View this post on X (${when(p.t)}), shared in r/${p.sub}`;
      } else {
        bq.className = 'reddit-embed-bq';
        bq.setAttribute('data-embed-theme', 'dark');
        bq.setAttribute('data-embed-height', '360');
        a.textContent = `View this post on Reddit, r/${p.sub} (${when(p.t)})`;
      }
      bq.append(a); card.append(bq); box.append(card);
    }
    if (posts.some((p) => p.platform === 'bluesky')) {
      if (window.bluesky && typeof window.bluesky.scan === 'function') window.bluesky.scan();
      else loadScript('https://embed.bsky.app/static/embed.js', 'wf-bsky-embed');
    }
    if (posts.some((p) => p.platform === 'reddit')) loadScript('https://embed.reddit.com/widgets.js', 'wf-reddit-embed');
    if (posts.some((p) => p.platform === 'x')) {
      if (window.twttr && window.twttr.widgets && typeof window.twttr.widgets.load === 'function') window.twttr.widgets.load(box);
      else loadScript('https://platform.twitter.com/widgets.js', 'wf-x-embed');
    }
  }
  dash.draw('moment-detail', {
    mount(el) {
      const title = document.createElement('p'); title.className = 'wf-mom-title';
      const meta = document.createElement('p'); meta.className = 'wf-mom-meta';
      const actions = document.createElement('div'); actions.className = 'wf-mom-actions';
      const show = document.createElement('button'); show.type = 'button'; show.className = 'wf-btn wf-btn-solid';
      const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'wf-btn'; hide.textContent = 'Hide posts';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'wf-btn'; open.textContent = 'Open the market';
      actions.append(show, hide, open);
      const embeds = document.createElement('div'); embeds.className = 'wf-embeds';
      const note = document.createElement('p'); note.className = 'wf-embed-note';
      note.textContent = 'Posts load from Bluesky, Reddit and X when you choose to show them, and those sites may set cookies. Bluesky posts are from accounts with 25,000+ followers; Reddit posts have 50+ points; X posts are ones shared in those Reddit posts.';
      el.append(title, meta, actions, embeds, note);
      const m = {title, meta, show, hide, open, embeds, note, shownId: null};
      show.addEventListener('click', () => { WF.embedsOn = true; m.shownId = null; dash.draw('moment-detail'); });
      hide.addEventListener('click', () => { WF.embedsOn = false; m.shownId = null; clear(embeds); dash.draw('moment-detail'); });
      open.addEventListener('click', () => { const c = currentMoment(); if (c && c.race_id) { WF.tape = 'market'; syncUI(); pickRace(c.race_id); document.getElementById('wf-race-select').scrollIntoView({behavior: 'smooth', block: 'start'}); } });
      return m;
    },
    update(el, m) {
      const c = ok('moments') ? currentMoment() : null;
      if (!c) {
        m.title.textContent = ok('moments') ? 'No key moment yet at the cursor time.' : '—';
        m.meta.textContent = ''; m.show.hidden = m.hide.hidden = m.open.hidden = true; clear(m.embeds); m.shownId = null; return;
      }
      m.title.textContent = c.title;
      const n = c.posts.length, win = c.win || [c.t - 600, c.t + 1800];
      const by = [['bluesky', 'Bluesky'], ['reddit', 'Reddit'], ['x', 'X']].map(([k, l]) => [c.posts.filter((p) => p.platform === k).length, l]).filter(([k]) => k);
      m.meta.textContent = `${F.day.format(D(c.t))}, ${F.time.format(D(c.t))} ET · ${KIND[c.kind] || c.kind}${WF.moment ? '' : ' · latest moment before the cursor'}`
        + ` · ${n ? `${by.map(([k, l]) => `${k} ${l}`).join(', ')} post${n === 1 ? '' : 's'} from ${when(win[0])} to ${when(win[1])}` : 'no matching public posts found'}`;
      m.open.hidden = !c.race_id;
      m.show.hidden = !n || WF.embedsOn;
      m.show.textContent = `Show ${n} post${n === 1 ? '' : 's'}`;
      m.hide.hidden = !n || !WF.embedsOn;
      if (!WF.embedsOn || !n) { if (m.shownId) { clear(m.embeds); m.shownId = null; } return; }
      if (m.shownId !== c.id) { m.shownId = c.id; renderEmbeds(m.embeds, c.posts); }
    },
  });

  // ------------------------------------------------------------------ time lanes
  const AXIS = 22, TOP = 14;
  const LANES = [['ctrl', 34, 'Control P(D) · quoted mid'], ['settled', 34, 'Races settled'],
    ...CATS.map(([g, , col, long]) => [`cat:${g}`, 24, `Kalshi · ${long}`, col]),
    ['bets', 34, 'Midterm bets $/min · D ▲ R ▼'], ['big', 34, 'Big midterm bets'], ['streams', 34, 'Streams on air'], ['chat', 34, 'Live-chat msgs/min'],
    ['reddit', 34, 'Reddit comments/min'], ['bsky', 34, 'Bluesky top posts'], ['poly', 34, 'Polymarket comments'],
    ['stocks', 52, 'Stocks · S&P 500 · Nasdaq'], ['gas', 34, 'US gas · WTI']];
  const LY = {};
  let PLOT_H = 0;
  for (const [k, h] of LANES) { LY[k] = {y: TOP + PLOT_H, h}; PLOT_H += h; }
  dash.draw('lane-labels', (ul) => {
    if (ul.childElementCount) return;
    ul.style.paddingTop = `${TOP}px`;
    for (const [k, h, label, col] of LANES) {
      const li = document.createElement('li'); li.style.height = `${h}px`;
      if (col) { li.className = 'is-cat'; const i = document.createElement('i'); i.style.background = col; li.append(i); }
      li.append(document.createTextNode(label)); ul.append(li);
    }
  });

  dash.draw('lanes', {
    mount(el) {
      const box = d3.select(el);
      const svg = box.append('svg').attr('class', 'wf-lanes-svg').attr('role', 'img').attr('tabindex', 0)
        .attr('aria-label', 'Timeline lanes: chamber-control odds, race settlements, all Kalshi volume by category, midterm bets, streams, live chat, Reddit, Bluesky, Polymarket, gas and oil. Amber diamonds are key moments; the amber line is the cursor. Drag or use arrow keys to move it.');
      const base = svg.append('g'), marks = svg.append('g'), axis = svg.append('g').attr('class', 'wf-axis');
      const hover = svg.append('line').attr('class', 'wf-hover').style('display', 'none').style('pointer-events', 'none');
      const cursor = svg.append('g').attr('class', 'wf-cursor').style('pointer-events', 'none');
      cursor.append('line'); cursor.append('rect').attr('height', 15).attr('y', TOP + PLOT_H + 4); cursor.append('text').attr('y', TOP + PLOT_H + 15);
      const tip = box.append('div').attr('class', 'wf-tip').attr('hidden', '');
      const m = {box, svg, base, marks, axis, hover, cursor, tip, tipB: tip.append('b'), tipS: tip.append('span'), key: ''};
      let dragging = false;
      const tAt = (ev) => m.x.invert(d3.pointer(ev, svg.node())[0]);
      svg.on('pointerdown', (ev) => {
        if (ev.target.classList && ev.target.classList.contains('wf-mom-mark')) return;
        dragging = true; svg.node().setPointerCapture?.(ev.pointerId); if (WF.playing) stop(); WF.moment = null; setT(tAt(ev));
      })
        .on('pointerup pointercancel', () => { dragging = false; })
        .on('pointermove', (ev) => {
          if (!m.x) return;
          if (dragging) { setT(tAt(ev)); return; }
          const t = Math.round(tAt(ev) / 60) * 60, [px, py] = d3.pointer(ev, el);
          m.hover.style('display', null).attr('x1', m.x(t)).attr('x2', m.x(t));
          const sen = ok('control') ? lastAt(CTRL().get('Senate'), t) : null, hou = ok('control') ? lastAt(CTRL().get('House'), t) : null;
          const called = ok('races') ? RX().calls.filter((r) => r.called_ts <= t).length : 0;
          const kal = ok('kalshi_cats') ? binSum(rowsOf('kalshi_cats'), t, t + 60, 1, (r) => r.n, 3600)[0] : null;
          m.tipB.text(`${F.day.format(D(t))} · ${F.time.format(D(t))}`);
          m.tipS.text(`Quoted mid: Senate P(D) ${ctrlTxt(sen)} · House P(D) ${ctrlTxt(hou)} · ${fmtInt(called)} races settled${kal != null ? ` · ${fmtN(kal)} contracts/min on all of Kalshi` : ''}`);
          m.tip.attr('hidden', null).style('left', `${Math.max(0, Math.min(px + 12, el.clientWidth - 270))}px`).style('top', `${Math.max(0, py - 54)}px`);
        })
        .on('pointerleave', () => { m.hover.style('display', 'none'); m.tip.attr('hidden', ''); })
        .on('keydown', (ev) => {
          const big = ev.shiftKey ? 10 : 1;
          if (ev.key === 'ArrowRight') { ev.preventDefault(); WF.moment = null; setT(WF.t + stepSize() * big); }
          else if (ev.key === 'ArrowLeft') { ev.preventDefault(); WF.moment = null; setT(WF.t - stepSize() * big); }
          else if (ev.key === 'Home') { ev.preventDefault(); setT(WF.range[0]); }
          else if (ev.key === 'End') { ev.preventDefault(); setT(WF.range[1]); }
          else if (ev.key === ' ') { ev.preventDefault(); WF.playing ? stop() : play(); }
        });
      return m;
    },
    update(el, m) {
      const W = Math.max(240, Math.floor(el.clientWidth || 600)), H = TOP + PLOT_H + AXIS;
      const [a, b] = WF.range;
      const key = `${W}|${a}|${b}|${DATASETS.map((i) => `${stat(i)}:${rowsOf(i).length}`).join(',')}`;
      m.x = d3.scaleLinear().domain([a, b]).range([0, W]);
      m.svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
      m.hover.attr('y1', TOP).attr('y2', TOP + PLOT_H);
      if (key !== m.key) { m.key = key; drawLanes(m, W, a, b); }
      if (m.stockNow) m.stockNow();
      const cur = ok('moments') ? currentMoment() : null;
      const ms = ok('moments') ? MOMENTS().filter((d) => d.t >= a && d.t <= b) : [];
      m.marks.selectAll('path').data(ms, (d) => d.id).join((en) => en.append('path').attr('class', 'wf-mom-mark').attr('tabindex', 0).attr('role', 'button')
        .on('click', (ev, d) => { ev.stopPropagation(); if (WF.playing) stop(); pickMoment(d); })
        .on('keydown', (ev, d) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); pickMoment(d); } }))
        .attr('d', (d) => `M${m.x(d.t)},2 l5,5 l-5,5 l-5,-5 z`).classed('is-sel', (d) => cur && cur.id === d.id)
        .attr('aria-label', (d) => `${when(d.t)}: ${d.title}`);
      const x = m.x(WF.t), label = WF.range[1] - WF.range[0] > 2 * 86400 ? when(WF.t) : F.time.format(D(WF.t));
      m.cursor.select('line').attr('x1', x).attr('x2', x).attr('y1', TOP).attr('y2', TOP + PLOT_H);
      const tw = label.length * 6.6 + 10, tx = Math.min(Math.max(0, x - tw / 2), W - tw);
      m.cursor.select('rect').attr('x', tx).attr('width', tw);
      m.cursor.select('text').attr('x', tx + 5).text(label);
    },
  });

  function drawLanes(m, W, a, b) {
    const g = m.base; g.selectAll('*').remove(); m.stockNow = null;
    const x = m.x, ly = (k) => LY[k].y, lh = (k) => LY[k].h;
    for (const [k] of LANES) g.append('line').attr('class', 'wf-lane-sep').attr('x1', 0).attr('x2', W).attr('y1', ly(k) + 0.5).attr('y2', ly(k) + 0.5);
    g.append('line').attr('class', 'wf-lane-sep').attr('x1', 0).attr('x2', W).attr('y1', TOP + PLOT_H + 0.5).attr('y2', TOP + PLOT_H + 0.5);
    if (ok('moments')) for (const d of MOMENTS()) if (d.t >= a && d.t <= b) g.append('line').attr('class', 'wf-mom-rule').attr('x1', x(d.t)).attr('x2', x(d.t)).attr('y1', 12).attr('y2', TOP + PLOT_H);
    const yIn = (k, lo, hi) => d3.scaleLinear().domain([lo, hi]).range([ly(k) + lh(k) - 4, ly(k) + 5]);
    const note = (k, text, col = C.muted, dy = 0) => g.append('text').attr('x', W - 4).attr('y', ly(k) + 11 + dy).attr('text-anchor', 'end').style('fill', col).style('font', '500 9.5px ui-monospace, monospace').text(text);
    const missing = (k, id) => { if (stat(id) === 'error') note(k, 'not available yet', C.muted); return !ok(id); };
    const nb = Math.max(30, Math.min(220, Math.floor(W / 5))), bw = (b - a) / nb, bwPx = Math.max(1, W / nb - 1);
    const binLabel = bw >= 3600 ? `${Math.round(bw / 3600)} h` : `${Math.max(1, Math.round(bw / 60))} min`;
    const xs = (k) => x(a + k * bw);
    const pad = (vals) => { const arr = Array.from(vals); arr.push(arr[arr.length - 1] || 0); return arr; };   // so the last bin has width
    const g_area = (k, vals, y, col) => g.append('path').datum(pad(vals)).attr('d', d3.area().x((v, i) => xs(i)).y0(ly(k) + lh(k) - 2).y1((v) => y(v)).curve(d3.curveStepAfter)).style('fill', col).style('opacity', 0.75);
    const area = (k, vals, col, label) => {
      const mx = d3.max(vals) || 0, y = yIn(k, 0, mx || 1);
      g.append('path').datum(pad(vals)).attr('d', d3.area().x((v, i) => xs(i)).y0(ly(k) + lh(k) - 4).y1((v) => y(v)).curve(d3.curveStepAfter)).style('fill', col).style('opacity', 0.6);
      note(k, label(mx));
    };

    if (!missing('ctrl', 'control')) {
      const y0 = yIn('ctrl', 0, 1);
      g.append('line').attr('x1', 0).attr('x2', W).attr('y1', y0(0.5)).attr('y2', y0(0.5)).style('stroke', '#2b3a4d').style('stroke-dasharray', '2 3');
      for (const [ch, col] of [['House', C.house], ['Senate', C.senate]]) {
        const s = CTRL().get(ch) || [], prev = lastAt(s, a);
        const pts = (prev ? [{...prev, t: a}] : []).concat(s.filter((d) => d.t > a && d.t <= b));
        if (!pts.length) continue;
        if (pts[pts.length - 1].t < b) pts.push({...pts[pts.length - 1], t: b});
        g.append('path').datum(pts).attr('d', d3.line().defined((d) => d.p_dem != null).x((d) => x(d.t)).y((d) => y0(d.p_dem)).curve(d3.curveStepAfter)).style('fill', 'none').style('stroke', col).style('stroke-width', 1.4);
        const lastP = [...pts].reverse().find((d) => d.p_dem != null);
        if (lastP) g.append('text').attr('x', W - 4).attr('y', y0(lastP.p_dem) + (ch === 'House' ? 11 : -3)).attr('text-anchor', 'end').style('fill', col).style('font', '600 9.5px ui-monospace, monospace').text(ch);
      }
    }
    if (!missing('settled', 'races')) {
      const bins = Array.from({length: nb}, () => ({d: 0, r: 0}));
      for (const r of RX().calls) if (r.called_ts >= a && r.called_ts < b) { const k = Math.min(nb - 1, Math.floor((r.called_ts - a) / bw)); if (r.winner === 'D') bins[k].d++; else bins[k].r++; }
      const maxB = d3.max(bins, (q) => q.d + q.r) || 1, y1 = d3.scaleSqrt().domain([0, maxB]).range([0, lh('settled') - 8]);
      bins.forEach((q, k) => {
        const base = ly('settled') + lh('settled') - 3;
        if (q.r) g.append('rect').attr('x', xs(k)).attr('width', bwPx).attr('y', base - y1(q.r)).attr('height', y1(q.r)).style('fill', C.rep);
        if (q.d) g.append('rect').attr('x', xs(k)).attr('width', bwPx).attr('y', base - y1(q.r + q.d)).attr('height', y1(q.r + q.d) - y1(q.r)).style('fill', C.dem);
      });
      note('settled', `max ${maxB} per ${binLabel}`);
    }
    for (const [g, , col, long] of CATS) {               // all of Kalshi: contracts per minute in each category, own scale
      const k = `cat:${g}`;
      if (missing(k, 'kalshi_cats')) continue;
      const vals = binSum(KCATS().get(g) || [], a, b, nb, (r) => r.n, 3600).map((v) => v / (bw / 60));
      const mx = d3.max(vals) || 0, y = d3.scaleLinear().domain([0, mx || 1]).range([ly(k) + lh(k) - 2, ly(k) + 3]);
      g_area(k, vals, y, col);
      note(k, mx ? `peak ${fmtN(mx)}/min` : `no ${long.toLowerCase()} trades`, C.muted, -2);
    }
    if (ok('kalshi_cats') && a < N1 && b > N0) for (const t of [N0, N1]) if (t > a && t < b) {
      g.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', ly('cat:midterms')).attr('y2', ly('cat:other') + lh('cat:other')).style('stroke', C.fg).style('stroke-opacity', 0.35).style('stroke-dasharray', '1 2');
    }
    if (!missing('bets', 'bets_flow')) {
      const s = FLOW(), dv = binSum(s, a, b, nb, (r) => r.d, 600), rv = binSum(s, a, b, nb, (r) => r.rr, 600);
      const per = bw / 60, mx = Math.max(d3.max(dv) || 0, d3.max(rv) || 0) / per || 1;
      const mid = ly('bets') + lh('bets') / 2, yb = d3.scaleSqrt().domain([0, mx]).range([0, lh('bets') / 2 - 3]);
      for (let k = 0; k < nb; k++) {
        if (dv[k]) g.append('rect').attr('x', xs(k)).attr('width', bwPx).attr('y', mid - yb(dv[k] / per)).attr('height', yb(dv[k] / per)).style('fill', C.dem);
        if (rv[k]) g.append('rect').attr('x', xs(k)).attr('width', bwPx).attr('y', mid).attr('height', yb(rv[k] / per)).style('fill', C.rep);
      }
      note('bets', `peak ${usd(mx)}/min`);
    }
    if (!missing('big', 'big_bets')) {
      const s = BIG().filter((d) => d.t >= a && d.t <= b), rs = d3.scaleSqrt().domain([0, d3.max(s, (d) => d.usd) || 1]).range([1, 7]);
      const cy = ly('big') + lh('big') / 2, col = (d) => (d.backs === 'D' ? C.dem : d.backs === 'R' ? C.rep : C.ind);
      g.append('g').selectAll('circle').data(s).join('circle').attr('cx', (d) => x(d.t)).attr('cy', (d) => cy + (d.backs === 'D' ? -4 : d.backs === 'R' ? 4 : 0)).attr('r', (d) => rs(d.usd))
        .style('fill', col).style('fill-opacity', 0.4).style('stroke', col).style('stroke-width', 0.8);
      note('big', `${fmtInt(s.length)} of the 1,500 largest`);
    }
    if (!missing('streams', 'streams')) {
      const ss = rowsOf('streams').slice().sort((p, q) => (p.lean === q.lean ? p.start - q.start : p.lean < q.lean ? -1 : 1));
      const rowH = (lh('streams') - 8) / Math.max(1, ss.length);
      ss.forEach((s, i) => {
        if (!s.start || s.end < a || s.start > b) return;
        g.append('rect').attr('x', x(Math.max(a, s.start))).attr('width', Math.max(1, x(Math.min(b, s.end)) - x(Math.max(a, s.start))))
          .attr('y', ly('streams') + 4 + i * rowH).attr('height', Math.max(1, rowH - 1)).style('fill', s.lean === 'L' ? '#5c8fe6' : '#e65c66').style('opacity', 0.85);
      });
    }
    if (!missing('chat', 'chat')) area('chat', binSum(rowsOf('chat'), a, b, nb, (r) => r.messages, 60).map((v) => v / (bw / 60)), '#8fa3ff', (mx) => `peak ${fmtInt(Math.round(mx))}/min`);
    if (!missing('reddit', 'reddit_hourly')) area('reddit', binSum(RED_US(), a, b, nb, (r) => r.c, 3600).map((v) => v / (bw / 60)), C.social, (mx) => `peak ${fmtInt(Math.round(mx))}/min · national subs`);
    if (!missing('bsky', 'bluesky')) area('bsky', binSum(BSKY().all, a, b, nb, (r) => r.posts, 600).map((v) => v / (bw / 600)), C.bsky, (mx) => `peak ${fmtInt(Math.round(mx))} per 10 min · sample`);
    if (!missing('poly', 'polymarket')) area('poly', binSum(rowsOf('polymarket'), a, b, nb, (r) => r.comments, 3600).map((v) => v / (bw / 3600)), '#c9a2ff', (mx) => `peak ${fmtInt(Math.round(mx))}/hour`);
    const kix = b - a <= 2 * 86400 && a < N1 && b > N0 && ok('kalshi_index');
    if (kix) {                                   // election night: Kalshi-implied S&P 500 / Nasdaq-100 at 10 AM Nov 4, % vs Nov 3 close
      const rows = rowsOf('kalshi_index'), ref = (dash.data('kalshi_index').raw || {}).ref || [];
      const sets = [['SPX', 'S&P 500', C.senate], ['NDX', 'Nasdaq-100', '#7dd3fc']]
        .map(([k, name, col]) => ({k, name, col, pts: rows.filter((r) => r.idx === k && r.target === '10 AM' && r.t >= a && r.t <= b)}));
      const vals = sets.flatMap((st) => st.pts.map((d) => d.pct)).concat([0]);
      const [lo, hi] = d3.extent(vals), pd = (hi - lo || 1) * 0.12, ys = yIn('stocks', lo - pd, hi + pd);
      g.append('line').attr('x1', x(a)).attr('x2', x(b)).attr('y1', ys(0)).attr('y2', ys(0)).style('stroke', C.muted).style('stroke-opacity', 0.5).style('stroke-dasharray', '2 3');
      if (sets[1].pts.length) g.append('path').datum(sets[1].pts).attr('d', d3.line().x((d) => x(d.t)).y((d) => ys(d.pct))).style('fill', 'none').style('stroke', sets[1].col).style('stroke-width', 1).style('stroke-dasharray', '3 2');
      const bin = 1800, cs = [];                 // S&P: 30-minute candles (open/high/low/close of the implied level)
      for (const d of sets[0].pts) {
        const k = Math.floor((d.t - 1) / bin) * bin;
        let c = cs[cs.length - 1];
        if (!c || c.t !== k) { c = {t: k, o: c ? c.c : d.pct, h: d.pct, l: d.pct, c: d.pct}; cs.push(c); }
        c.h = Math.max(c.h, d.pct, c.o); c.l = Math.min(c.l, d.pct, c.o); c.c = d.pct;
      }
      const cw = Math.max(2, (x(a + bin) - x(a)) * 0.62);
      for (const c of cs) {
        const col = c.c >= c.o ? '#46d39a' : '#ff4d5a', cx = x(c.t + bin / 2);
        g.append('line').attr('x1', cx).attr('x2', cx).attr('y1', ys(c.h)).attr('y2', ys(c.l)).style('stroke', col).style('stroke-width', 1);
        g.append('rect').attr('x', cx - cw / 2).attr('width', cw).attr('y', ys(Math.max(c.o, c.c))).attr('height', Math.max(1, Math.abs(ys(c.o) - ys(c.c)))).style('fill', col);
      }
      const act = ref.find((r) => r.idx === 'SPX' && r.target === '10 AM'), txt = note('stocks', '', C.senate);
      const pc = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
      m.stockNow = () => {                      // depends on the cursor: re-run on every cursor move (see update)
        const cur = lastAt(sets[0].pts, WF.t);
        txt.text(`Kalshi-implied S&P (30-min candles) at 10 AM Nov 4: ${cur ? pc(cur.pct) : '—'}${act && act.actual_pct != null ? ` · actual ${pc(act.actual_pct)}` : ''}`);
      };
    }
    if (!kix && !missing('stocks', 'stocks')) {
      [['SP500', 'S&P 500', C.senate, null], ['NASDAQCOM', 'Nasdaq', '#7dd3fc', null], ['VIXCLS', 'VIX', '#8a9bb0', '2 2']].forEach(([sid, name, col, dsh], j) => {
        const s = STK().get(sid) || [], prev = lastAt(s, a);
        const pts = (prev ? [{...prev, t: a}] : []).concat(s.filter((d) => d.t > a && d.t <= b));
        if (!pts.length) return;
        if (pts[pts.length - 1].t < b) pts.push({...pts[pts.length - 1], t: b});
        const [lo, hi] = d3.extent(pts, (d) => d.value), pd = (hi - lo || 1) * 0.1, ys = yIn('stocks', lo - pd, hi + pd);
        g.append('path').datum(pts).attr('d', d3.line().x((d) => x(d.t)).y((d) => ys(d.value)).curve(d3.curveStepAfter)).style('fill', 'none').style('stroke', col).style('stroke-width', j === 2 ? 1 : 1.4).style('stroke-dasharray', dsh);
        if (j < 2) note('stocks', `${name} ${fmtInt(Math.round(pts[pts.length - 1].value))}`, col, j * 10);
      });
    }
    if (ok('gas') && ok('oil')) {
      const toT = (ds) => Date.parse(`${ds}T17:00:00Z`) / 1000;
      [['US gas', GAS().byState.get('US') || [], '#ffb347', null], ['WTI', OIL().get('WTI') || [], C.muted, '3 2']].forEach(([name, s, col, dsh], j) => {
        const prev = lastAt(s, etDate(a), 'date');
        const pts = (prev ? [{...prev, t: a}] : []).concat(s.map((d) => ({...d, t: toT(d.date)})).filter((d) => d.t > a && d.t <= b));
        if (!pts.length) return;
        if (pts[pts.length - 1].t < b) pts.push({...pts[pts.length - 1], t: b});
        const [lo, hi] = d3.extent(pts, (d) => d.price), pd = (hi - lo || 1) * 0.1, y9 = yIn('gas', lo - pd, hi + pd);
        g.append('path').datum(pts).attr('d', d3.line().x((d) => x(d.t)).y((d) => y9(d.price)).curve(d3.curveStepAfter)).style('fill', 'none').style('stroke', col).style('stroke-width', 1.4).style('stroke-dasharray', dsh);
        note('gas', `${name} $${pts[pts.length - 1].price.toFixed(2)}`, col, j * 10);
      });
    }
    m.axis.selectAll('*').remove();
    const {out, step} = ticks(a, b, W), y = TOP + PLOT_H;
    for (const t of out) {
      m.axis.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', y).attr('y2', y + 4);
      m.axis.append('text').attr('x', x(t)).attr('y', y + 15).attr('text-anchor', x(t) < 20 ? 'start' : x(t) > W - 20 ? 'end' : 'middle').text(tickLabel(t, step));
    }
  }

  // ------------------------------------------------------------------ heatmap: every race over 120 days, log time
  // data/heatmap.json (analysis/heatmap_dem_odds.py --site): one byte per cell, 0-200 = 0-100% chance D, 255 = no market yet.
  // Columns are log-spaced minutes before the view's anchor (Nov 10 12 AM ET, or each race's own settlement).
  WF.heat = 'settle';
  const HEAT_COLOR = d3.scaleLinear().domain([0, 0.25, 0.5, 0.75, 1])
    .range(['#c8323f', '#f0959c', '#dde4ec', '#8fbaf5', '#2a6fd6']).interpolate(d3.interpolateLab).clamp(true);
  const HEAT_NONE = '#1a2430', HEAT_GAP = '#4a3d1f', HEAT_CLOSED = '#2c3542';   // 255 = not open yet, 254 = open but no two-sided quote, 253 = trading closed, not settled
  const HEAT_TICKS = [['120d', 172800], ['60d', 86400], ['30d', 43200], ['14d', 20160], ['7d', 10080], ['3d', 4320], ['1d', 1440],
    ['12h', 720], ['6h', 360], ['2h', 120], ['1h', 60], ['30m', 30], ['10m', 10], ['3m', 3], ['1m', 1]];
  const HEAT_OFFICES = ['Senate', 'Governor', 'House'];
  const HM = () => memo('heatmap-m', ['heatmap'], (h) => {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let k = 0; k < 256; k++) { const c = d3.rgb(k <= 200 ? HEAT_COLOR(k / 200) : k === 254 ? HEAT_GAP : k === 253 ? HEAT_CLOSED : HEAT_NONE); lut.set([c.r, c.g, c.b, 255], k * 4); }
    const cols = h.cols, views = {};
    for (const [key, v] of Object.entries(h.views)) {
      const raw = atob(v.v), bytes = new Uint8Array(raw.length);
      for (let k = 0; k < raw.length; k++) bytes[k] = raw.charCodeAt(k);
      const bands = HEAT_OFFICES.map((office) => {
        const idx = v.order[office] || [];
        const cv = document.createElement('canvas'); cv.width = cols; cv.height = Math.max(1, idx.length);
        const ctx = cv.getContext('2d'), img = ctx.createImageData(cols, cv.height);
        idx.forEach((i, r) => { for (let j = 0; j < cols; j++) { const b = bytes[i * cols + j]; img.data.set(lut.subarray(b * 4, b * 4 + 4), (r * cols + j) * 4); } });
        ctx.putImageData(img, 0, 0);
        return {office, idx, cv};
      });
      views[key] = {...v, bytes, bands};
    }
    const l0 = Math.log10(h.mins[0]), l1 = Math.log10(h.mins[cols]);
    return {h, views, xf: (min) => (l0 - Math.log10(Math.min(h.mins[0], Math.max(min, h.mins[cols])))) / (l0 - l1)};
  });
  const fmtSpan = (min) => (min >= 2880 ? `${Math.round(min / 1440)} days` : min >= 120 ? `${Math.round(min / 60)} hours` : min >= 1.5 ? `${Math.round(min)} min` : '1 min');
  const pctD = (p) => { const x = p * 100; return Math.round(x) === 50 ? x.toFixed(1) : String(Math.round(x)); };
  function openRace(id) {
    WF.tape = 'market'; syncUI(); pickRace(id);
    document.getElementById('wf-race-select').scrollIntoView({behavior: 'smooth', block: 'start'});
  }
  dash.draw('heatmap', {
    mount(el) {
      const box = d3.select(el);
      const msg = box.append('p').attr('class', 'wf-msg');
      const cv = box.append('canvas').attr('class', 'wf-heat-cv').attr('role', 'img').attr('tabindex', 0);
      const live = box.append('p').attr('class', 'wf-sr').attr('aria-live', 'polite');
      const note = box.append('p').attr('class', 'wf-hint wf-heat-note');
      const tip = box.append('div').attr('class', 'wf-tip').attr('hidden', '');
      const m = {box, msg, cv, note, tip, live, tipB: tip.append('b'), tipS: tip.append('span'), tipS2: tip.append('span'), lay: null,
        mono: getComputedStyle(el).getPropertyValue('--wf-mono').trim() || 'monospace'};
      const hit = (ev) => {
        if (!m.lay) return null;
        const [x, y] = d3.pointer(ev, cv.node());
        const L = m.lay, band = L.bands.find((b) => y >= b.y0 && y < b.y0 + b.h);
        if (!band || !band.idx.length || x < 0 || x >= L.W) return null;
        const r = Math.min(band.idx.length - 1, Math.floor(((y - band.y0) / band.h) * band.idx.length));
        const j = Math.min(L.cols - 1, Math.floor((x / L.W) * L.cols));
        return {i: band.idx[r], j};
      };
      const describe = (p) => {                  // one cell in words: shared by the hover tip and the keyboard
        const H = HM(), V = H.views[WF.heat], race = H.h.races[p.i];
        const min = H.h.mins[p.j + 1], anchor = V.anchor != null ? V.anchor : V.anchors[p.i], t = anchor - min * 60;
        const b = V.bytes[p.i * H.h.cols + p.j];
        const settled = race.winner && race.called_ts && t >= race.called_ts;
        return [`${race.label}${race.office === 'House' ? ' · House' : ''}`,
          b === 255 ? 'no market yet' : b === 254 ? 'no two-sided quote in this period (gap)' : b === 253 ? 'Kalshi trading closed, not settled yet' : settled ? `settled · ${race.winner === 'D' ? 'Democrat' : 'Republican'} won`
            : `${pctD(b / 200)}% chance the Democrat wins (quoted mid)`,
          `${when(t)} ET · ${fmtSpan(min)} before ${WF.heat === 'settle' && race.called_ts ? 'Kalshi settled it' : 'Nov 10'}`];
      };
      cv.on('keydown', (ev) => {   // Up/Down: previous/next race (selects it); Left/Right: back/forward in time; Enter: open its market
        if (!m.lay || !ok('heatmap')) return;
        const H = HM(), rows = m.lay.bands.flatMap((b) => b.idx);
        let r = rows.findIndex((i) => H.h.races[i].id === WF.race), j = m.kj ?? m.lay.cols - 1;
        if (ev.key === 'ArrowDown') r += 1; else if (ev.key === 'ArrowUp') r -= 1;
        else if (ev.key === 'ArrowLeft') j -= 1; else if (ev.key === 'ArrowRight') j += 1;
        else if (ev.key === 'Enter' && r >= 0) { ev.preventDefault(); openRace(H.h.races[rows[r]].id); return; }
        else return;
        ev.preventDefault();
        r = Math.max(0, Math.min(rows.length - 1, r)); m.kj = j = Math.max(0, Math.min(m.lay.cols - 1, j));
        if (H.h.races[rows[r]].id !== WF.race) pickRace(H.h.races[rows[r]].id);
        const d = describe({i: rows[r], j}), band = m.lay.bands.find((b) => b.idx.includes(rows[r]));
        const cr = cv.node().getBoundingClientRect(), er = el.getBoundingClientRect();
        const cx = cr.left - er.left + ((j + 0.5) / m.lay.cols) * m.lay.W, cy = cr.top - er.top + band.y0 + band.idx.indexOf(rows[r]) * (band.h / band.idx.length);
        m.tipB.text(`${d[0]} · keyboard`); m.tipS.text(d[1]); m.tipS2.text(d[2]);   // visible, at the selected cell
        m.tip.attr('hidden', null).style('left', `${Math.max(0, Math.min(cx - 6, el.clientWidth - 270))}px`).style('top', `${cy + 10}px`);
        m.live.text(d.join(' · '));
      }).on('blur', () => m.tip.attr('hidden', ''));
      cv.on('pointermove', (ev) => {
        const p = hit(ev);
        if (!p) { m.tip.attr('hidden', ''); cv.style('cursor', null); return; }
        const [t1, t2, t3] = describe(p);
        m.tipB.text(t1); m.tipS.text(t2); m.tipS2.text(t3);
        const [bx, by] = d3.pointer(ev, el);
        m.tip.attr('hidden', null).style('left', `${Math.max(0, Math.min(bx + 14, el.clientWidth - 270))}px`).style('top', `${Math.max(0, by - 10)}px`);
        cv.style('cursor', 'pointer');
      }).on('pointerleave', () => m.tip.attr('hidden', ''))
        .on('click', (ev) => { const p = hit(ev); if (p) openRace(HM().h.races[p.i].id); });
      return m;
    },
    update(el, m) {
      if (!ok('heatmap')) {
        m.cv.attr('hidden', ''); m.note.text('');
        m.msg.attr('hidden', null).text(stat('heatmap') === 'error' ? 'Failed to load the heatmap.' : 'Loading heatmap…');
        return;
      }
      m.msg.attr('hidden', ''); m.cv.attr('hidden', null);
      const H = HM(), V = H.views[WF.heat], cols = H.h.cols;
      const W = Math.max(260, Math.floor(el.clientWidth || 800));
      const wide = W >= 900, rh = {Senate: wide ? 5 : 4, Governor: wide ? 5 : 4, House: wide ? 1.25 : 1};
      const HEAD = 18, GAP = 10, AXIS = 26;
      let y = 0;
      const bands = V.bands.map((b) => { y += HEAD; const o = {...b, y0: y, h: b.idx.length * rh[b.office]}; y += o.h + GAP; return o; });
      const Ht = Math.ceil(y - GAP + AXIS);
      m.lay = {W, cols, bands};
      const dpr = window.devicePixelRatio || 1, node = m.cv.node();
      if (node.width !== Math.round(W * dpr) || node.height !== Math.round(Ht * dpr)) {
        node.width = Math.round(W * dpr); node.height = Math.round(Ht * dpr);
        m.cv.style('width', `${W}px`).style('height', `${Ht}px`);
      }
      const n = HEAT_OFFICES.map((o) => `${(V.order[o] || []).length} ${o}`).join(', ');
      m.cv.attr('aria-label', `Heatmap of the Kalshi chance the Democrat wins for ${n} races over 120 days, log time, `
        + (WF.heat === 'settle' ? 'ending at each race\'s settlement.' : 'ending Nov 10.')
        + ' Keyboard: Up and Down pick a race, Left and Right step through time, Enter opens its market card; each cell is read out.');
      const ctx = node.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, Ht);
      ctx.imageSmoothingEnabled = false;
      ctx.font = `600 10.5px ${m.mono}`; ctx.textAlign = 'left'; ctx.fillStyle = C.muted;
      for (const b of bands) {
        ctx.fillText(`${b.office.toUpperCase()} · ${b.idx.length}`, 0, b.y0 - 6);
        if (b.idx.length) ctx.drawImage(b.cv, 0, 0, cols, b.idx.length, 0, b.y0, W, b.h);
      }
      const vline = (x, color, dash, width) => {
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
        for (const b of bands) { ctx.moveTo(x, b.y0); ctx.lineTo(x, b.y0 + b.h); }
        ctx.stroke(); ctx.restore();
      };
      if (WF.heat === 'nov10') {
        const xm = Math.round(H.xf((V.anchor - V.mark) / 60) * W) + 0.5;
        vline(xm, '#0a0f15', [3, 3], 1);
        ctx.fillStyle = C.muted; ctx.font = `500 10.5px ${m.mono}`; ctx.fillText('polls close', xm + 5, bands[0].y0 - 6);
        if (WF.t < V.anchor - 60 && WF.t > V.anchor - H.h.mins[0] * 60) vline(H.xf((V.anchor - WF.t) / 60) * W, C.amber, [], 1.5);
      }
      for (const b of bands) {                     // the race selected on the map / dropdown: amber brackets on its row
        const r = b.idx.findIndex((i) => H.h.races[i].id === WF.race);
        if (r < 0) continue;
        const rh_ = b.h / b.idx.length, y = b.y0 + r * rh_;
        ctx.save(); ctx.strokeStyle = C.amber; ctx.lineWidth = 2;
        ctx.strokeRect(1, y - 1.5, W - 2, Math.max(3, rh_) + 3); ctx.restore();
      }
      const yb = bands[bands.length - 1].y0 + bands[bands.length - 1].h;
      ctx.strokeStyle = '#2b3a4d'; ctx.fillStyle = C.muted; ctx.font = `500 10.5px ${m.mono}`; ctx.lineWidth = 1;
      let last = -Infinity;
      for (const [lab, mm] of HEAT_TICKS.filter(([, mm]) => mm <= H.h.mins[0] * 1.0001)) {
        const x = H.xf(mm) * W, w = ctx.measureText(lab).width;
        const left = x < w / 2 ? 0 : x > W - w / 2 ? W - w : x - w / 2;
        if (left < last + 8) continue;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yb + 2); ctx.lineTo(Math.round(x) + 0.5, yb + 7); ctx.stroke();
        ctx.textAlign = 'left'; ctx.fillText(lab, left, yb + 19);
        last = left + w;
      }
      m.note.text(WF.heat === 'settle'
        ? `Quoted midpoint of the Democratic contract. Brown cells: open but no two-sided quote (a gap); slate: trading closed, not settled yet; dark: not open yet. Time before Kalshi settled each race, log scale. Rows sorted by the ${V.sort}. Races not settled yet end at Nov 10. Amber outline: the selected race; click a row to open its market card and election-night panel.`
        : `Quoted midpoint of the Democratic contract. Brown cells: open but no two-sided quote (a gap); slate: trading closed, not settled yet; dark: not open yet. Time before Nov 10, 12 AM ET, log scale. Dotted line: first polls close, Nov 3 7 PM ET. Amber vertical line: the page's time cursor. Amber outline: the selected race. Rows sorted by the ${V.sort}.`);
    },
  });
  dash.draw('heat-ups', (el) => {
    if (!ok('heatmap') || el.childElementCount) return;
    const H = HM(), ups = H.h.upsets, head = ups.filter((u) => u.headline), rest = ups.length - head.length;
    const lab = document.createElement('span'); lab.className = 'wf-hint';
    lab.textContent = `${head.length} races where the quoted favorite at 6 PM ET Nov 3 lost (Democratic-contract midpoint; most strongly favored loser first):`;
    el.append(lab);
    for (const u of head) {
      const r = H.h.races[u.i], fav = u.fav === 'D' ? 'Democrat' : 'Republican';
      const b = document.createElement('button');
      b.type = 'button'; b.className = `wf-heat-chip ${r.winner === 'D' ? 'is-d' : 'is-r'}`;
      b.textContent = `${r.label} ${pctD(u.p)}% · ${((u.ask - u.bid) * 100).toFixed(1)}¢ spread · ${F.time.format(D(u.t))}`;
      b.title = `${r.label}: quoted mid ${pctD(u.p)}% that the Democrat wins (bid ${(u.bid * 100).toFixed(1)}¢ / ask ${(u.ask * 100).toFixed(1)}¢, observed ${when(u.t)} ET, the book in effect at 6 PM): the ${fav} was favored; the ${r.winner === 'D' ? 'Democrat' : 'Republican'} won. Click to open its market.`;
      b.addEventListener('click', () => openRace(r.id));
      el.append(b);
    }
    if (rest) { const n = document.createElement('span'); n.className = 'wf-hint'; n.textContent = `Not listed: ${rest} more where the 6 PM bid and ask straddled 50¢, so the quote favored neither side.`; el.append(n); }
  });
  document.querySelectorAll('.wf [data-heat]').forEach((b) => b.addEventListener('click', () => {
    WF.heat = b.dataset.heat;
    document.querySelectorAll('.wf [data-heat]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.heat === WF.heat)));
    dash.draw('heatmap');
  }));

  // ------------------------------------------------------------------ start
  syncUI();
  for (const id of DATASETS) dash.load(id, `data/${id}.json`);
  dash.drawAll();
})();
