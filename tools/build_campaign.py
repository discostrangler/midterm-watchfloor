#!/usr/bin/env python3
"""Campaign-wide race prices on the agreed mapping: rebuilds data/race_odds.json and data/heatmap.json from our raw pull.

Same mapping as the election-night panel (tools/build_races_night.py): event = Watchfloor race_id (party event), price =
QUOTED MIDPOINT of the Democratic contract's best YES bid/ask (contract found by Kalshi party id, else suffix). Nothing is
blended with the Republican contract and no last-trade fallback is used. A period without a two-sided quote is a GAP
(race_odds: p_dem null; heatmap: byte 254), so thin markets show as gaps instead of a carried-forward price.

Quote observations: hourly candles (whole life) + 1-minute candles (Oct 20 - Nov 12), each stamped at its candle END.
race_odds: hourly from Oct 4 (per minute Nov 3 5 PM - Nov 4 11 AM ET), a row only when the value changes, then 1/0 at settlement.
heatmap: Lawrence's columns, anchors, row order and upset list are kept; every cell is recomputed. A cell holds the book in
effect at its right edge: the last observed candle at or before it (Kalshi omits candles for quiet periods); 255 = contract not
open yet; 254 = open but no two-sided quote; 0-200 = 0-100%; after settlement 0/200.
Also rebuilds data/control.json (the two chamber-control markets, same definition) and restates the numbers in the swing
key moments (data/moments.json) from these series. Watchfloor's originals are kept in private/*.lawrence.json.
Run: sbatch tools/build_campaign.sbatch
"""
import base64, bisect, csv, gzip, json, os, re, shutil
from datetime import datetime, timezone
from multiprocessing import Pool

RAW = os.environ.get("KALSHI_RAW", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "raw"))   # our Kalshi API pull (Midterm_markets/raw)
OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
U = lambda *a: int(datetime(*a, tzinfo=timezone.utc).timestamp())
C0, C1 = U(2026, 10, 4, 4), U(2026, 11, 12, 5)        # Watchfloor's campaign window
N0, N1 = U(2026, 11, 3, 22), U(2026, 11, 4, 16)        # per-minute detail window
M1 = U(2026, 10, 20)                                   # 1-minute candles start (linked set)
T6 = U(2026, 11, 3, 23)                                # 6 PM ET Nov 3: the cut-off for row order and upsets
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None


def px(side):
    if not side: return None
    v = side.get("close_dollars")
    if v is None and side.get("close") is not None: v = float(side["close"]) / 100   # historical tier: cents, no suffix
    return None if v is None else float(v)


def quotes(path, dtk):
    out = {}
    if os.path.exists(path):
        for ln in gzip.open(path, "rt"):
            c = json.loads(ln)
            if c["ticker"] != dtk: continue
            b, a = px(c.get("yes_bid")), px(c.get("yes_ask"))
            out[c["end_period_ts"]] = None if b is None or a is None or b <= 0 or a >= 1 else (round((b + a) / 2, 4), b, a)   # two-sided only
    return out


def one(job):
    rid, dtk, opened, close, settle, result = job
    h = quotes(f"{RAW}/candles_1h/{rid}.jsonl.gz", dtk)
    m = quotes(f"{RAW}/candles_1m_linked/{rid}.jsonl.gz", dtk)
    stop = min(x for x in (close, settle) if x) if (close or settle) else None
    obs = sorted({**h, **m}.items())                      # (candle end, (mid, bid, ask) or None); minute rows override at shared ends
    if stop: obs = [o for o in obs if o[0] <= stop]
    # the book in effect at 6 PM ET Nov 3: last observed candle at or before it; usable only if two-sided and still trading
    j = bisect.bisect_right([o[0] for o in obs], T6) - 1
    six = {"t": obs[j][0], "mid": obs[j][1][0], "bid": obs[j][1][1], "ask": obs[j][1][2]} if j >= 0 and obs[j][1] and (not close or close > T6) and (not opened or opened <= T6) else None
    obs = [(t, v[0] if v else None) for t, v in obs]
    # race_odds rows
    rows, last = [], "x"
    def emit(t, v):
        nonlocal last
        if v != last: rows.append({"t": t, "race_id": rid, "p_dem": v}); last = v
    for t, v in obs:
        if C0 <= t <= C1 and (not (N0 <= t < N1) or t in m) and (N0 <= t < N1 or t % 3600 == 0): emit(t, v)
    # trading closed but not settled yet: an explicit marker, so the last quote is not carried forward as if the book were open
    if close and (not settle or close < settle) and C0 <= close <= C1: rows.append({"t": close, "race_id": rid, "p_dem": None, "closed": 1})
    if settle and result in ("D", "R"): rows.append({"t": settle, "race_id": rid, "p_dem": 1.0 if result == "D" else 0.0})
    ends = [o[0] for o in obs]
    def cell(L, R):
        if settle and R >= settle: return 200 if result == "D" else 0 if result == "R" else 254
        if close and R >= close: return 253                                   # trading closed, not settled yet
        if opened and R < opened: return 255
        i = bisect.bisect_right(ends, R) - 1        # the last observed book stands until the next candle (quiet minutes have none)
        if i < 0 or obs[i][1] is None: return 254
        return max(0, min(200, round(obs[i][1] * 200)))
    return rid, rows, cell, six


def main():
    races = json.load(open(f"{OUT}/data/races.json"))["rows"]
    sides = {}
    for c in csv.DictReader(open(f"{OUT}/crosswalk/race_contracts.tsv"), delimiter="\t"):
        if c["side"] == "D": sides.setdefault(c["event"], c)
    jobs = []
    for r in races:
        c = sides[r["race_id"]]
        st = ts(c["settlement_ts"])
        jobs.append((r["race_id"], c["ticker"], ts(c["open_time"]), ts(c["close_time"]), round(st) if st else None, {"yes": "D", "no": "R"}.get(c["result"], "")))
    J = {j[0]: j for j in jobs}
    global H
    H = json.load(open(f"{OUT}/data/heatmap.json"))
    mins, cols = H["mins"], H["cols"]
    rid_at = [x["id"] for x in H["races"]]
    # result and settlement time from the D/R contracts of the party event (not from any other contract in the event:
    # KXHOUSERACE-WA09-26-KSAW, an eliminated candidate, settled Aug 5 and Watchfloor had taken that as the race's)
    for i, x in enumerate(H["races"]):
        x["winner"], x["called_ts"] = J[x["id"]][5], J[x["id"]][4]
        H["views"]["settle"]["anchors"][i] = J[x["id"]][4] or H["views"]["nov10"]["anchor"]
    with Pool(int(os.environ.get("SLURM_CPUS_PER_TASK", 4))) as pool:
        res = pool.map(one_with_cells, jobs, chunksize=4)
    by = {rid: (rows, cells) for rid, rows, cells, _ in res}
    six = {rid: x for rid, _, _, x in res}
    # row order: within each office, by the 6 PM quoted mid (R-favoured first); races without a usable quote at the bottom
    office = {x["id"]: x["office"] for x in H["races"]}
    lab = {x["id"]: x["label"] for x in H["races"]}
    order = {}
    for o in ("Senate", "Governor", "House"):
        ids = [i for i, rid in enumerate(rid_at) if office[rid] == o]
        order[o] = sorted(ids, key=lambda i: (six[rid_at[i]] is None, six[rid_at[i]]["mid"] if six[rid_at[i]] else 0, lab[rid_at[i]]))
    for V in H["views"].values():
        V["order"], V["sort"] = order, "quoted mid of the Democratic contract at 6 PM ET Nov 3 (no usable quote: bottom)"
    # upsets: the 6 PM quoted favourite lost; ranked by how strongly the loser was favoured
    ups = []
    for i, rid in enumerate(rid_at):
        x, res_ = six[rid], J[rid][5]
        if not x or res_ not in ("D", "R") or x["mid"] == 0.5: continue
        fav = "D" if x["mid"] > 0.5 else "R"
        if fav == res_: continue
        ups.append({"i": i, "p": x["mid"], "bid": x["bid"], "ask": x["ask"], "t": x["t"], "fav": fav, "strength": round(abs(x["mid"] - 0.5), 4),
                    "headline": not (x["bid"] < 0.5 < x["ask"])})
    H["upsets"] = sorted(ups, key=lambda u: -u["strength"])
    # races.json: same result / settlement time / 6 PM price as everything else
    R = json.load(open(f"{OUT}/data/races.json"))
    for r in R["rows"]:
        r["winner"], r["called_ts"] = J[r["race_id"]][5], J[r["race_id"]][4]
        r["p_dem_eve"] = six[r["race_id"]]["mid"] if six[r["race_id"]] else None
    R["meta"]["inputs"] = "Midterm_markets catalog: result and settlement_ts of the party event's Democratic contract; p_dem_eve = its quoted mid at 6 PM ET Nov 3 (tools/build_campaign.py); volume from Watchfloor"
    json.dump(R, open(f"{OUT}/data/races.json", "w"), separators=(",", ":"))
    allrows = sorted((row for rows, _ in by.values() for row in rows), key=lambda r: (r["race_id"], r["t"]))
    json.dump({"rows": allrows, "meta": {"inputs": "Midterm_markets raw/candles_1h + candles_1m_linked: QUOTED MIDPOINT of the Democratic contract's YES bid/ask (party event = Watchfloor race_id; contract by Kalshi party id); p_dem null = no two-sided quote (gap), closed=1 = trading closed, not settled yet; hourly from Oct 4, per minute Nov 3 5 PM - Nov 4 11 AM ET, a row only when the value changes; 1/0 at settlement",
               "built_by": "tools/build_campaign.py"}}, open(f"{OUT}/data/race_odds.json", "w"), separators=(",", ":"))
    for key, V in H["views"].items():
        b = bytearray(len(rid_at) * cols)
        for i, rid in enumerate(rid_at):
            b[i * cols:(i + 1) * cols] = bytes(by[rid][1][key])
        V["v"] = base64.b64encode(bytes(b)).decode()
    H["note"] = ("Kalshi QUOTED MIDPOINT of the Democratic contract (party event; no blend with the Republican contract, no last-trade fallback), "
                 "as of each column's right edge. Columns are log-spaced minutes before the anchor (mins[j] .. mins[j+1]). v: one byte per cell, row-major in `races` order, "
                 "0-200 = 0-100%, 253 = trading closed, not settled yet, 254 = open but no two-sided quote in the column (gap), 255 = contract not open yet; 1/0 after settlement. Rebuilt by tools/build_campaign.py; "
                 "row order, upsets, winners and settlement anchors are recomputed from the same contract (tools/build_campaign.py).")
    json.dump(H, open(f"{OUT}/data/heatmap.json", "w"), separators=(",", ":"))
    # summary
    from collections import Counter
    for key in H["views"]:
        c = Counter(x for rid in rid_at for x in by[rid][1][key])
        tot = sum(c.values())
        print(f"heatmap {key}: price {sum(v for k, v in c.items() if k <= 200) / tot:.1%} · gap {c[254] / tot:.1%} · closed, not settled {c[253] / tot:.1%} · not open {c[255] / tot:.1%}")
    print(f"row order: no usable 6 PM quote -> bottom: " + ", ".join(f"{o} {sum(six[rid_at[i]] is None for i in order[o])}" for o in order))
    print(f"upsets {len(H['upsets'])}, headline {sum(u['headline'] for u in H['upsets'])}:")
    for u in H["upsets"]:
        print(f"   {'H' if u['headline'] else '-'} {lab[rid_at[u['i']]]:16s} fav {u['fav']} mid {u['p']:.3f} bid {u['bid']:.3f} ask {u['ask']:.3f} quote {datetime.fromtimestamp(u['t'], timezone.utc):%H:%M} UTC won {J[rid_at[u['i']]][5]}")
    old = json.load(open(f"{OUT}/private/races.lawrence.json"))["rows"]
    diff = [(o["race_id"], o["winner"], o["called_ts"], J[o["race_id"]][5], J[o["race_id"]][4]) for o in old if o["winner"] != J[o["race_id"]][5] or (o["called_ts"] and J[o["race_id"]][4] and abs(o["called_ts"] - J[o["race_id"]][4]) > 1)]
    print("races.json result/settlement changed vs Watchfloor:", diff)
    # control.json: the chamber-control markets on the same definition (Watchfloor's version was a last-trade series before
    # Oct 20 and carried its last mid past trading close); Lawrence's original kept in private/
    NC = json.load(open(f"{OUT}/data/night_control.json"))
    if not os.path.exists(f"{OUT}/private/control.lawrence.json"): shutil.copy(f"{OUT}/data/control.json", f"{OUT}/private/control.lawrence.json")
    ctrl, cser = [], {}
    for e in NC["events"]:
        _, rows, _, _ = one((e["event"], f"{e['event']}-D", None, e["close_ts"], round(e["settle_ts"]) if e["settle_ts"] else None, e["result"]))
        cser[e["event"]] = rows
        ctrl += [{"t": r["t"], "chamber": e["chamber"], "p_dem": r["p_dem"], **({"closed": 1} if r.get("closed") else {})} for r in rows]
    ctrl.sort(key=lambda r: (r["chamber"], r["t"]))
    json.dump({"rows": ctrl, "meta": {"inputs": "Midterm_markets raw/candles_1h + candles_1m_linked: QUOTED MIDPOINT of CONTROLS-2026-D / CONTROLH-2026-D YES bid/ask; p_dem null = no two-sided quote (gap), closed=1 = trading closed, not settled yet; hourly from Oct 4, per minute Nov 3 5 PM - Nov 4 11 AM ET, a row only when the value changes; 1/0 at settlement",
               "built_by": "tools/build_campaign.py"}}, open(f"{OUT}/data/control.json", "w"), separators=(",", ":"))
    print(f"control rows {len(ctrl)} (gap {sum(r['p_dem'] is None and not r.get('closed') for r in ctrl)}, closed markers {sum(1 for r in ctrl if r.get('closed'))})")
    # key moments: the swing titles quote numbers from Watchfloor's old blended series; restate them from the series the page
    # now plots (same moments, same times, same windows). Lawrence's original kept in private/
    if not os.path.exists(f"{OUT}/private/moments.lawrence.json"): shutil.copy(f"{OUT}/data/moments.json", f"{OUT}/private/moments.lawrence.json")
    MO = json.load(open(f"{OUT}/private/moments.lawrence.json"))
    ser = {**{rid: rows for rid, (rows, _) in by.items()}, **cser}
    def at(rid, t):
        s = ser.get(rid) or []
        i = bisect.bisect_right([r["t"] for r in s], t) - 1
        return s[i]["p_dem"] if i >= 0 else None
    fmt = lambda p: f"{p * 100:.1f}%" if p < 0.01 or p > 0.99 else f"{round(p * 100)}%"
    for m in (MO["rows"] if isinstance(MO, dict) else MO):
        g = re.search(r"(\d+)% → (\d+)% (in|over) (\d+) (min|hours?)", m["title"])
        if m["kind"] != "swing" or not g: continue
        dur = int(g.group(4)) * (60 if g.group(5) == "min" else 3600)
        a, b = at(m["race_id"], m["t"] - dur), at(m["race_id"], m["t"])
        span = f"{g.group(3)} {g.group(4)} {g.group(5)}"
        new = (f"{fmt(a)} → {fmt(b)} {span}" if a is not None and b is not None else
               f"to {fmt(b)} {span} (no two-sided quote {g.group(4)} {g.group(5)} earlier)" if b is not None else
               f"from {fmt(a)} over the next {g.group(4)} {g.group(5)} (no two-sided quote at the end)" if a is not None else None)
        old = m["title"]
        m["title"] = old[:g.start()] + new if new else old
        m["metric"] = "quoted mid" if new else "Watchfloor blended price (no quoted mid at either end)"
        if m["title"] != old: print(f"moment {m['id']}: {old}  ->  {m['title']}")
    json.dump(MO, open(f"{OUT}/data/moments.json", "w"), separators=(",", ":"))
    nulls = sum(r["p_dem"] is None for r in allrows)
    print(f"race_odds rows {len(allrows):,} (gap rows {nulls:,}) for {len({r['race_id'] for r in allrows})} races; size {os.path.getsize(f'{OUT}/data/race_odds.json') / 1e6:.1f} MB")


H = None   # set in main() before the pool forks


def one_with_cells(job):
    rid, rows, cell, six = one(job)
    mins, cols = H["mins"], H["cols"]
    out = {}
    for key, V in H["views"].items():
        i = [x["id"] for x in H["races"]].index(rid)
        anchor = V["anchor"] if V.get("anchor") is not None else V["anchors"][i]
        out[key] = [cell(anchor - mins[j] * 60, anchor - mins[j + 1] * 60) for j in range(cols)]
    return rid, rows, out, six


if __name__ == "__main__":
    main()
