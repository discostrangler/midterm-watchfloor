"""Final walkthrough of every dashboard view, headless. Runs twice: PUBLIC (private/ blocked, as on GitHub Pages)
and PRIVATE (with private/night_private.json). Prints PASS/FAIL per step and saves screenshots.
Usage: walkthrough.py <out_dir>"""
import functools, http.server, os, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_port}/index.html"
fails = 0


def run(mode):
    global fails
    errs, res = [], []
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 1000})
        if mode == "public": pg.route("**/private/**", lambda r: r.fulfill(status=404, body="not published"))
        pg.on("pageerror", lambda e: errs.append(f"pageerror {e}"))
        pg.on("response", lambda r: r.status >= 400 and "/private/" not in r.url and errs.append(f"HTTP {r.status} {r.url}"))
        pg.goto(BASE); pg.wait_for_timeout(9000)
        ev = pg.evaluate
        txt = lambda sel: pg.locator(sel).first.inner_text()
        def check(name, ok, info=""):
            global fails
            fails += not ok; print(f"  [{mode}] {'PASS' if ok else 'FAIL'} {name}{' · ' + info if info else ''}", flush=True)
        setT = "t => { const s = document.getElementById('wf-scrub'); s.value = t; s.dispatchEvent(new Event('input')); }"
        pick = "id => { const s = document.getElementById('wf-race-select'); s.value = id; s.dispatchEvent(new Event('change')); }"
        # header, credits, reading strip
        check("credits in header", "Lawrence Lu" in txt(".wf-credit") and "Subhrajit" in txt(".wf-credit"))
        check("reading strip", "%" in txt("[data-draw=kpi-sen]"), f"Senate {txt('[data-draw=kpi-sen]')} · House {txt('[data-draw=kpi-house]')} · settled {txt('[data-draw=kpi-called]')} of {txt('[data-draw=kpi-total]')}")
        # map layers and offices
        for layer in ["races", "bets", "social", "gas", "rain", "turnout"]:
            pg.click(f"[data-layer={layer}]"); pg.wait_for_timeout(500)
            n = pg.locator("path.wf-st").count()
            check(f"map layer {layer}", n >= 50, f"{n} states drawn")
        pg.click("[data-layer=races]")
        for office in ["Governor", "House", "Senate"]:
            pg.click(f"[data-office={office}]"); pg.wait_for_timeout(400)
        pg.screenshot(path=f"{out}/{mode}_01_top.png")
        # time windows and lanes
        for rk in ["week", "campaign", "night"]:
            pg.click(f"[data-range={rk}]"); pg.wait_for_timeout(1200)
            check(f"timeline window {rk}", pg.locator(".wf-lanes-svg path").count() > 10)
        # state panel via map click
        ev(setT, 1793754360); pg.wait_for_timeout(500)
        pg.locator('path.wf-st[aria-label^="Texas:"]').click(force=True); pg.wait_for_timeout(1500)
        check("map click -> state panel", txt("[data-draw=st-name]") == "Texas", txt("[data-draw=st-races]").replace("\n", " ")[:120])
        # hourly bins that run past the cursor are labelled as full hours (Kentucky at 6:18 PM ET, Nov 3)
        ev(setT, 1793747880); pg.locator('path.wf-st[aria-label^="Kentucky:"]').click(force=True); pg.wait_for_timeout(1200)
        kb, ks = txt("[data-draw=st-bets]"), txt("[data-draw=st-social]")
        check("state panel labels full-hour bins", "6:00 PM–7:00 PM ET, full hour" in kb and ("full hour" in ks or "no count" in ks or "No state" in ks), f"{kb[:90]} | {ks[:90]}")
        ev(setT, 1793754360); pg.wait_for_timeout(500)   # back to 8:26 PM for the checks below
        # market card + trades tape
        ev(pick, "SENATETX-26"); pg.wait_for_timeout(2500)
        head = txt("[data-draw=mkt-head]")
        check("market card labels last trade + quoted mid", "last trade" in head and "Quoted midpoint" in head, txt("[data-draw=mkt-vol]"))
        for tape in ["market", "mid", "all"]:
            pg.click(f"[data-tape={tape}]"); pg.wait_for_timeout(1500)
            check(f"trades tape {tape}", pg.locator("[data-draw=tape] li").count() > 1)
        pg.click("[data-tape=market]")
        # night panel: quotes, trades, on air
        pg.wait_for_timeout(1500)
        cards = pg.locator(".wf-nt-card").count(); links = pg.locator(".wf-nt-links a").count(); tx = pg.locator(".wf-nt-tx").count()
        check("night panel rows (2 control + TX Senate)", cards == 3)
        check("on air: original-stream links + chat counts", links >= 4 and "messages in the minute to" in txt("[data-nt=air]"), f"{links} links, e.g. {pg.locator('.wf-nt-links a').first.get_attribute('href')}")
        if mode == "public": check("public build shows no transcript or chat text", tx == 0 and pg.locator(".wf-nt-chat").count() == 0)
        else: check("private build shows transcripts", tx > 0, f"{tx} transcript lines")
        pg.locator(".wf-night").screenshot(path=f"{out}/{mode}_02_night.png")
        # heatmap, upsets, selection link
        for hv in ["nov10", "settle"]:
            pg.click(f"[data-heat={hv}]"); pg.wait_for_timeout(1200)
            check(f"heatmap view {hv}", "Quoted midpoint" in txt(".wf-heat-note"))
        chips = pg.locator(".wf-heat-chip"); first = chips.first.inner_text()
        chips.first.click(); pg.wait_for_timeout(2000)
        check("upset chip opens race (card + night panel)", ev("WF.race") != "SENATETX-26" and pg.locator(".wf-nt-card").count() == 3, f"{chips.count()} chips; first '{first}' -> {ev('WF.race')}")
        pg.locator(".wf-heat").screenshot(path=f"{out}/{mode}_03_heatmap.png")
        # early-settled race and key moments
        ev(pick, "KXHOUSERACE-CA37-26"); pg.wait_for_timeout(1500)
        check("CA-37: settled status, no file request", "settled for Democrats, Jun 30" in txt("[data-draw=mkt-vol]"))
        moms = pg.locator("[data-draw=moments] li.wf-feed-i").count()
        if moms: pg.locator("[data-draw=moments] li.wf-feed-i").first.click(); pg.wait_for_timeout(1200)
        check("key moments", moms > 0, f"{moms} listed; detail: {txt('.wf-mom-title')[:80]}")
        for tab in ["before", "after", "night"]:
            pg.click(f"[data-mperiod={tab}]"); pg.wait_for_timeout(400)
        # play
        pg.click("[data-play-btn]"); t0 = ev("WF.t"); pg.wait_for_timeout(1500); pg.click("[data-play-btn]")
        check("play advances the cursor", ev("WF.t") > t0)
        pg.screenshot(path=f"{out}/{mode}_04_full.png", full_page=True)
        b.close()
    check("no page errors / failed requests", not errs, "; ".join(errs[:5]))


for mode in ["public", "private"]:
    for attempt in range(4):             # the headless shell sometimes dies on this page; retry
        try: run(mode); break
        except Exception as e: print(f"  [{mode}] retry: {str(e)[:150]}", flush=True)
srv.shutdown()
print("WALKTHROUGH", "PASSED" if not fails else f"{fails} FAILED")
