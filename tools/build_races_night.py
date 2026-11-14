#!/usr/bin/env python3
"""Election-night export for every Watchfloor race (504), from our raw Kalshi pull.

For each race in data/races.json, the event is the Watchfloor race_id (the party event; candidate events stay in
crosswalk/race_contracts.tsv only). The Democratic and Republican contracts are found by Kalshi's own party id in
`custom_strike.political_party` (the structured target "Democratic Party" / "Republican Party"), falling back to the
ticker suffix -D / -R. This is what maps NC-11 (KXHOUSENC11-26-DEM / -GOP).

Window: Nov 3 6 PM - Nov 4 8 AM ET. Quotes: Democratic contract only, best YES bid/ask observed at each 1-minute candle
END; every minute after the contract's trading close are null. Trades: every trade on the
D and R contracts at its exact execution time, deduped on trade_id.

Writes  data/night_races.json            index: race_id -> state shard, label, status, coverage counts
        data/night_state/<ST>.json        all races of one state: quotes + trades + close/settlement marks
        crosswalk/night_coverage.tsv      one row per race: quote minutes, trades, first/last observations
Run:    sbatch tools/build_races_night.sbatch
"""
import ast, csv, gzip, json, os, statistics, sys
from collections import defaultdict
from datetime import datetime, timezone
from multiprocessing import Pool

RAW = os.environ.get("KALSHI_RAW", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "raw"))   # our Kalshi API pull (Midterm_markets/raw)
OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
A = int(datetime(2026, 11, 3, 23, tzinfo=timezone.utc).timestamp())   # Nov 3 6 PM ET
B = int(datetime(2026, 11, 4, 13, tzinfo=timezone.utc).timestamp())   # Nov 4 8 AM ET
N = (B - A) // 60
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None
et = lambda t: datetime.fromtimestamp(t, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S") if t else ""
PARTY = {}   # political_party uuid -> "D" | "R"


def et_str(t):
    if not t: return ""
    from zoneinfo import ZoneInfo
    d = datetime.fromtimestamp(t, ZoneInfo("America/New_York"))
    return d.strftime("%b %d %I:%M:%S %p" + ("" if d.year == 2026 else ", %Y")).replace(" 0", " ")


def side_of(m):
    cs = m.get("custom_strike") or {}
    if isinstance(cs, str):
        try: cs = ast.literal_eval(cs)
        except Exception: cs = {}
    p = PARTY.get(cs.get("political_party"))
    suf = m["ticker"].rsplit("-", 1)[-1]
    s = {"D": "D", "R": "R"}.get(suf)
    if p and s and p != s: raise ValueError(f"{m['ticker']}: party id says {p}, suffix says {s}")
    return (p, "party_id") if p else (s, "suffix") if s else (None, None)


def one(job):
    race, ms = job
    e = race["race_id"]
    sides, src = {}, set()
    for m in ms:
        s, how = side_of(m)
        if s:
            if s in sides: raise ValueError(f"{e}: two {s} contracts")
            sides[s] = m; src.add(how)
    dm = sides.get("D") or next(iter(sides.values()), None)
    close = round(ts(dm["close_time"])) if dm else None
    opened = round(ts(dm["open_time"])) if dm else None
    open_min = max(0, (min(B, close or B) - max(A, opened or A)) // 60) if dm else 0   # minutes of the window the D contract was trading
    settle = round(ts(dm.get("settlement_ts"))) if dm and dm.get("settlement_ts") else None
    result = ""
    if "D" in sides and sides["D"].get("result") in ("yes", "no"): result = "D" if sides["D"]["result"] == "yes" else "R"
    elif "R" in sides and sides["R"].get("result") in ("yes", "no"): result = "R" if sides["R"]["result"] == "yes" else "D"
    q = {k: [None] * N for k in ("bid", "ask", "last")}
    qR, seed = 0, None                     # seed: the D book last observed at or before the window start
    tk = {m["ticker"]: s for s, m in sides.items()}
    two = lambda b, a: b is not None and a is not None and b > 0 and a < 1      # two-sided: a real bid AND a real ask
    cf = f"{RAW}/candles_1m_linked/{e}.jsonl.gz"
    if os.path.exists(cf) and tk:
        for ln in gzip.open(cf, "rt"):
            c = json.loads(ln); s = tk.get(c["ticker"]); end = c["end_period_ts"]; i = (end - A) // 60 - 1
            b, a = (c.get("yes_bid") or {}).get("close_dollars"), (c.get("yes_ask") or {}).get("close_dollars")
            b, a = (None if b is None else float(b)), (None if a is None else float(a))
            if s == "D" and i < 0 and b is not None and a is not None and (seed is None or end > seed[0]): seed = (end, b, a)
            if s is None or not 0 <= i < N or (close is not None and end > close): continue   # no quotes after trading close
            if s == "R":
                qR += two(b, a); continue
            if b is not None and a is not None: q["bid"][i], q["ask"][i] = b, a          # observed book, one-sided kept as is
            p = (c.get("price") or {}).get("close_dollars")
            if p is not None: q["last"][i] = float(p)
    trades, seen = [], set()
    tf = f"{RAW}/trades/{e}.jsonl.gz"
    if os.path.exists(tf) and tk:
        for ln in gzip.open(tf, "rt"):
            d = json.loads(ln); s = tk.get(d["ticker"])
            if s is None or d["trade_id"] in seen: continue
            seen.add(d["trade_id"]); t = ts(d["created_time"])
            if A <= t <= B: trades.append([t, 0 if s == "D" else 1, int(d["taker_side"] == "yes"), float(d["yes_price_dollars"]), round(float(d["count_fp"]), 2)])
    trades.sort(key=lambda r: r[0])
    for r in trades: r[0] = round(r[0], 6)
    qi = [i for i in range(N) if two(q["bid"][i], q["ask"][i])]            # minutes with a candle showing a two-sided book
    spreads = [q["ask"][i] - q["bid"][i] for i in qi]
    # quote in effect: Kalshi omits candles for quiet minutes, so the last observed book stands until the next candle
    cur, car, car10, ages = (seed[1:] if seed else None), 0, 0, []
    cur_t = seed[0] if seed else None
    lo_, hi_ = max(A, opened or A), min(B, close or B)
    for i in range(N):
        end = A + (i + 1) * 60
        if q["bid"][i] is not None: cur, cur_t = (q["bid"][i], q["ask"][i]), end
        if lo_ < end <= hi_ and cur and two(*cur):
            car += 1; car10 += cur[1] - cur[0] <= 0.10 + 1e-9; ages.append((end - cur_t) / 60)   # age of the book carried forward
    status = ("no D/R contracts" if not tk else "settled before window" if settle and settle < A else
              "closed before window" if close and close < A else "closed in window" if close and close <= B else "open after window")
    cov = {"race_id": e, "label": race["label"], "office": race["office"], "state": race["state"], "district": race["district"], "special": int(race["special"]),
           "D_ticker": sides["D"]["ticker"] if "D" in sides else "", "R_ticker": sides["R"]["ticker"] if "R" in sides else "", "side_source": "+".join(sorted(src)),
           "window_status": status, "result": result, "close_et": et_str(close), "settle_et": et_str(settle),
           "open_minutes": open_min, "D_two_sided_minutes": len(qi), "D_two_sided_le10c_minutes": sum(1 for x in spreads if x <= 0.10 + 1e-9),
           "D_carried_forward_two_sided_minutes": car, "D_carried_forward_le10c_minutes": car10,
           "observed_quote_coverage": round(len(qi) / open_min, 3) if open_min else "",
           "observed_quote_coverage_le10c": round(sum(1 for x in spreads if x <= 0.10 + 1e-9) / open_min, 3) if open_min else "",
           "carried_forward_quote_coverage": round(car / open_min, 3) if open_min else "",
           "carried_forward_quote_coverage_le10c": round(car10 / open_min, 3) if open_min else "",
           "quote_age_median_min": round(statistics.median(ages), 1) if ages else "", "quote_age_p90_min": round(sorted(ages)[int(0.9 * (len(ages) - 1))], 1) if ages else "",
           "quote_age_max_min": round(max(ages), 1) if ages else "",
           "R_two_sided_minutes": qR,
           "D_median_spread_c": round(100 * statistics.median(spreads), 1) if spreads else "",
           "D_first_quote_et": et_str(A + (qi[0] + 1) * 60) if qi else "", "D_last_quote_et": et_str(A + (qi[-1] + 1) * 60) if qi else "",
           "minutes_with_trade_D": sum(1 for v in q["last"] if v is not None), "trades_in_window": len(trades), "contracts_in_window": round(sum(r[4] for r in trades)),
           "first_trade_et": et_str(trades[0][0]) if trades else "", "last_trade_et": et_str(trades[-1][0]) if trades else ""}
    exp = {"open_minutes": open_min, "event": e, "label": race["label"], "office": race["office"], "state": race["state"], "district": race["district"], "special": race["special"],
           "close_ts": close, "settle_ts": settle, "result": result, "status": status, "sides": {s: m["ticker"] for s, m in sides.items()},
           "quotes": {"D": q}, "trades": trades}
    return race["state"], cov, exp


def main():
    for ln in open(f"{RAW}/catalog/structured_targets.jsonl"):
        d = json.loads(ln)
        if d.get("type") == "political_party": PARTY[d["id"]] = {"Democratic Party": "D", "Republican Party": "R"}.get(d.get("name"))
    races = json.load(open(f"{OUT}/data/races.json"))["rows"]
    want = {r["race_id"] for r in races}
    ms = defaultdict(list)
    for ln in open(f"{RAW}/catalog/markets.jsonl"):
        if '"event_ticker": "' not in ln: continue
        e = ln.split('"event_ticker": "', 1)[1].split('"', 1)[0]
        if e in want: ms[e].append(json.loads(ln))
    missing = sorted(want - set(ms))
    with Pool(int(os.environ.get("SLURM_CPUS_PER_TASK", 4)), initializer=PARTY.update, initargs=(dict(PARTY),)) as pool:
        res = pool.map(one, [(r, ms[r["race_id"]]) for r in races], chunksize=4)
    shards, covs = defaultdict(dict), []
    for st, cov, exp in res: shards[st][exp["event"]] = exp; covs.append(cov)
    os.makedirs(f"{OUT}/data/night_state", exist_ok=True)
    meta = {"window": [A, B], "step": 60,
            "quotes": "Democratic contract only. quotes.D.bid/ask[i] = best YES quote observed at the END of the candle ending at window[0] + (i+1)*60; the book in the candle as observed, so bid 0 or ask 1 = one-sided book (no two-sided quote); null = no candle that minute (Kalshi omits quiet minutes: the last observed book stands) or after trading close. last[i] = last trade inside that minute",
            "trades": "[exact execution time UTC s, 0 = D contract / 1 = R contract, taker bought YES = 1 / NO = 0, YES price $, contracts]",
            "marks": "close_ts = Kalshi trading close (close_time); settle_ts = Kalshi settlement (settlement_ts). Neither is a media call",
            "sides": "D/R contract found by Kalshi political_party id, else ticker suffix -D/-R",
            "inputs": "Midterm_markets raw/catalog, candles_1m_linked, trades", "built_by": "tools/build_races_night.py"}
    for st, d in shards.items():
        json.dump({"races": d, "meta": meta}, open(f"{OUT}/data/night_state/{st}.json", "w"), separators=(",", ":"))
    X = {x["event"]: x for d in shards.values() for x in d.values()}
    idx = {c["race_id"]: {"state": c["state"], "label": c["label"], "status": c["window_status"], "quote_minutes": c["D_carried_forward_two_sided_minutes"], "open_minutes": c["open_minutes"],
                          "trades": c["trades_in_window"], "close_ts": X[c["race_id"]]["close_ts"], "settle_ts": X[c["race_id"]]["settle_ts"], "result": X[c["race_id"]]["result"]} for c in covs}
    json.dump({"races": idx, "meta": meta | {"index": "race_id -> shard data/night_state/<state>.json; status and coverage counts"}}, open(f"{OUT}/data/night_races.json", "w"), separators=(",", ":"))
    os.makedirs(f"{OUT}/crosswalk", exist_ok=True)
    with open(f"{OUT}/crosswalk/night_coverage.tsv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(covs[0]), delimiter="\t"); w.writeheader(); w.writerows(covs)
    # summary
    from collections import Counter
    n = len(covs)
    print(f"races {n} (denominator = Watchfloor's 504) | events missing from catalog: {missing}")
    print("side source", dict(Counter(c["side_source"] for c in covs)))
    print("window status", dict(Counter(c["window_status"] for c in covs)))
    op = [c for c in covs if c["open_minutes"]]
    for f in ("observed_quote_coverage", "observed_quote_coverage_le10c", "carried_forward_quote_coverage", "carried_forward_quote_coverage_le10c"):
        print(f"  {f}: " + ", ".join(f">={x:.0%} {sum(c[f] >= x for c in op)}" for x in (0.25, 0.5, 0.9)) + f" (of {len(op)} races open in the window)")
    for lo, lab in [(1, ">=1"), (60, ">=60"), (420, ">=420 (half the window)")]:
        print(f"  D two-sided quote minutes {lab}: {sum(c['D_two_sided_minutes'] >= lo for c in covs)}")
    print(f"  any trade in window: {sum(c['trades_in_window'] > 0 for c in covs)} | trades total {sum(c['trades_in_window'] for c in covs):,}")
    print(f"  export candidates (D and R contracts, >=1 two-sided quote minute and >=1 trade in window): "
          f"{sum(bool(c['D_ticker'] and c['R_ticker']) and c['D_two_sided_minutes'] > 0 and c['trades_in_window'] > 0 for c in covs)}")
    for c in covs:
        if c["race_id"] in ("KXHOUSENC11-26", "GOVPARTYCA-26", "KXGOVPARTYAK-26", "KXHOUSERACE-DCAL-26", "KXHOUSERACE-CA37-26", "SENATETX-26", "KXHOUSERACE-NC03-26") or c["window_status"] in ("settled before window", "closed before window", "no D/R contracts"):
            print("  ", {k: c[k] for k in ("race_id", "side_source", "window_status", "result", "close_et", "settle_et", "D_two_sided_minutes", "D_median_spread_c", "trades_in_window", "D_first_quote_et", "D_last_quote_et")})
    for c in covs:
        if (c["D_two_sided_minutes"] > 0) != (c["trades_in_window"] > 0):
            print("   quotes XOR trades:", {k: c[k] for k in ("race_id", "window_status", "close_et", "D_two_sided_minutes", "D_median_spread_c", "trades_in_window", "minutes_with_trade_D")})
    sizes = sorted(((os.path.getsize(f"{OUT}/data/night_state/{s}.json"), s) for s in shards), reverse=True)
    print(f"shards {len(shards)}, total {sum(x for x, _ in sizes) / 1e6:.1f} MB, largest {[(s, round(x / 1e6, 1)) for x, s in sizes[:4]]}")


if __name__ == "__main__":
    main()
