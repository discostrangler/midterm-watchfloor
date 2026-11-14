#!/usr/bin/env python3
"""Race crosswalk (default dashboard event = Watchfloor's race_id, the party event; candidate events are kept as extra events): Watchfloor's race list (data/races.json) vs every 2026 race-winner event in our Kalshi catalog.

Key = (office, state, district, special), cycle 2026. Writes crosswalk/race_crosswalk.tsv (one row per race),
crosswalk/race_contracts.tsv (one row per contract) and prints a summary. Nothing is dropped: ambiguous races
(more than one Kalshi event) keep every event, and races on only one side are listed.
"""
import ast, collections, csv, json, os, re
RAW = os.environ.get("KALSHI_RAW", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "raw"))   # our Kalshi API pull (Midterm_markets/raw)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PATS = [("Senate", re.compile(r"^(?:SENATEPARTY-?|KXSENATE|SENATE)([A-Z]{2})(S?)-(\d\d)$")),
        ("Governor", re.compile(r"^(?:KXGOVPARTY|GOVPARTY|KXGOV)([A-Z]{2})()-(\d\d)$")),
        ("House", re.compile(r"^(?:KXHOUSERACE-|KXHOUSE|HOUSE)([A-Z]{2})(\d+|AL)-(\d\d)$"))]


def key_of(event):
    for office, p in PATS:
        m = p.match(event)
        if m:
            st, x, cyc = m.groups()
            if office == "House": return (office, st, "AL" if x == "AL" else f"{int(x):02d}", False), cyc
            return (office, st, "", x == "S"), cyc
    return None, None


def main():
    linked = {r["ticker"] for r in csv.DictReader(open(f"{RAW}/catalog/linked_tickers.tsv"), delimiter="\t")}
    cov = {r["ticker"]: r for r in csv.DictReader(open(f"{RAW}/coverage.tsv"), delimiter="\t")}
    names = {}
    for ln in open(f"{RAW}/catalog/structured_targets.jsonl"):
        d = json.loads(ln); names[d["id"]] = d.get("name")
    ev = collections.defaultdict(list)                       # event -> contracts
    for ln in open(f"{RAW}/catalog/markets.jsonl"):
        if '"event_ticker": "' not in ln: continue
        e = ln.split('"event_ticker": "', 1)[1].split('"', 1)[0]
        if key_of(e)[0]: ev[e].append(json.loads(ln))
    I = lambda t, f: int(float(cov.get(t, {}).get(f) or 0))
    contracts, events = [], {}
    for e, ms in ev.items():
        k, cyc = key_of(e)
        for m in ms:
            cs = m.get("custom_strike") or {}
            if isinstance(cs, str):
                try: cs = ast.literal_eval(cs)
                except Exception: cs = {}
            suf = m["ticker"].rsplit("-", 1)[-1]
            kind = "party" if suf in ("D", "R") and not cs.get("politician") else "party+candidate" if suf in ("D", "R") else "candidate" if cs.get("politician") else "other"
            night = m["open_time"] < "2026-11-04" and m["close_time"] >= "2026-11-03"
            pn = names.get(cs.get("political_party"), "")
            side = {"Democratic Party": "D", "Republican Party": "R"}.get(pn) or ({"D": "D", "R": "R"}.get(suf) if suf in ("D", "R") else "")
            contracts.append({"office": k[0], "state": k[1], "district": k[2], "special": int(k[3]), "cycle": cyc, "event": e, "ticker": m["ticker"], "side": side, "contract_kind": kind,
                              "yes_sub_title": m.get("yes_sub_title"), "politician": names.get(cs.get("politician"), ""), "party": names.get(cs.get("political_party"), ""),
                              "result": m.get("result"), "status": m.get("status"), "open_time": m["open_time"], "close_time": m["close_time"], "settlement_ts": m.get("settlement_ts") or "",
                              "tradable_election_day": int(night), "in_linked_set": int(m["ticker"] in linked),
                              "minute_quote_rows": I(m["ticker"], "candles_1m_linked_rows"), "hourly_rows": I(m["ticker"], "candles_1h_rows"), "trades": I(m["ticker"], "trades_rows")})
        cs_ = [c for c in contracts if c["event"] == e]
        kinds = sorted({c["contract_kind"] for c in cs_})
        events[e] = {"key": k, "cycle": cyc, "kinds": "+".join(kinds), "n": len(cs_), "night": max(c["tradable_election_day"] for c in cs_), "linked": max(c["in_linked_set"] for c in cs_),
                     "q": sum(c["minute_quote_rows"] for c in cs_), "tr": sum(c["trades"] for c in cs_), "has_DR": int({"D", "R"} <= {c["side"] for c in cs_})}
    wf = json.load(open(f"{OUT}/data/races.json"))["rows"]
    wkey = {}
    for r in wf:
        d = r["district"].split("-")[-1] if r["office"] == "House" else ""
        wkey.setdefault((r["office"], r["state"], d, bool(r["special"])), []).append(r)
    ours = collections.defaultdict(list)
    for e, x in events.items(): ours[(x["key"], x["cycle"])].append(e)
    rows = []
    for k in sorted(set(wkey) | {kk for kk, c in ours if c == "26"}, key=lambda k: (["Senate", "Governor", "House"].index(k[0]), k[1], k[2], k[3])):
        es = sorted(ours.get((k, "26"), []), key=lambda e: -events[e]["tr"]); ws = wkey.get(k, [])
        wid = ws[0]["race_id"] if ws else ""
        status = ("watchfloor_only" if not es else "ours_only" if not ws else "ambiguous_multiple_events" if len(es) > 1 else "matched") + ("" if not ws or not es or wid in es else "|watchfloor_id_not_in_catalog")
        usable = [e for e in es if events[e]["night"] and events[e]["has_DR"] and events[e]["q"] > 0]
        rows.append({"office": k[0], "state": k[1], "district": k[2], "special": int(k[3]), "cycle": "26", "match_status": status,
                     "watchfloor_race_id": wid, "watchfloor_label": ws[0]["label"] if ws else "", "watchfloor_has_odds": int(ws[0]["has_odds"]) if ws else "", "watchfloor_extra_ids": "|".join(w["race_id"] for w in ws[1:]),
                     "kalshi_events": "|".join(es), "event_contract_kinds": "|".join(f"{e}:{events[e]['kinds']}x{events[e]['n']}" for e in es),
                     "tickers": "|".join(c["ticker"] for c in contracts if c["event"] in es),
                     "tradable_election_day": "|".join(str(events[e]["night"]) for e in es), "in_linked_set": "|".join(str(events[e]["linked"]) for e in es),
                     "minute_quote_rows": "|".join(str(events[e]["q"]) for e in es), "trades": "|".join(str(events[e]["tr"]) for e in es),
                     "night_export_ready": int(bool(usable)), "night_export_event": (wid if wid in usable else usable[0]) if usable else "",
                     "note": "" if usable or not es else "settled before election day" if not any(events[e]["night"] for e in es) else "no D and R pair of contracts" if not any(events[e]["has_DR"] for e in es) else "no minute quotes pulled"})
    os.makedirs(f"{OUT}/crosswalk", exist_ok=True)
    for name, data in [("race_crosswalk", rows), ("race_contracts", sorted(contracts, key=lambda c: (c["office"], c["state"], c["district"], c["cycle"], c["ticker"])))]:
        with open(f"{OUT}/crosswalk/{name}.tsv", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(data[0]), delimiter="\t"); w.writeheader(); w.writerows(data)
    C = collections.Counter
    print("watchfloor races", len(wf), "| distinct keys", len(wkey), "| our 2026 race keys", len({k for k, c in ours if c == "26"}), "| our events", len(events), "by cycle", dict(C(x["cycle"] for x in events.values())))
    print("match_status", dict(C(r["match_status"] for r in rows)))
    print("by office x status", dict(C((r["office"], r["match_status"]) for r in rows)))
    print("night_export_ready", dict(C((r["office"], r["night_export_ready"]) for r in rows)), "| notes", dict(C(r["note"] for r in rows if r["note"])))
    print("watchfloor has_odds vs export-ready", dict(C((r["watchfloor_has_odds"], r["night_export_ready"]) for r in rows)))
    for r in rows:
        if r["match_status"] != "matched": print("  ", r["match_status"], r["office"], r["state"], r["district"], "S" if r["special"] else "", "| wf:", r["watchfloor_race_id"], "| ours:", r["event_contract_kinds"], "| ready:", r["night_export_event"])
    print("other-cycle events in catalog:", sorted(e for e, x in events.items() if x["cycle"] != "26" and x["linked"]))
    assert len(rows) == len(set((r["office"], r["state"], r["district"], r["special"]) for r in rows))


if __name__ == "__main__":
    main()
