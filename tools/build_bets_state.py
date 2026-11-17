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
    fix_party_labels(races)


def fix_party_labels(races):
    """Watchfloor's rule "a bet backs D when it buys YES on D or NO on R" only holds in a two-way race. 15 races also
    list an independent / other contract (SENATENE-26-DOSB Osborn, SENATEID-26-TACH Achilles, ...): there a NO bet is
    against one side, not for the other. big_bets.json: such NO bets -> backs "O". bets_flow.json (national flow):
    those NO bets move from d / rr to o, and the three 2026 races Watchfloor's list lacked (KXSENATELA-26NOV,
    GOVPARTYKS-27, GOVPARTYNH-28) are added with the same rule, trade by trade, into the existing bins."""
    import csv
    rc = list(csv.DictReader(open(f"{OUT}/crosswalk/race_contracts.tsv"), delimiter="\t"))
    rid = {r["race_id"] for r in races}
    third = {c["event"] for c in rc if c["event"] in rid and c["side"] not in ("D", "R")}
    side = {c["ticker"]: c["side"] for c in rc}
    # big bets
    orig = f"{OUT}/private/big_bets.lawrence.json"
    if not os.path.exists(orig): shutil.copy(f"{OUT}/data/big_bets.json", orig)
    BB = json.load(open(orig)); n = 0
    for b in BB["rows"]:
        if b["race_id"] in third and b["taker"] == "no" and b["backs"] in ("D", "R"): b["backs"] = "O"; n += 1
    BB.setdefault("meta", {})["party_rule"] = "backs D/R = YES on that party's contract, or NO on the other's in a two-way race; in the 15 races with a third contract a NO bet backs O"
    json.dump(BB, open(f"{OUT}/data/big_bets.json", "w"), separators=(",", ":"))
    print(f"big_bets: {n} NO bets in three-way races relabeled O")
    # national flow
    orig = f"{OUT}/private/bets_flow.lawrence.json"
    if not os.path.exists(orig): shutil.copy(f"{OUT}/data/bets_flow.json", orig)
    FL = json.load(open(orig)); bins = {r["t"]: r for r in FL["rows"]}
    N0, N1 = 1793743200, 1793808000                       # 1-minute bins inside the election-night detail window
    def row(t):
        b = int(t // 60 * 60) if N0 <= t < N1 else int(t // 600 * 600)
        return bins.get(b) or bins.setdefault(b, {"t": b, "r": 60 if N0 <= t < N1 else 600, "d": 0.0, "rr": 0.0, "o": 0.0, "bets": 0})
    moved, added, t0, t1 = 0.0, 0.0, min(bins), max(r["t"] + r["r"] for r in bins.values())
    for e in sorted(third | {"KXSENATELA-26NOV", "GOVPARTYKS-27", "GOVPARTYNH-28"}):
        new = e in ("KXSENATELA-26NOV", "GOVPARTYKS-27", "GOVPARTYNH-28")
        seen, orders = set(), set()
        for ln in gzip.open(f"{RAW}/trades/{e}.jsonl.gz", "rt"):
            d = json.loads(ln)
            if d["trade_id"] in seen: continue
            seen.add(d["trade_id"])
            t = datetime.fromisoformat(d["created_time"].replace("Z", "+00:00")).timestamp()
            if not t0 <= t < t1: continue
            sd, yes = side.get(d["ticker"], ""), d["taker_side"] == "yes"
            usd = float(d["count_fp"]) * float(d["yes_price_dollars"] if yes else d["no_price_dollars"])
            r = row(t)
            if new:                                       # missing race: add it (two-way: NO on one party backs the other)
                k = ("d" if (sd == "D") == yes else "rr") if sd in ("D", "R") else "o"
                r[k] += usd; added += usd
                o = (d["ticker"], d["taker_side"], round(t, 3))
                if o not in orders: orders.add(o); r["bets"] += 1
            elif sd in ("D", "R") and not yes:            # three-way race: this NO bet was credited to the other party
                r["rr" if sd == "D" else "d"] -= usd; r["o"] += usd; moved += usd
    FL["rows"] = [{**r, "d": round(r["d"], 2), "rr": round(r["rr"], 2), "o": round(r["o"], 2)} for _, r in sorted(bins.items())]
    FL["meta"]["corrections"] = ("tools/build_bets_state.py: NO bets in the 15 three-way races moved from d/rr to o; "
                                 "KXSENATELA-26NOV, GOVPARTYKS-27, GOVPARTYNH-28 added (missing from Watchfloor's race list)")
    json.dump(FL, open(f"{OUT}/data/bets_flow.json", "w"), separators=(",", ":"))
    print(f"bets_flow: ${moved:,.0f} of NO bets in three-way races moved to other; ${added:,.0f} of the three added races")


if __name__ == "__main__":
    main()
