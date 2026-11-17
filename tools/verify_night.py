#!/usr/bin/env python3
"""Recompute the night panel's readout from the raw pull and compare it with the files the page loads.
Usage: verify_night.py <event> <t> [<event> <t> ...]
Control markets are read from data/night_control.json + data/night_trades/; races from data/night_state/<ST>.json."""
import gzip, json, os, sys
from datetime import datetime
RAW = os.environ.get("KALSHI_RAW", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "raw"))   # our Kalshi API pull (Midterm_markets/raw)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
NC = json.load(open(f"{OUT}/data/night_control.json"))
A = NC["window"][0]
IDX = json.load(open(f"{OUT}/data/night_races.json"))["races"]


def built(e):
    for ev in NC["events"]:
        if ev["event"] == e:
            return ev, json.load(open(f"{OUT}/data/night_trades/{e}.json"))["rows"], {f"{e}-D": "D", f"{e}-R": "R"}
    ev = json.load(open(f"{OUT}/data/night_state/{IDX[e]['state']}.json"))["races"][e]
    return ev, ev["trades"], {tk: s for s, tk in ev["sides"].items()}


def quote_at(q, t):
    for i in range(min((t - A) // 60 - 1, len(q["bid"]) - 1), -1, -1):
        if q["bid"][i] is not None and q["ask"][i] is not None: return A + (i + 1) * 60, q["bid"][i], q["ask"][i]
    return None


bad = 0
for e, t in zip(sys.argv[1::2], map(int, sys.argv[2::2])):
    ev, rows, sides = built(e)
    dtk = next(tk for tk, s in sides.items() if s == "D")
    close = ev["close_ts"] or 1e12
    q = None
    rd = lambda f: gzip.open(f, "rt") if os.path.exists(f) else []
    for ln in rd(f"{RAW}/candles_1m_linked/{e}.jsonl.gz"):
        c = json.loads(ln); end = c["end_period_ts"]
        if c["ticker"] != dtk or end > min(t, close) or end <= A: continue
        b, a = (c.get("yes_bid") or {}).get("close_dollars"), (c.get("yes_ask") or {}).get("close_dollars")
        if b is None or a is None: continue                      # latest observed book, one-sided included
        if q is None or end > q[0]: q = (end, float(b), float(a))
    seen, last, near, cnt = set(), None, 0, 0.0
    for ln in rd(f"{RAW}/trades/{e}.jsonl.gz"):
        d = json.loads(ln)
        if d["trade_id"] in seen or d["ticker"] not in sides: continue
        if ev.get("binary") is False and sides[d["ticker"]] != "D": continue      # three-way race: only D-contract trades are P(D)
        seen.add(d["trade_id"]); x = ts(d["created_time"])
        if x < A: continue
        p = float(d["yes_price_dollars"]); p = p if sides[d["ticker"]] == "D" else 1 - p
        if x < t and (last is None or x >= last[0]): last = (x, p)
        if t - 60 <= x < t + 60: near += 1; cnt += float(d["count_fp"])
    bq = quote_at(ev["quotes"]["D"], min(t, close))
    bl = [r for r in rows if r[0] < t and (ev.get("binary") is not False or r[1] == 0)]; bl = bl[-1] if bl else None
    bp = None if bl is None else bl[3] if bl[1] == 0 else 1 - bl[3]
    bn = [r for r in rows if t - 60 <= r[0] < t + 60 and (ev.get("binary") is not False or r[1] == 0)]
    ok = (q is None and bq is None or q is not None and bq is not None and (q[0], round(q[1], 4), round(q[2], 4)) == (bq[0], round(bq[1], 4), round(bq[2], 4))) \
        and (last is None and bp is None or last is not None and bp is not None and abs(bp - last[1]) < 1e-9) and len(bn) == near and abs(sum(r[4] for r in bn) - cnt) < 1
    bad += not ok
    fq = lambda z: f"{z[1]*100:.1f}c/{z[2]*100:.1f}c observed {t - z[0]} s before" if z else "no quote"
    print(f"{'MATCH' if ok else 'MISMATCH'} {e} t={t}: raw {fq(q)}, last trade {'%.1fc' % (last[1]*100) if last else 'none'}, {near} trades within 60 s"
          f" | built {fq(bq)}, last trade {'%.1fc' % (bp*100) if bp is not None else 'none'}, {len(bn)} trades")
sys.exit(bad)
