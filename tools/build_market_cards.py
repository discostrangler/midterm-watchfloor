#!/usr/bin/env python3
"""Market cards, per-day bet files, the largest-bets list and the national bet flow, rebuilt from our raw trades.

Replaces Watchfloor's build_site_data.py outputs (not in the repo) for every midterm race, so that all 507 races
(incl. KXSENATELA-26NOV, GOVPARTYKS-27, GOVPARTYNH-28, which had no card) are built the same way:
  data/race/<id>.json        outcomes (key, party, label, contracts traded), question, days with bets, px (per bin and
                             outcome: last YES price, contracts), rows (per bin: P(D) of the last usable trade, $ backing
                             D / R / other, bets), bets (the race's 150 largest bets priced 3-97c)
  data/trades/<id>/<day>.json one row per bet: [time (s), outcome index, bought YES, avg price paid, contracts, $ paid]
  data/big_bets.json         the 1,500 largest midterm bets priced 3-97c (race events + chamber control + balance of power)
  data/bets_flow.json        national $ per bin backing D / R / other, and bets
Definitions (Watchfloor's, checked below): a bet = all fills of one contract and side at the same millisecond; $ = what
the taker paid; bins are 1 min inside Nov 3 22:00 - Nov 4 16:00 UTC, 10 min otherwise, Oct 4 - Nov 12.
Corrections over Watchfloor: (1) a bin is chosen from the NATIVE fill time (it rounded to the ms first, moving e.g. a
01:31:59.99966 trade into 01:32); (2) "backs D" = YES on D, or NO on R ONLY in a two-way race; in the 15 races with a
third contract a NO bet backs "O", and P(D) comes only from Democratic-contract trades; (3) the universe is the
corrected race list (data/races.json, 507 races).
Validation: --check rebuilds with Watchfloor's rules (its 504-race list, ms-rounded bins, the two-way NO rule) and
compares with its files in private/watchfloor_cards/ (a copy taken on the first run); it must reproduce them.
Run: sbatch tools/build_market_cards.sbatch   (python3 tools/build_market_cards.py [--check])
"""
import csv, gzip, json, math, os, shutil, sys
from decimal import Decimal, ROUND_HALF_UP
from collections import defaultdict
from datetime import datetime, timezone
from multiprocessing import Pool
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_campaign import RAW, OUT   # noqa: E402

ET = ZoneInfo("America/New_York")
C0, C1 = 1791086400, 1794459600                          # Oct 4 04:00 UTC - Nov 12 05:00 UTC (the campaign window)
N0, N1 = 1793743200, 1793808000                          # 1-minute bins inside this window
CTRL = ["CONTROLS-2026", "CONTROLH-2026"]
BOP = "KXBALANCEPOWERCOMBO-27FEB"
CHECK = "--check" in sys.argv
ORIG = f"{OUT}/private/watchfloor_cards"


def tsf(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
def money(x): return float(Decimal(x).quantize(Decimal('0.01'), ROUND_HALF_UP))
def okey(t): s = t.rsplit("-", 1)[-1]; return {"DEM": "D", "GOP": "R"}.get(s, s)   # NC-11's contracts end -DEM / -GOP


def bin_of(t): return (int(t // 60 * 60), 60) if N0 <= t < N1 else (int(t // 600 * 600), 600)


def load_meta():
    side, party, label, ev_of = {}, {}, {}, {}
    for c in csv.DictReader(open(f"{OUT}/crosswalk/race_contracts.tsv"), delimiter="\t"):
        side[c["ticker"]] = c["side"]
        party[c["ticker"]] = c["side"] if c["side"] in ("D", "R") else "I"
        label[c["ticker"]] = c["yes_sub_title"]
    titles = {d["event_ticker"]: d.get("title", "") for d in map(json.loads, open(f"{RAW}/catalog/events.jsonl"))}
    for ln in open(f"{RAW}/catalog/markets.jsonl"):
        if not any(f'"{e}' in ln for e in (BOP, "CONTROLS-2026", "CONTROLH-2026")): continue
        m = json.loads(ln)
        if m["event_ticker"] in CTRL:
            s = m["ticker"].rsplit("-", 1)[-1]; side[m["ticker"]] = s; party[m["ticker"]] = s
            label[m["ticker"]] = {"D": "Democratic Party", "R": "Republican Party"}.get(s, m.get("yes_sub_title"))
        elif m["event_ticker"] == BOP:
            s = m["ticker"].rsplit("-", 1)[-1]; side[m["ticker"]] = s; party[m["ticker"]] = {"DD": "D", "RR": "R"}.get(s, "I")
            label[m["ticker"]] = m.get("yes_sub_title")
    return side, party, label, titles


def backs(e, tk, yes, side, two_way, check):
    """which party a bet backs: YES on a party's contract; NO on the other only in a two-way race"""
    s = side.get(tk, "")
    if e == BOP: return {"DD": "D", "RR": "R"}.get(s, "O") if yes else "O"
    if s not in ("D", "R"): return "O"
    if yes: return s
    return ({"D": "R", "R": "D"}[s]) if (two_way or check) else "O"


def bets_of(e):
    """grouped bets of one event: (first-fill time, ticker, yes, contracts, $ paid)"""
    f = f"{RAW}/trades/{e}.jsonl.gz"
    if not os.path.exists(f): return []
    seen, g = set(), {}
    for ln in gzip.open(f, "rt"):
        d = json.loads(ln)
        if d["trade_id"] in seen: continue
        seen.add(d["trade_id"])
        t, yes = tsf(d["created_time"]), d["taker_side"] == "yes"
        n = Decimal(d["count_fp"]); p = Decimal(d["yes_price_dollars"] if yes else d["no_price_dollars"])
        k = (d["ticker"], yes, round(t, 3))
        x = g.setdefault(k, [t, d["ticker"], yes, Decimal(0), Decimal(0), 0.0, None])
        x[0] = min(x[0], t); x[3] += n; x[4] += n * p
        # the bet's last YES price: the latest fill (several fills in one millisecond at different prices are a genuine tie;
        # any choice is arbitrary, --check verifies that every difference from Watchfloor is such a tie)
        x[6] = (t, float(d["yes_price_dollars"])) if x[6] is None or t >= x[6][0] else x[6]
    for x in g.values(): x[5] = x[4]; x[3], x[4] = float(x[3]), x[4]              # [3] contracts (float), [4] $ paid (Decimal)
    return sorted(g.values(), key=lambda b: b[0])


def card(job):
    e, side, party, label, title, two_way, rid_ok = job
    B = bets_of(e)
    if not B: return e, None, {}, [], []
    tick_vol = defaultdict(float)
    for b in B: tick_vol[b[1]] += b[3]
    tickers = sorted(tick_vol, key=lambda t: -tick_vol[t])
    outs = [{"key": okey(t), "party": party.get(t, "I"), "label": label.get(t, t), "contracts": round(tick_vol[t], 2)} for t in tickers]
    idx = {t: i for i, t in enumerate(tickers)}
    px, rows, days = {}, {}, defaultdict(list)
    usable_for_p = lambda b: (two_way or CHECK) or side.get(b[1]) == "D"
    for b in B:
        t = b[0] if not CHECK else round(b[0], 3)
        if not C0 <= t < C1: continue
        bt, r = bin_of(t)
        k = (bt, idx[b[1]])
        x = px.setdefault(k, [bt, idx[b[1]], 0.0, 0.0, -1])
        if b[6][0] >= x[4]: x[2], x[4] = b[6][1], b[6][0]
        x[3] += b[3]
        row = rows.setdefault(bt, {"t": bt, "r": r, "p": None, "d": 0.0, "rr": 0.0, "o": 0.0, "bets": 0, "_pt": -1})
        if usable_for_p(b) and side.get(b[1]) in ("D", "R") and b[6][0] > row["_pt"]:
            yp = b[6][1]; row["p"] = yp if side[b[1]] == "D" else round(1 - yp, 4); row["_pt"] = b[6][0]
        row[{"D": "d", "R": "rr", "O": "o"}[backs(e, b[1], b[2], side, two_way, CHECK)]] += float(b[4])
        row["bets"] += 1
        day = datetime.fromtimestamp(b[0], ET).date().isoformat()
        days[day].append([math.floor(b[0]), idx[b[1]], 1 if b[2] else 0, round(float(b[4]) / b[3], 3) if b[3] else 0, round(b[3], 2), money(b[4])])   # the second it happened in
    big = []
    for b in B:
        price = float(b[4]) / b[3] if b[3] else 0
        if 0.03 <= round(price, 3) <= 0.97 and C0 <= b[0] < C1:   # Watchfloor's filter: the average price paid, to 0.1c
            big.append({"t": round(b[0], 1), "race_id": e, "backs": backs(e, b[1], b[2], side, two_way, CHECK), "usd": money(b[4]), "n": round(b[3], 2),
                        "price": round(price, 3), "market": party.get(b[1], "I"), "taker": "yes" if b[2] else "no", "k": okey(b[1])})
    big.sort(key=lambda x: -x["usd"])
    doc = {"rows": [{k: (round(v, 2) if k in ("d", "rr", "o") else v) for k, v in r.items() if k != "_pt"} for _, r in sorted(rows.items())],
           "bets": sorted(big[:150], key=lambda x: x["t"]),
           "px": [[x[0], x[1], x[2], round(x[3], 2)] for _, x in sorted(px.items())],
           "days": sorted(days), "question": title, "outcomes": outs,
           "meta": {"inputs": "Kalshi trades for this race's markets: last YES price per outcome per bin (1 min election night, 10 min otherwise)",
                    "built_by": "tools/build_market_cards.py" + (" (Watchfloor-rules check)" if CHECK else "")}}
    flow = defaultdict(lambda: [0.0, 0.0, 0.0, 0])
    if rid_ok:
        for b in B:
            t = b[0] if not CHECK else round(b[0], 3)
            if not C0 <= t < C1: continue
            f = flow[bin_of(t)]; f[{"D": 0, "R": 1, "O": 2}[backs(e, b[1], b[2], side, two_way, CHECK)]] += float(b[4]); f[3] += 1
    return e, doc, dict(days), big[:1500], dict(flow)


def main():
    side, party, label, titles = load_meta()
    races = json.load(open(f"{OUT}/data/races.json"))["rows"]
    if not os.path.isdir(ORIG):                                    # keep Watchfloor's files once, for the check
        os.makedirs(ORIG)
        for f in ["big_bets.json", "bets_flow.json"]:
            src = f"{OUT}/private/{f.replace('.json', '.lawrence.json')}"
            shutil.copy(src if os.path.exists(src) else f"{OUT}/data/{f}", f"{ORIG}/{f}")
        shutil.copytree(f"{OUT}/data/race", f"{ORIG}/race"); shutil.copytree(f"{OUT}/data/trades", f"{ORIG}/trades")
    if CHECK:
        rl = json.load(open(f"{OUT}/private/races.lawrence.json"))["rows"]
        ids = [r["race_id"] for r in rl]
    else:
        ids = [r["race_id"] for r in races]
    third = {c["event"] for c in csv.DictReader(open(f"{OUT}/crosswalk/race_contracts.tsv"), delimiter="\t") if c["side"] not in ("D", "R")}
    jobs = [(e, side, party, label, titles.get(e, e), e not in third, True) for e in ids + CTRL + [BOP]]
    with Pool(int(os.environ.get("SLURM_CPUS_PER_TASK", 4))) as pool:
        res = pool.map(card, jobs, chunksize=2)
    allbig, flow = [], defaultdict(lambda: [0.0, 0.0, 0.0, 0])
    for e, doc, days, big, fl in res:
        allbig += big
        for k, v in fl.items():
            for i in range(4): flow[k][i] += v[i]
    allbig.sort(key=lambda x: -x["usd"]); allbig = allbig[:1500]
    flow_rows = [{"t": t, "r": r, "d": round(v[0], 2), "rr": round(v[1], 2), "o": round(v[2], 2), "bets": v[3]} for (t, r), v in sorted(flow.items())]
    if CHECK: return check(res, allbig, flow_rows)
    # write: cards + day files for every race and control market; the national files
    for e, doc, days, big, fl in res:
        if doc is None: continue
        json.dump(doc, open(f"{OUT}/data/race/{e}.json", "w"), separators=(",", ":"))
        d = f"{OUT}/data/trades/{e}"
        if os.path.isdir(d): shutil.rmtree(d)
        os.makedirs(d)
        for day, rows in days.items():
            json.dump({"rows": rows, "meta": {"inputs": "Kalshi trades for this race, grouped into bets (one taker order each)", "built_by": "tools/build_market_cards.py"}},
                      open(f"{d}/{day}.json", "w"), separators=(",", ":"))
    BB = json.load(open(f"{ORIG}/big_bets.json")); BB["rows"] = sorted(allbig, key=lambda x: x["t"])
    BB["meta"] = {"inputs": "Kalshi trades: the 1,500 largest taker orders priced 3-97 cents in the 507 race markets, chamber control and balance of power; "
                  "backs D/R = YES on that party's contract, or NO on the other's in a two-way race (else O)", "built_by": "tools/build_market_cards.py"}
    json.dump(BB, open(f"{OUT}/data/big_bets.json", "w"), separators=(",", ":"))
    FL = json.load(open(f"{ORIG}/bets_flow.json")); FL["rows"] = flow_rows
    FL["meta"] = {"inputs": "Kalshi trades in the 507 race markets, chamber control and balance of power; taker's cost by the party the bet backs "
                  "(two-way rule as in big_bets; balance of power: only YES on a sweep backs a party); bins from native fill times", "built_by": "tools/build_market_cards.py"}
    json.dump(FL, open(f"{OUT}/data/bets_flow.json", "w"), separators=(",", ":"))
    missing = [e for e in ids if not os.path.exists(f"{OUT}/data/race/{e}.json")]
    old_min = min(b["usd"] for b in json.load(open(f"{ORIG}/big_bets.json"))["rows"])
    print(f"cards written: {sum(1 for r in res if r[1])}; races without a card file: {missing}")
    print(f"big_bets: {len(allbig)} rows, min ${allbig[-1]['usd']:,.2f}; new vs Watchfloor's list (min ${old_min:,.2f}):",
          [(b["race_id"], b["k"], b["taker"], b["usd"]) for b in allbig if b["race_id"] in ("KXSENATELA-26NOV", "GOVPARTYKS-27", "GOVPARTYNH-28")][:6])
    print(f"bets_flow: {len(flow_rows)} bins, ${sum(r['d'] + r['rr'] + r['o'] for r in flow_rows):,.0f}")


TIES = {}


def ties(e):
    """(bin, outcome index) cells whose last fills share one millisecond at different YES prices"""
    f = f"{RAW}/trades/{e}.jsonl.gz"; seen, last = set(), {}
    for ln in gzip.open(f, "rt"):
        d = json.loads(ln)
        if d["trade_id"] in seen: continue
        seen.add(d["trade_id"]); t = round(tsf(d["created_time"]), 3)
        k = (bin_of(t)[0], d["ticker"])
        if k not in last or t > last[k][0]: last[k] = (t, {d["yes_price_dollars"]})
        elif t == last[k][0]: last[k][1].add(d["yes_price_dollars"])
    return {k for k, v in last.items() if len(v[1]) > 1}


def check(res, allbig, flow_rows):
    for e, doc, *_ in res:
        if doc:
            tk = {o["key"]: i for i, o in enumerate(doc["outcomes"])}
            TIES[e] = {(b, okey(t)) for b, t in ties(e)}                      # (bin, outcome key)
    """Watchfloor rules on Watchfloor's race list must reproduce Watchfloor's files"""
    import math
    ok = bad = 0; worst = []
    for e, doc, days, big, fl in res:
        f = f"{ORIG}/race/{e}.json"
        if doc is None or not os.path.exists(f): continue
        o = json.load(open(f))
        # outcome order follows contracts traded, which differ slightly between two pulls: compare by outcome key
        mp = {i: next((j for j, x in enumerate(o["outcomes"]) if x["key"] == oo["key"]), -1) for i, oo in enumerate(doc["outcomes"])}
        doc = {**doc, "px": [[a[0], mp[a[1]], a[2], a[3]] for a in doc["px"]]}
        days = {d: [[r[0], mp[r[1]], *r[2:]] for r in v] for d, v in days.items()}
        po, pn = {(a[0], a[1]): a for a in o["px"]}, {(a[0], a[1]): a for a in doc["px"]}
        bad_px = [k for k in set(po) | set(pn) if not (k in po and k in pn and po[k][3] == pn[k][3] and (abs(po[k][2] - pn[k][2]) < 1e-9 or (k[0], o["outcomes"][k[1]]["key"]) in TIES.get(e, set())))]
        same_px = not bad_px                                  # same bins, same contracts; a price may differ only in a same-ms tie
        same_days = o["days"] == doc["days"]
        n_rows = sum(len(json.load(open(f"{ORIG}/trades/{e}/{d}.json"))["rows"]) for d in o["days"] if os.path.exists(f"{ORIG}/trades/{e}/{d}.json"))
        def eq(a, b):   # same bets: outcome, side, price, contracts exact; time within 1 s; $ within 1c (Watchfloor's float rounding at half cents)
            k = lambda r: (r[1], r[2], r[4], r[0])
            A, B = sorted(a, key=k), sorted(b, key=k)
            return len(A) == len(B) and all(x[1:3] == y[1:3] and x[4] == y[4] and abs(x[3] - y[3]) <= 0.0011 and abs(x[0] - y[0]) <= 1 and abs(x[5] - y[5]) <= 0.0101 for x, y in zip(A, B))
        same_daycount = n_rows == sum(len(v) for v in days.values()) and all(
            eq(json.load(open(f"{ORIG}/trades/{e}/{d}.json"))["rows"], days[d]) for d in o["days"] if d in days)
        if same_px and same_days and same_daycount: ok += 1
        else: bad += 1; worst.append((e, same_px, len(o["px"]), len(doc["px"]), same_days, n_rows, sum(len(v) for v in days.values())))
    print(f"cards reproduced (px prices + days + bets per day): {ok}, differ: {bad}")
    for w in worst[:15]: print("   ", w)
    ob = json.load(open(f"{ORIG}/big_bets.json"))["rows"]
    key = lambda b: (b["race_id"], round(b["t"]), round(b["usd"], 1))
    so, sn = {key(b) for b in ob}, {key(b) for b in allbig}
    print(f"big_bets: Watchfloor {len(so)}, rebuilt {len(sn)}, common {len(so & sn)}; only Watchfloor {sorted(so - sn)[:5]}; only rebuilt {sorted(sn - so)[:5]}")
    of = {(r["t"], r["r"]): r for r in json.load(open(f"{ORIG}/bets_flow.json"))["rows"]}
    nf = {(r["t"], r["r"]): r for r in flow_rows}
    keys = set(of) | set(nf)
    same = sum(1 for k in keys if k in of and k in nf and all(abs(of[k][c] - nf[k][c]) < 0.02 for c in ("d", "rr", "o")) and of[k]["bets"] == nf[k]["bets"])
    tot = lambda D: sum(r["d"] + r["rr"] + r["o"] for r in D.values())
    print(f"bets_flow: {same} of {len(keys)} bins identical; $ rebuilt {tot(nf):,.2f} vs Watchfloor {tot(of):,.2f}")
    diff = [(k, {c: (of.get(k, {}).get(c), nf.get(k, {}).get(c)) for c in ("d", "rr", "o", "bets")}) for k in sorted(keys) if not (k in of and k in nf and all(abs(of[k][c] - nf[k][c]) < 0.02 for c in ("d", "rr", "o")) and of[k]["bets"] == nf[k]["bets"])]
    for d in diff[:8]: print("   ", d)


if __name__ == "__main__":
    main()
