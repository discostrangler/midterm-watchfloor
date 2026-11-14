#!/usr/bin/env python3
"""Election-night control view: our Kalshi pull + Subhrajit's stream data on one clock.

Public  -> data/night_control.json          minute bid/ask/last per control contract, close + settlement marks, stream clock checks
           (individual races: tools/build_races_night.py)
           data/night_trades/<event>.json   every trade (exact execution time), deduped on trade_id
Private -> private/night_private.json       transcripts + sampled chat text (git-ignored; third-party content, never publish)

Each source keeps its own clock meaning: quotes at candle END, trades at execution, transcript = stream start + video offset,
chat = YouTube's own wall-clock send time (timestampUsec).
Usage: python3 tools/build_night.py   (paths below; run as a SLURM job, the chat files are 212 MB)
"""
import gzip, json, os, random
from datetime import datetime, timezone

RAW = os.environ.get("KALSHI_RAW", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "raw"))   # our Kalshi API pull (Midterm_markets/raw)
SUB = os.environ.get("STREAMS_WINDOW", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "kalshis_eye", "data", "window"))   # Subhrajit's kalshis_eye data/window
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
A = int(datetime(2026, 11, 3, 23, tzinfo=timezone.utc).timestamp())   # Nov 3 6 PM ET
B = int(datetime(2026, 11, 4, 13, tzinfo=timezone.utc).timestamp())   # Nov 4 8 AM ET
EVENTS = [("CONTROLS-2026", "Senate"), ("CONTROLH-2026", "House")]
CHAT_PER_MIN = 12
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
f = lambda d, k: float(d[k]) if d and d.get(k) is not None else None


def catalog(events):
    """event -> {ticker: market record} from our catalog."""
    out = {e: {} for e in events}
    with open(f"{RAW}/catalog/markets.jsonl") as fh:
        for ln in fh:
            if any(e in ln for e in events):
                d = json.loads(ln)
                if d["event_ticker"] in out: out[d["event_ticker"]][d["ticker"]] = d
    return out


def quotes(event):
    n = (B - A) // 60
    q = {}
    for ln in gzip.open(f"{RAW}/candles_1m_linked/{event}.jsonl.gz", "rt"):
        c = json.loads(ln); i = (c["end_period_ts"] - A) // 60 - 1      # bin i ends at A + (i+1)*60
        if not 0 <= i < n: continue
        s = q.setdefault(c["ticker"][-1], {k: [None] * n for k in ("bid", "ask", "last", "lo", "hi", "vol")})
        p = c.get("price") or {}
        s["bid"][i], s["ask"][i] = f(c.get("yes_bid"), "close_dollars"), f(c.get("yes_ask"), "close_dollars")
        s["last"][i], s["lo"][i], s["hi"][i] = f(p, "close_dollars"), f(p, "low_dollars"), f(p, "high_dollars")
        s["vol"][i] = round(float(c.get("volume_fp") or 0), 2)
    return q


def trades(event):
    seen, rows = set(), []
    for ln in gzip.open(f"{RAW}/trades/{event}.jsonl.gz", "rt"):
        d = json.loads(ln)
        if d["trade_id"] in seen: continue          # a trade near the archive cutoff is served by both tiers
        seen.add(d["trade_id"]); t = ts(d["created_time"])
        if A <= t <= B:
            if d["ticker"][-2:] not in ("-D", "-R"): continue
            rows.append([t, 0 if d["ticker"].endswith("-D") else 1, int(d["taker_side"] == "yes"),
                         float(d["yes_price_dollars"]), round(float(d["count_fp"]), 2)])
    rows.sort(key=lambda r: r[0])               # exact execution order; ties keep file order
    for r in rows: r[0] = round(r[0], 6)
    return rows


def chat_msgs(vid):
    """(wall_clock_s, video_offset_s, text) per message; wall clock is YouTube's timestampUsec."""
    p = f"{SUB}/chat/{vid}.live_chat.json"
    if not os.path.exists(p): return
    for ln in open(p, encoding="utf-8", errors="ignore"):
        try: a = json.loads(ln).get("replayChatItemAction", {})
        except json.JSONDecodeError: continue
        off = a.get("videoOffsetTimeMsec")
        for act in a.get("actions", []):
            it = act.get("addChatItemAction", {}).get("item", {})
            r = it.get("liveChatTextMessageRenderer") or it.get("liveChatPaidMessageRenderer")
            if r and off is not None and r.get("timestampUsec"):
                txt = "".join(x.get("text", "") for x in r.get("message", {}).get("runs", []))
                yield int(r["timestampUsec"]) / 1e6, int(off) / 1000, txt


def streams():
    random.seed(0)
    pub, tx, chat = [], {}, {}
    for name, lean, plat, vid, url in json.load(open(f"{SUB}/items.json")):
        info = json.load(open(f"{SUB}/meta/{vid}.info.json"))
        start = info.get("release_timestamp") or info.get("timestamp")
        msgs = list(chat_msgs(vid))
        d = sorted(w - o for w, o, _ in msgs)
        off = round(d[len(d) // 2] - start) if d else None           # chat-derived start minus the start we use
        clock = "upload" if not info.get("was_live") else "chat-verified" if off is not None and abs(off) <= 60 else "unverified"
        pub.append({"stream_id": vid, "streamer": name, "lean": lean, "start": start, "dur": info.get("duration"),
                    "clock": clock, "chat_minus_start_s": off, "chat_msgs": len(msgs)})
        tp = f"{SUB}/transcripts/{vid}.json"
        if os.path.exists(tp):
            tx[vid] = [[round(start + s["start"], 1), round(start + s["end"], 1), s["text"]] for s in json.load(open(tp))["segments"] if s["text"]]
        per = {}
        for w, _, txt in msgs:
            if A <= w <= B and txt: per.setdefault(int(w // 60), []).append([round(w, 1), txt[:200]])
        if per: chat[vid] = sorted(m for ms in per.values() for m in random.sample(ms, min(CHAT_PER_MIN, len(ms))))
    return pub, tx, chat


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(obj, open(path, "w"), separators=(",", ":"))
    print(f"wrote {os.path.relpath(path, OUT)} {os.path.getsize(path) / 1e6:.2f} MB", flush=True)


def export(e, label, cat):
    """Quotes + marks for one event (D and R contracts), and its trade file."""
    m = cat[e].get(f"{e}-D")
    if not m or f"{e}-R" not in cat[e]: return None
    c, s = round(ts(m["close_time"])), round(ts(m["settlement_ts"])) if m.get("settlement_ts") else None
    q = {k: v for k, v in quotes(e).items() if k in "DR"}
    n = (B - A) // 60
    for v in q.values():                       # no quote can be observed after trading stops
        for i in range(n):
            if A + (i + 1) * 60 > c: v["bid"][i] = v["ask"][i] = None
    return {"event": e, "label": label, "close_ts": c, "settle_ts": s, "result": {"yes": "D", "no": "R"}.get(m.get("result"), ""), "quotes": q}


def write_trades(e):
    dump(f"{OUT}/data/night_trades/{e}.json", {"rows": trades(e), "meta": {"fields": ["t (execution, UTC s)", "outcome 0=D 1=R", "taker bought YES=1/NO=0", "yes price $", "contracts"],
         "inputs": "Midterm_markets raw/trades, deduped on trade_id", "built_by": "tools/build_night.py"}})


QMETA = {"quotes": "arrays hold one value per minute; value i is the candle ENDING at window[0] + (i+1)*60. bid/ask = best YES quote observed at candle end; last/lo/hi = trades inside the minute (null = none). bid/ask are the book as observed (bid 0 or ask 1 = one-sided, no two-sided quote); null = no candle that minute (the last observed book stands) or after trading stops",
         "marks": "close_ts = contract close_time (trading stops; Kalshi rules allow accelerated determination on a consensus of media projections); settle_ts = settlement_ts. Neither is a media call time",
         "price": "all prices are for the DEMOCRATIC contract's YES side; nothing is blended with the Republican contract",
         "built_by": "tools/build_night.py", "inputs": "Midterm_markets raw/candles_1m_linked + catalog"}


def main():
    cat = catalog([e for e, _ in EVENTS])
    evs, marks = [], []
    for e, chamber in EVENTS:
        ev = export(e, f"{chamber} control", cat); ev["chamber"] = chamber; evs.append(ev)
        marks += [{"t": ev["close_ts"], "kind": "close", "label": f"{chamber} control: Kalshi stops trading"}, {"t": ev["settle_ts"], "kind": "settle", "label": f"{chamber} control: Kalshi settles"}]
        write_trades(e)
    pub, tx, chat = streams()
    dump(f"{OUT}/data/night_control.json", {"window": [A, B], "step": 60, "events": evs, "marks": sorted(marks, key=lambda x: x["t"]), "streams": pub,
         "meta": QMETA | {"streams": "clock: chat-verified = YouTube chat send times agree with start + video offset within 60 s; unverified = no chat on disk to check; upload = not a live stream, start is the upload time. chat_minus_start_s is measured and NOT applied: transcripts are placed at start + video offset",
                          "inputs": "Midterm_markets raw/candles_1m_linked + catalog; kalsi_palantir stream metadata and chat timing (no text)"}})
    dump(f"{OUT}/private/night_private.json", {"transcripts": tx, "chat": chat,
         "meta": {"PRIVATE": "third-party content for private research; never commit or publish", "transcripts": "[start, end, text], wall clock = stream start + video offset (Whisper large-v3-turbo)",
                  "chat": f"[wall clock (YouTube timestampUsec), text], sampled to {CHAT_PER_MIN}/min, no authors"}})
    assert all(len(v["bid"]) == (B - A) // 60 for e in evs for v in e["quotes"].values())
    assert all(e["quotes"]["D"]["bid"][0] is not None for e in evs), "no quote in the first minute?"
    assert all(v["bid"][i] is None for e in evs for v in e["quotes"].values() for i in range(len(v["bid"])) if A + (i + 1) * 60 > e["close_ts"])


if __name__ == "__main__":
    main()
