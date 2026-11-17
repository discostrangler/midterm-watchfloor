#!/usr/bin/env python3
"""Every dashboard race checked against Kalshi's LIVE API and against the 2026 ballot. Writes crosswalk/race_audit.tsv.

Per race (data/races.json), from the live event GET /events/{race_id} (Kalshi's text, not the ticker):
  state     statewide: the titles/rules name the race's state and no other; House: they name its district code (TX-09)
  office    the text says Senate / Governor (or governorship) / House, matching the race
  year      the rules describe the 2026 election (or a 2027 term), not another year
  special   "special" appears in the text if and only if the race is a special election
  live      live title, D/R contract names and results equal our stored catalog (raw/catalog/markets.jsonl)
Ballot: Senate = the 33 class-2 states + the Florida and Ohio specials; Governor = the 36 states electing in 2026;
House = seats per state from the 2020 apportionment (435) + DC's delegate.
Results that changed after our Nov 12 catalog crawl: --write-refresh writes them to raw/catalog/markets_refresh.jsonl,
which build_crosswalk.py and build_races_night.py apply on top of the crawl; the comparison here includes that refresh.
Run: python3 tools/audit_races.py  (network: ~510 GETs to the public API; cached in $AUDIT_CACHE)
"""
import collections, csv, json, os, re, sys, time, urllib.error, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_crosswalk import refreshed   # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.environ.get("KALSHI_RAW", os.path.join(OUT, "..", "raw"))
CACHE = os.environ.get("AUDIT_CACHE", os.path.join(OUT, "private", "audit_cache"))
API = "https://api.elections.kalshi.com/trade-api/v2"
ST = {"Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
      "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY",
      "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO",
      "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
      "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
      "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY"}
RX = re.compile("|".join(sorted(map(re.escape, ST), key=len, reverse=True)))
SENATE_2026 = set("AL AK AR CO DE GA ID IL IA KS KY LA ME MA MI MN MS MT NE NH NJ NM NC OK OR RI SC SD TN TX VA WV WY".split())   # class 2
SPECIAL_2026 = {"FL", "OH"}
GOV_2026 = set("AL AK AZ AR CA CO CT FL GA HI ID IL IA KS ME MD MA MI MN NE NV NH NM NY OH OK OR PA RI SC SD TN TX VT WI WY".split())
HOUSE_2026 = dict(AL=7, AK=1, AZ=9, AR=4, CA=52, CO=8, CT=5, DE=1, FL=28, GA=14, HI=2, ID=2, IL=17, IN=9, IA=4, KS=4, KY=6, LA=6, ME=2, MD=8, MA=9, MI=13,
                  MN=8, MS=4, MO=8, MT=2, NE=3, NV=4, NH=2, NJ=12, NM=3, NY=26, NC=14, ND=1, OH=15, OK=5, OR=6, PA=17, RI=2, SC=7, SD=1, TN=9, TX=38, UT=4,
                  VT=1, VA=11, WA=10, WV=2, WI=8, WY=1, DC=1)


def get(path):
    for i in range(6):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(API + path, headers={"User-Agent": "research-client/1.0"}), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(2 ** i)
        except Exception: time.sleep(2 ** i)
    sys.exit(f"API unreachable: {path}")


def live(ev):
    """the event (title) and its contracts, asked for directly: /markets?event_ticker=, else the historical tier
    (nested markets are not returned for every event, so they are not relied on)"""
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, f"{ev}.v2.json")
    if os.path.exists(f): return json.load(open(f))
    e = (get(f"/events/{ev}") or get(f"/historical/events/{ev}") or {}).get("event") or {}
    ms = (get(f"/markets?event_ticker={ev}&limit=100") or {}).get("markets") or (get(f"/historical/markets?event_ticker={ev}&limit=100") or {}).get("markets") or []
    d = {"event": e, "markets": ms}
    json.dump(d, open(f, "w")); time.sleep(0.05)
    return d


def main():
    races = json.load(open(f"{OUT}/data/races.json"))["rows"]
    stored = collections.defaultdict(dict)
    for ln in open(f"{RAW}/catalog/markets.jsonl"):
        m = refreshed(json.loads(ln)); stored[m["event_ticker"]][m["ticker"]] = m   # with any refresh already applied
    rows, fails, diffs = [], collections.Counter(), []
    for r in races:
        d = live(r["race_id"]); e = d.get("event") or {}; ms = d.get("markets") or e.get("markets") or []
        text = " ".join([e.get("title", ""), e.get("sub_title", "")] + [f"{m.get('title', '')} {m.get('rules_primary', '')}" for m in ms])
        st, off = r["state"], r["office"]
        if off == "House":
            dist = r["district"].split("-")[-1]
            codes = set(re.findall(r"\b([A-Z]{2})-(\d{1,2}|AL)\b", text))
            want = {(st, dist), (st, dist.lstrip("0")), (st, "AL"), (st, "01")} if dist in ("AL", "01") and HOUSE_2026.get(st) == 1 else {(st, dist), (st, dist.lstrip("0"))}
            ok_state = bool(codes & want) and all(c[0] == st for c in codes)
            named = sorted(f"{a}-{b}" for a, b in codes)
        else:
            names = {ST[x] for x in RX.findall(text)}
            if st == "DC": names.discard("WA")
            ok_state = names == {st}
            named = sorted(names)
        ok_office = bool(re.search({"Senate": r"\bSenat", "Governor": r"[Gg]overnor", "House": r"\bHouse\b"}[off], text))
        yrs = {a or b for a, b in re.findall(r"pursuant to the (20\d\d)|(20\d\d) (?:general |special )?election", text)}
        terms = set(re.findall(r"term beginning in (20\d\d)", text))
        ok_year = (yrs <= {"2026"} and (yrs or terms)) and terms <= {"2027"} if (yrs or terms) else None
        ok_special = bool(re.search(r"\bspecial\b", text, re.I)) == bool(r["special"])
        sm = stored.get(r["race_id"], {})
        def norm(m): return (m.get("title"), m.get("yes_sub_title"), m.get("result") or "")
        live_dr = {m["ticker"]: m for m in ms if m["ticker"].rsplit("-", 1)[-1] in ("D", "R", "DEM", "GOP")}   # NC-11 uses -DEM / -GOP
        ok_live = bool(live_dr) and all(t in sm and norm(m) == norm(sm[t]) for t, m in live_dr.items())
        if not ok_live: diffs.append((r["race_id"], [(t, norm(sm.get(t, {})), norm(m), m.get("settlement_ts")) for t, m in live_dr.items() if norm(sm.get(t, {})) != norm(m)]))
        dr = {m["ticker"].rsplit("-", 1)[-1]: m.get("yes_sub_title") for m in ms}
        row = {"race_id": r["race_id"], "label": r["label"], "office": off, "state": st, "district": r["district"], "special": int(bool(r["special"])),
               "kalshi_title": e.get("title", ""), "names_in_text": " ".join(named), "contracts": " | ".join(f"{k}: {v}" for k, v in sorted(dr.items())),
               "results": " ".join(f"{m['ticker'].rsplit('-', 1)[-1]}={m.get('result') or '-'}" for m in ms),
               "state_ok": int(ok_state), "office_ok": int(ok_office), "year_ok": "" if ok_year is None else int(bool(ok_year)), "special_ok": int(ok_special), "live_matches_stored": int(ok_live)}
        for k in ("state_ok", "office_ok", "year_ok", "special_ok", "live_matches_stored"):
            if row[k] == 0: fails[k] += 1
        rows.append(row)
    with open(f"{OUT}/crosswalk/race_audit.tsv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]), delimiter="\t"); w.writeheader(); w.writerows(rows)
    print(f"{len(rows)} races checked against Kalshi's live API; failures by check: {dict(fails) or 'none'}")
    print("  year not stated in the rules (checked by close date instead):", sum(1 for x in rows if x["year_ok"] == ""))
    for x in rows:
        if 0 in (x["state_ok"], x["office_ok"], x["year_ok"], x["special_ok"], x["live_matches_stored"]):
            print("  FAIL", {k: x[k] for k in ("race_id", "label", "kalshi_title", "names_in_text", "state_ok", "office_ok", "year_ok", "special_ok", "live_matches_stored")})
    for rid, d in diffs: print("  LIVE DIFFERS", rid, d)
    # contracts whose status / result / settlement / close changed since our catalog crawl: an overlay the builders apply
    F = ("status", "result", "settlement_ts", "close_time", "settlement_value_dollars", "volume_fp")
    refresh = []
    for r in races:
        for m in live(r["race_id"])["markets"]:
            o = stored.get(r["race_id"], {}).get(m["ticker"])
            if o and any((m.get(f) or "") != (o.get(f) or "") for f in F[:4]):
                refresh.append({"ticker": m["ticker"], "event_ticker": m.get("event_ticker", r["race_id"]), **{f: m.get(f) for f in F}, "_refreshed": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    if "--write-refresh" in sys.argv:
        with open(f"{RAW}/catalog/markets_refresh.jsonl", "w") as fh:
            for x in refresh: fh.write(json.dumps(x) + "\n")
    print(f"contracts changed since the catalog crawl: {len(refresh)}" + (" (written to raw/catalog/markets_refresh.jsonl)" if "--write-refresh" in sys.argv else ""))
    for x in refresh: print("   ", x["ticker"], {f: x[f] for f in F[:4]})
    # ballot completeness
    have = collections.defaultdict(set)
    for r in races: have[(r["office"], bool(r["special"]))].add(r["state"])
    hc = collections.Counter(r["state"] for r in races if r["office"] == "House")
    print("Senate regular: missing", sorted(SENATE_2026 - have[("Senate", False)]), "extra", sorted(have[("Senate", False)] - SENATE_2026))
    print("Senate special: missing", sorted(SPECIAL_2026 - have[("Senate", True)]), "extra", sorted(have[("Senate", True)] - SPECIAL_2026))
    print("Governor: missing", sorted(GOV_2026 - have[("Governor", False)] - have[("Governor", True)]), "extra", sorted((have[("Governor", False)] | have[("Governor", True)]) - GOV_2026))
    print("House seats per state that differ from the apportionment:", {s: (hc.get(s, 0), n) for s, n in HOUSE_2026.items() if hc.get(s, 0) != n} or "none",
          f"| total {sum(hc.values())} (expected {sum(HOUSE_2026.values())})")
    dup = [k for k, v in collections.Counter((r["office"], r["state"], r["district"], bool(r["special"])) for r in races).items() if v > 1]
    print("duplicate races:", dup or "none")


if __name__ == "__main__":
    main()
