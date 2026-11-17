#!/usr/bin/env python3
"""Per-state hourly bets (data/bets_state.json) rebuilt from our raw trades, on the corrected race list.

Watchfloor's file attributed SENATELA-26 (Kalshi's Kentucky Senate market, mislabeled with Louisiana's code) to LA and had
no row for Louisiana's real market KXSENATELA-26NOV. Same definition as Watchfloor's build_site_data.py, reverse-engineered
and checked here: trades in each race's own event (race_id) from data/races.json; hour = UTC hour; usd = what the taker paid
(contracts x price of the side bought); one bet = all fills of the same contract and side at the same millisecond.
Every state other than KY and LA must reproduce Watchfloor's numbers (checked below; the script stops if they don't).
Also: data/kalshi_big.json rows on a race's event get that race_id, so the "Big · all Kalshi" tape can open the race.
Watchfloor's original files are kept in private/*.lawrence.json. Run after tools/build_crosswalk.py.
"""
import gzip, json, os, shutil, sys
from collections import defaultdict
from datetime import datetime
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_campaign import RAW, OUT   # noqa: E402

CHANGED = {"KY", "LA", "KS", "NH"}   # states whose race list build_crosswalk.py corrected (SENATELA-26 is KY; KXSENATELA-26NOV, GOVPARTYKS-27, GOVPARTYNH-28 added)


def one(r):
    out, seen = defaultdict(lambda: [0.0, set()]), set()
    f = f"{RAW}/trades/{r['race_id']}.jsonl.gz"
    if os.path.exists(f):
        for ln in gzip.open(f, "rt"):
            d = json.loads(ln)
            if d["trade_id"] in seen: continue
            seen.add(d["trade_id"])
            t = datetime.fromisoformat(d["created_time"].replace("Z", "+00:00")).timestamp()
            h = int(t // 3600 * 3600)
            if not H0 <= h <= H1: continue
            out[h][0] += float(d["count_fp"]) * float(d["yes_price_dollars"] if d["taker_side"] == "yes" else d["no_price_dollars"])
            out[h][1].add((d["ticker"], d["taker_side"], round(t, 3)))
    return r["state"], {h: (u, len(b)) for h, (u, b) in out.items()}


def main():
    global H0, H1
    orig = f"{OUT}/private/bets_state.lawrence.json"
    if not os.path.exists(orig): shutil.copy(f"{OUT}/data/bets_state.json", orig)
    L = json.load(open(orig))
    H0, H1 = min(r["t"] for r in L["rows"]), max(r["t"] for r in L["rows"])
    races = json.load(open(f"{OUT}/data/races.json"))["rows"]
    with Pool(int(os.environ.get("SLURM_CPUS_PER_TASK", 4))) as pool:
        res = pool.map(one, races, chunksize=4)
    agg = defaultdict(lambda: [0.0, 0])
    for st, hrs in res:
        for h, (u, n) in hrs.items(): agg[(st, h)][0] += u; agg[(st, h)][1] += n
    rows = [{"t": h, "state": st, "usd": round(u, 2), "bets": n} for (st, h), (u, n) in sorted(agg.items(), key=lambda kv: (kv[0][1], kv[0][0])) if n]
    # check: every unaffected state reproduces Watchfloor's file
    old = {(r["state"], r["t"]): (r["usd"], r["bets"]) for r in L["rows"]}
    new = {(r["state"], r["t"]): (r["usd"], r["bets"]) for r in rows}
    keys = {k for k in old | new if k[0] not in CHANGED}
    same = sum(1 for k in keys if k in old and k in new and abs(old[k][0] - new[k][0]) < 0.02 and old[k][1] == new[k][1])
    tot = lambda D, c: sum(v[0] for k, v in D.items() if (k[0] in CHANGED) == c)
    print(f"unaffected states: {same:,} of {len(keys):,} state-hours identical; $ {tot(new, False):,.0f} vs Watchfloor {tot(old, False):,.0f}")
    for st in sorted(CHANGED):
        f = lambda D: sum(v[0] for k, v in D.items() if k[0] == st)
        print(f"   {st}: $ {f(new):,.0f} (Watchfloor {f(old):,.0f})")
    if same < 0.99 * len(keys): sys.exit("unaffected states do not reproduce Watchfloor's file: definition mismatch, not writing")
    L["rows"] = rows
    L.setdefault("meta", {})["inputs"] = ("Kalshi trades, each race's own event (data/races.json race_id); hourly; usd = taker cost; one bet = fills of the same "
                                          "contract and side at the same millisecond. Rebuilt by tools/build_bets_state.py on the corrected race list (SENATELA-26 is Kentucky)")
    L["meta"]["built_by"] = "tools/build_bets_state.py"
    json.dump(L, open(f"{OUT}/data/bets_state.json", "w"), separators=(",", ":"))
    # big bets anywhere on Kalshi: link rows on a race's event to that race
    kb_orig = f"{OUT}/private/kalshi_big.lawrence.json"
    if not os.path.exists(kb_orig): shutil.copy(f"{OUT}/data/kalshi_big.json", kb_orig)
    KB = json.load(open(kb_orig)); rid = {r["race_id"] for r in races}; n = 0
    for b in (KB["rows"] if isinstance(KB, dict) else KB):
        e = b["ticker"].rsplit("-", 1)[0]
        if not b.get("race_id") and e in rid: b["race_id"] = e; n += 1
    json.dump(KB, open(f"{OUT}/data/kalshi_big.json", "w"), separators=(",", ":"))
    print(f"bets_state rows {len(rows):,}; kalshi_big rows linked to a race: {n}")
    # big_bets.json and bets_flow.json are rebuilt from raw by tools/build_market_cards.py (corrected party rule, all 507 races)


if __name__ == "__main__":
    main()
