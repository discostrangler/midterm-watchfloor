#!/usr/bin/env python3
"""Polls and Kalshi on one daily timeline, per race and nationally: data/polls_kalshi/<ST>.json + US.json.

POLLS (Subhrajit's collect/polls_full.py output, read-only; POLLS_FULL = its data/polls/full directory):
  nominee head-to-heads only: general-election polls that name BOTH actual nominees (names from our catalog's D/R
  contracts of the race's Kalshi events), from Wikipedia race pages (wikipedia_long.parquet) and VoteHub
  (votehub_polls.parquet, us-senator / governor / us-representative). The same poll found in both sources (same race,
  pollster, field end within a day) is kept once, with VoteHub's `created` date. National: VoteHub generic-ballot polls
  (likely voters preferred over registered over adults when a pollster published several for the same dates).
  Each poll: field END date (earliest it could be public) and, for VoteHub polls, the date VoteHub ADDED it (latest
  bound on its release; median 5 days after the end date).
KALSHI (our pull, Midterm_markets/raw):
  every trade in every Kalshi event of the race (crosswalk/race_crosswalk.tsv kalshi_events: party + candidate events),
  per ET day: trades and dollars (what the taker paid: contracts x the price of the side bought). National: the two
  chamber-control markets. Daily quoted mid of the Democratic contract of the party event at the end of each ET day
  (same definition as data/race_odds.json; null = one-sided book; stops at trading close; 1/0 after settlement).
Days are ET calendar days numbered from DAY0 = Nov 5 2024 (the day after the 2024 election) to Nov 12 2026.
Run: sbatch tools/build_polls_kalshi.sbatch (needs pandas + pyarrow).
"""
import bisect, csv, gzip, json, os, re, sys, unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from multiprocessing import Pool
from zoneinfo import ZoneInfo

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_campaign import RAW, OUT, quotes, ts   # noqa: E402  same quote reader and raw paths as race_odds

POLLS = os.environ["POLLS_FULL"]
ET = ZoneInfo("America/New_York")
DAY0, DAY1 = date(2024, 11, 5), date(2026, 11, 12)
NDAYS = (DAY1 - DAY0).days + 1
dayof = lambda d: (d - DAY0).days                                           # date -> day index
day_end = lambda i: datetime.combine(DAY0 + timedelta(days=i + 1), datetime.min.time(), ET).timestamp()   # midnight ET ending day i
OFFICE = {"senate": "Senate", "gov": "Governor", "house": "House"}


def norm(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s).strip()


def last(name):
    toks = [t for t in norm(name).split() if t not in ("jr", "sr", "ii", "iii", "iv")]
    return toks[-1] if toks else ""


STOP = {"the", "of", "and", "university", "college", "research", "polling", "poll", "polls", "strategies", "group", "inc", "llc", "associates", "insights", "analytics", "public", "opinion"}
pkey = lambda p: next((t for t in norm(re.sub(r"\(.*?\)", "", str(p))).split() if t not in STOP), norm(p)[:8])


def races():
    """race_id -> key, label pieces, Kalshi events, D/R nominee last names, D contract of the party event."""
    R = {}
    for r in csv.DictReader(open(f"{OUT}/crosswalk/race_crosswalk.tsv"), delimiter="\t"):
        if not r["watchfloor_race_id"]: continue
        dist = 1 if r["district"] == "AL" else int(r["district"]) if r["district"] else None
        R[r["watchfloor_race_id"]] = {"office": r["office"], "state": r["state"], "dist": dist, "special": r["special"] == "1",
                                      "events": [e for e in re.split(r"[|;,]", r["kalshi_events"]) if e], "D": set(), "R": set(), "dtk": None}
    ev2race = {e: rid for rid, x in R.items() for e in x["events"]}
    for c in csv.DictReader(open(f"{OUT}/crosswalk/race_contracts.tsv"), delimiter="\t"):
        rid = ev2race.get(c["event"])
        if not rid or c["side"] not in ("D", "R"): continue
        nm = c["politician"] or ("" if re.search(r"party", c["yes_sub_title"], re.I) else c["yes_sub_title"])
        if nm and last(nm): R[rid][c["side"]].add(last(nm))
        if c["event"] == rid and c["side"] == "D":
            R[rid]["dtk"] = (c["ticker"], ts(c["close_time"]), ts(c["settlement_ts"]), {"yes": "D", "no": "R"}.get(c["result"], ""))
    return R


def find_race(R, office, state, dist, names):
    """the race this poll belongs to: same office/state(/district); several (regular + special): the one whose nominees it names."""
    cands = [rid for rid, x in R.items() if x["office"] == office and x["state"] == state and (office != "House" or x["dist"] == dist)]
    if len(cands) > 1: cands = [rid for rid in cands if any(R[rid]["D"] & names) and any(R[rid]["R"] & names)] or cands
    return cands[0] if len(cands) == 1 else None


def nsample(v):
    """people polled: VoteHub's number, or Wikipedia's text such as '1,000 (LV)'; None when missing or zero"""
    if v is None or (isinstance(v, float) and v != v): return None
    m = re.search(r"\d[\d,]*", str(v))
    n = int(m.group(0).replace(",", "")) if m else 0
    return n or None


def polls(R):
    out = defaultdict(list)
    # Wikipedia: one row per poll x candidate column; a head-to-head = a general-election poll with both nominee columns
    w = pd.read_parquet(f"{POLLS}/wikipedia_long.parquet")
    w = w[w.stage.eq("general")]
    for pid, g in w.groupby("poll_id"):
        r0 = g.iloc[0]
        dist = int(r0.dist) if r0.kind == "house" and str(r0.dist).isdigit() else None
        cols = {last(c): (c, p) for c, p in zip(g.candidate, g.pct)}
        rid = find_race(R, OFFICE[r0.kind], r0.state, dist, set(cols))
        if not rid: continue
        d = next((p for c, p in zip(g.candidate, g.pct) if any(n and n in norm(c).split() for n in R[rid]["D"])), None)
        rr = next((p for c, p in zip(g.candidate, g.pct) if any(n and n in norm(c).split() for n in R[rid]["R"])), None)
        if d is None or rr is None or pd.isna(r0.end): continue
        tag = re.search(r"\((D|R)\)", str(r0.pollster))
        out[rid].append({"end": r0.end.date(), "created": None, "D": float(d), "R": float(rr), "pollster": re.sub(r"\s*\((D|R)\)\s*$", "", str(r0.pollster)).strip(),
                         "partisan": tag.group(1) if tag else "", "src": "wikipedia", "url": "", "n": nsample(r0["sample"])})
    n_wiki = sum(len(v) for v in out.values())
    # VoteHub: answers are candidate names; senator/governor subject "2026 <State>", house seat_name "<ST>-<NN>"
    st_of = {"Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL",
             "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME",
             "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
             "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
             "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
             "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY"}
    v = pd.read_parquet(f"{POLLS}/votehub_polls.parquet")
    v = v[v.end.notna() & (v.end.dt.date >= DAY0)]
    n_vh, merged, gen = 0, 0, []
    for _, p in v.iterrows():
        ans = json.loads(p.answers or "[]")
        if p.poll_type == "generic-ballot":
            a = {x.get("choice"): x.get("pct") for x in ans}
            if a.get("Dem") is not None and a.get("Rep") is not None:
                gen.append({"end": p.end.date(), "created": p.created.date() if pd.notna(p.created) else None, "D": float(a["Dem"]), "R": float(a["Rep"]),
                            "pollster": str(p.pollster), "partisan": {"DEM": "D", "REP": "R"}.get(str(p.partisan), ""), "src": "votehub", "url": p.url or "", "pop": str(p.population or ""),
                            "n": nsample(p.sample_size)})
            continue
        if p.poll_type not in ("us-senator", "governor", "us-representative"): continue
        names = {last(x.get("choice", "")) for x in ans}
        if p.poll_type == "us-representative":
            m = re.match(r"([A-Z]{2})-(\d+|AL)$", str(p.seat_name or ""))
            if not m: continue
            rid = find_race(R, "House", m.group(1), 1 if m.group(2) == "AL" else int(m.group(2)), names)
        else:
            m = re.match(r"2026 (.+)$", str(p.subject or ""))
            if not m or m.group(1) not in st_of: continue                      # "2026 Texas Republican" etc. = primaries
            rid = find_race(R, "Senate" if p.poll_type == "us-senator" else "Governor", st_of[m.group(1)], None, names)
        if not rid: continue
        d = next((x["pct"] for x in ans if last(x.get("choice", "")) in R[rid]["D"]), None)
        rr = next((x["pct"] for x in ans if last(x.get("choice", "")) in R[rid]["R"]), None)
        if d is None or rr is None: continue
        n_vh += 1
        row = {"end": p.end.date(), "created": p.created.date() if pd.notna(p.created) else None, "D": float(d), "R": float(rr), "pollster": str(p.pollster),
               "partisan": {"DEM": "D", "REP": "R"}.get(str(p.partisan), ""), "src": "votehub", "url": p.url or "", "n": nsample(p.sample_size)}
        twin = next((q for q in out[rid] if q["src"] == "wikipedia" and pkey(q["pollster"]) == pkey(row["pollster"]) and abs((q["end"] - row["end"]).days) <= 1), None)
        if twin: out[rid].remove(twin); row["src"] = "both"; row["partisan"] = row["partisan"] or twin["partisan"]; row["n"] = row["n"] or twin["n"]; merged += 1
        out[rid].append(row)
    # generic ballot: one version per pollster and dates (LV > RV > A)
    rank = {"lv": 0, "rv": 1, "a": 2}
    best = {}
    for g in gen:
        k = (pkey(g["pollster"]), g["end"])
        if k not in best or rank.get(g["pop"], 3) < rank.get(best[k]["pop"], 3): best[k] = g
    print(f"polls: wikipedia head-to-heads {n_wiki}, votehub head-to-heads {n_vh} ({merged} also on Wikipedia, kept once); "
          f"{sum(len(v) for v in out.values())} polls in {len(out)} races; generic ballot {len(best)} (of {len(gen)} rows)", flush=True)
    return out, sorted(best.values(), key=lambda g: g["end"])


def kalshi(job):
    """daily trades / dollars over the race's events, and the daily end-of-day quoted mid of its D contract"""
    rid, events, dtk = job
    n, usd, seen = defaultdict(int), defaultdict(float), set()
    for e in events:
        f = f"{RAW}/trades/{e}.jsonl.gz"
        if not os.path.exists(f): continue
        for ln in gzip.open(f, "rt"):
            d = json.loads(ln)
            if d["trade_id"] in seen: continue
            seen.add(d["trade_id"])
            day = datetime.fromisoformat(d["created_time"].replace("Z", "+00:00")).astimezone(ET).date()
            if not DAY0 <= day <= DAY1: continue
            i = dayof(day)
            n[i] += 1
            usd[i] += float(d["count_fp"]) * float(d["yes_price_dollars"] if d["taker_side"] == "yes" else d["no_price_dollars"])
    mid = []
    if dtk:
        tk, close, settle, result = dtk
        q = {**quotes(f"{RAW}/candles_1h/{rid}.jsonl.gz", tk), **quotes(f"{RAW}/candles_1m_linked/{rid}.jsonl.gz", tk)}
        ends = sorted(q)
        last_v = "x"
        for i in range(NDAYS):
            T = day_end(i)
            if settle and T >= settle: v = 1.0 if result == "D" else 0.0 if result == "R" else None
            elif close and T >= close: v = "closed"
            else:
                j = bisect.bisect_right(ends, T) - 1
                if j < 0: continue                                         # not quoted yet
                v = q[ends[j]][0] if q[ends[j]] else None
            if v != last_v: mid.append([i, v]); last_v = v                 # change-only, like race_odds
    days = sorted(n)
    return rid, {"k": [[i, n[i], round(usd[i])] for i in days], "mid": mid}


def prow(p):
    return [dayof(p["end"]), dayof(p["created"]) if p["created"] and p["created"] >= DAY0 else None, p["D"], p["R"], p["pollster"],
            {"wikipedia": 0, "votehub": 1, "both": 2}[p["src"]], p["partisan"], p["n"]]


def main():
    R = races()
    P, G = polls(R)
    jobs = [(rid, x["events"], x["dtk"]) for rid, x in R.items()]
    jobs += [("CONTROLS-2026", ["CONTROLS-2026"], None), ("CONTROLH-2026", ["CONTROLH-2026"], None)]
    nc = {e["event"]: e for e in json.load(open(f"{OUT}/data/night_control.json"))["events"]}
    jobs = [(rid, ev, dtk if rid not in nc else (f"{rid}-D", nc[rid]["close_ts"], nc[rid]["settle_ts"], nc[rid]["result"])) for rid, ev, dtk in jobs]
    with Pool(int(os.environ.get("SLURM_CPUS_PER_TASK", 4))) as pool:
        K = dict(pool.map(kalshi, jobs, chunksize=2))
    meta = {"day0": DAY0.isoformat(), "days": NDAYS, "poll_row": ["end_day", "added_day (VoteHub; null = Wikipedia only)", "D %", "R %", "pollster", "source 0=Wikipedia 1=VoteHub 2=both", "partisan sponsor D/R", "sample size (null = not published)"],
            "k_row": ["day", "trades", "dollars (taker cost)"], "mid": "[day, quoted mid of the D contract at the end of the ET day] change-only; null = one-sided book; 'closed' = trading closed, not settled",
            "built_by": "tools/build_polls_kalshi.py", "polls_from": "Subhrajit's collect/polls_full.py (Wikipedia CC BY-SA 4.0, VoteHub CC BY 4.0)"}
    os.makedirs(f"{OUT}/data/polls_kalshi", exist_ok=True)
    by_st = defaultdict(dict)
    for rid, x in R.items():
        by_st[x["state"]][rid] = {"polls": [prow(p) for p in sorted(P.get(rid, []), key=lambda p: p["end"])], **K[rid]}
    for st, races_ in by_st.items():
        json.dump({"races": races_, "meta": meta}, open(f"{OUT}/data/polls_kalshi/{st}.json", "w"), separators=(",", ":"))
    us = {"polls": [prow(p) + [p["pop"]] for p in G], "markets": {rid: K[rid] for rid in nc}}
    json.dump({"us": us, "meta": {**meta, "poll_row": meta["poll_row"] + ["population lv/rv/a"], "polls": "VoteHub generic ballot (national)"}},
              open(f"{OUT}/data/polls_kalshi/US.json", "w"), separators=(",", ":"))
    # summary
    withp = [rid for rid in R if P.get(rid)]
    print(f"races with head-to-head polls: {len(withp)} of {len(R)}; polls {sum(len(P[r]) for r in withp)}; with an added date "
          f"{sum(1 for r in withp for p in P[r] if p['created'])}; with a sample size {sum(1 for r in withp for p in P[r] if p['n'])}; generic with a sample size {sum(1 for g in G if g['n'])} of {len(G)}")
    print(f"Kalshi: {sum(len(K[r]['k']) for r in K)} race-days with trades, {sum(t[1] for r in K for t in K[r]['k']):,} trades, ${sum(t[2] for r in K for t in K[r]['k']):,.0f}")
    top = sorted(withp, key=lambda r: -len(P[r]))[:8]
    for r in top: print(f"   {r:24s} polls {len(P[r]):3d}  first {min(p['end'] for p in P[r])}  trades {sum(t[1] for t in K[r]['k']):,}")
    size = sum(os.path.getsize(f"{OUT}/data/polls_kalshi/{f}") for f in os.listdir(f"{OUT}/data/polls_kalshi"))
    print(f"wrote data/polls_kalshi/: {len(by_st)} state files + US.json, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
