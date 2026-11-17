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
        pg.route("**/data/race/KXHOUSERACE-NC02-26.json", lambda r: r.fulfill(status=404, body="missing"))   # a copy without this file
        mi_down = {"on": True}                                                                                    # MI's poll/Kalshi file fails until "restored"
        pg.route("**/data/polls_kalshi/MI.json", lambda r: r.fulfill(status=503, body="down") if mi_down["on"] else r.continue_())
        pg.route("**/data/trades/SENATETX-26/2026-11-02.json", lambda r: r.fulfill(status=503, body="down"))   # one trade day fails
        pg.on("pageerror", lambda e: errs.append(f"pageerror {e}"))
        # errors that dash.draw catches and logs (a failed resource is already counted by the response listener)
        pg.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and errs.append(f"console {m.text[:160]}"))
        pg.on("response", lambda r: r.status >= 400 and "/private/" not in r.url and "KXHOUSERACE-NC02-26.json" not in r.url and "data/race/KXSENATELA-26NOV.json" not in r.url and "polls_kalshi/MI.json" not in r.url and "SENATETX-26/2026-11-02" not in r.url and errs.append(f"HTTP {r.status} {r.url}"))
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
        # Kalshi's SENATELA-26 is the Kentucky Senate race (mislabeled ticker); Louisiana's is KXSENATELA-26NOV
        ev(pick, "SENATELA-26"); pg.wait_for_timeout(1200)
        check("SENATELA-26 is shown as Kentucky's Senate race", txt("[data-draw=st-name]") == "Kentucky" and "Senate" in txt("[data-draw=st-races]"), txt("[data-draw=st-races]").replace("\n", " ")[:90])
        ev(pick, "KXSENATELA-26NOV"); pg.wait_for_timeout(1500)
        check("KXSENATELA-26NOV is Louisiana's Senate race, with a night card", txt("[data-draw=st-name]") == "Louisiana" and pg.locator(".wf-nt-card").count() == 3
              and "LA Senate" in txt("[data-pk=sub]"), txt("[data-draw=st-races]").replace("\n", " ")[:90])
        ev(pick, "SENATETX-26")
        # hourly bins that run past the cursor are labelled as full hours (Kentucky at 6:18 PM ET, Nov 3)
        ev(setT, 1793747880); pg.locator('path.wf-st[aria-label^="Kentucky:"]').click(force=True); pg.wait_for_timeout(1200)
        kb, ks = txt("[data-draw=st-bets]"), txt("[data-draw=st-social]")
        check("state panel labels full-hour bins", "6:00 PM–7:00 PM ET, full hour" in kb and ("full hour" in ks or "no count" in ks or "No state" in ks), f"{kb[:90]} | {ks[:90]}")
        ev(setT, 1793754360); pg.wait_for_timeout(500)   # back to 8:26 PM for the checks below
        # market card + trades tape
        ev(pick, "SENATETX-26"); pg.wait_for_timeout(2500)
        head = txt("[data-draw=mkt-head]")
        check("market card labels last trade + quoted mid", "last trade" in head and "Quoted midpoint" in head, txt("[data-draw=mkt-vol]"))
        pg.click("[data-range=week]"); ev(setT, 1793682060); pg.wait_for_timeout(2500)   # 12:01 AM Nov 3: the list reaches back into the failed Nov 2 file
        check("failed trade day is announced under the tape", "did not load" in txt("[data-draw=tape-sub]") and "2026-11-02" in txt("[data-draw=tape-sub]"), txt("[data-draw=tape-sub]")[:110])
        pg.click("[data-range=night]"); ev(setT, 1793754360); pg.wait_for_timeout(1500)
        for tape in ["market", "mid", "all"]:
            pg.click(f"[data-tape={tape}]"); pg.wait_for_timeout(1500)
            check(f"trades tape {tape}", pg.locator("[data-draw=tape] li").count() > 1)
        pg.click("[data-tape=market]")
        # audit fixes: no look-ahead on the card; closed is its own state; moments land on settled; stock note follows the cursor
        ev(setT, 1793754120); pg.wait_for_timeout(800)          # 8:02 PM: the 8:01 minute ended at 83c; the 8:02 minute (90.8c) has not
        check("market card shows no trade after the cursor", "83%" in txt("[data-draw=mkt-head]"), txt("[data-draw=mkt-head]").split("\n")[0])
        ev(setT, 1793768460); pg.wait_for_timeout(500)          # 12:01 AM: Senate trading closed 11:46 PM, settled 12:46 AM
        check("control tile: closed, not a stale quote", txt("[data-draw=kpi-sen]") == "closed", txt("[data-draw=kpi-sen]"))
        ev(setT, 1793754000); pg.wait_for_timeout(500)          # 8 PM ET
        s8 = pg.locator(".wf-lanes-svg text", has_text="Kalshi-implied S&P").first.text_content()
        ev(setT, 1793761200); pg.wait_for_timeout(500)          # 10 PM ET
        s10 = pg.locator(".wf-lanes-svg text", has_text="Kalshi-implied S&P").first.text_content()
        check("stock note follows the cursor", s8 != s10 and "−0.2%" in s8, f"8 PM: {s8[-30:]} | 10 PM: {s10[-30:]}")
        ev(pick, "GOVPARTYCA-26"); ev(setT, 1793765340); pg.wait_for_timeout(1500)   # 11:09 PM: CA Governor closed 11:08 PM
        check("state panel: CA Governor closed, no carried quote", "trading closed" in txt("[data-draw=st-races]"), txt("[data-draw=st-races]").replace("\n", " ")[:120])
        pg.click("[data-mperiod=night]"); pg.wait_for_timeout(400)
        pg.locator("[data-draw=moments] li.wf-feed-i", has_text="TX Senate settles").first.click(); pg.wait_for_timeout(1500)
        check("settlement moment lands on settled", "Kalshi settled for" in txt("[data-draw=mkt-vol]"), txt("[data-draw=mkt-vol]")[:100])
        ev(pick, "SENATETX-26"); ev(setT, 1793754360); pg.wait_for_timeout(1500)
        # night panel: quotes, trades, on air
        pg.wait_for_timeout(1500)
        cards = pg.locator(".wf-nt-card").count(); links = pg.locator(".wf-nt-links a").count(); tx = pg.locator(".wf-nt-tx").count()
        check("night panel rows (2 control + TX Senate)", cards == 3)
        check("on air: original-stream links + chat counts", links >= 4 and "messages in the minute to" in txt("[data-nt=air]"), f"{links} links, e.g. {pg.locator('.wf-nt-links a').first.get_attribute('href')}")
        if mode == "public": check("public build shows no transcript or chat text", tx == 0 and pg.locator(".wf-nt-chat").count() == 0)
        else: check("private build shows transcripts", tx > 0, f"{tx} transcript lines")
        pg.locator(".wf-night").screenshot(path=f"{out}/{mode}_02_night.png")
        # polls vs Kalshi: TX Senate polls + trades on one timeline; added-date toggle; national view for control
        pg.wait_for_timeout(1500)
        npolls = pg.locator(".wf-pk svg circle").count(); rd = txt("[data-pk=read]")
        check("polls vs Kalshi panel: TX Senate polls and trades", npolls > 10 and "Kalshi trades" in rd and "TX Senate, up to" in rd, f"{npolls} polls drawn; {rd[:140]}")
        pg.click("[data-pkmode=added]"); pg.wait_for_timeout(800)
        check("poll date toggle: added to VoteHub", "added" in txt("[data-pk=read]") or "hidden" in txt("[data-pk=sub]"), txt("[data-pk=sub]")[:140])
        pg.click("[data-pkmode=end]")
        pg.locator(".wf-pk").screenshot(path=f"{out}/{mode}_02b_polls_kalshi.png")
        # audit 2026-11-16: keyboard inspection (A08), failed load + retry + return (A05/A06), empty series (A10), stale tip (A09)
        pg.locator(".wf-pk [data-pk=chart] svg").focus(); pg.keyboard.press("Shift+ArrowLeft"); pg.wait_for_timeout(400)
        ktip = pg.locator(".wf-pk .wf-tip")
        check("polls panel keyboard: visible tip with a poll", ktip.is_visible() and "people" in ktip.inner_text() and pg.locator("[data-pk=live]").text_content() != "", ktip.inner_text()[:110] if ktip.is_visible() else "hidden")
        ev(pick, "SENATEMI-26"); pg.wait_for_timeout(1500)
        check("polls panel: failed file clears the old race and offers Retry", txt("[data-pk=read]") == "" and pg.locator(".wf-pk [data-pk=sub] button").count() == 1
              and not ktip.is_visible(), txt("[data-pk=sub]")[:100])
        ev(pick, "SENATETX-26"); pg.wait_for_timeout(1200)
        check("polls panel: returning to a loaded race redraws the chart", pg.locator(".wf-pk svg circle").count() > 10, f"{pg.locator('.wf-pk svg circle').count()} circles")
        mi_down["on"] = False; ev(pick, "SENATEMI-26"); pg.wait_for_timeout(800); pg.locator(".wf-pk [data-pk=sub] button").click(); pg.wait_for_timeout(1500)
        check("polls panel: Retry loads the race", "MI Senate, up to" in txt("[data-pk=read]"), txt("[data-pk=read]")[:80])
        ev(pick, "KXHOUSERACE-CA37-26"); pg.wait_for_timeout(1500)
        check("polls panel: empty poll series says none, not max 1", pg.locator(".wf-pk svg text", has_text="none").count() >= 1 and pg.locator(".wf-pk svg text", has_text="max 1 ").count() == 0, txt("[data-pk=sub]")[:80])
        ev(pick, "CONTROLS-2026"); pg.wait_for_timeout(1500)
        check("polls vs Kalshi panel: national view for control", "generic ballot" in txt("[data-pk=sub]") and pg.locator(".wf-pk svg circle").count() > 50, txt("[data-pk=sub]")[:120])
        ev(pick, "SENATETX-26"); pg.wait_for_timeout(1000)
        # heatmap, upsets, selection link
        for hv in ["nov10", "settle"]:
            pg.click(f"[data-heat={hv}]"); pg.wait_for_timeout(1200)
            check(f"heatmap view {hv}", "Quoted midpoint" in txt(".wf-heat-note"))
        chips = pg.locator(".wf-heat-chip"); first = chips.first.inner_text()
        chips.first.click(); pg.wait_for_timeout(2000)
        check("upset chip opens race (card + night panel)", ev("WF.race") != "SENATETX-26" and pg.locator(".wf-nt-card").count() == 3, f"{chips.count()} chips; first '{first}' -> {ev('WF.race')}")
        pg.locator(".wf-heat").screenshot(path=f"{out}/{mode}_03_heatmap.png")
        pg.locator(".wf-heat-cv").focus(); pg.keyboard.press("ArrowDown"); pg.keyboard.press("ArrowLeft"); pg.wait_for_timeout(600)
        tipv = pg.locator(".wf-heat .wf-tip")
        check("heatmap keyboard shows a visible tip", tipv.is_visible() and "keyboard" in tipv.inner_text(), tipv.inner_text().replace("\n", " ")[:120] if tipv.is_visible() else "hidden")
        pg.locator(".wf-heat").screenshot(path=f"{out}/{mode}_03b_heatmap_keyboard.png")
        ev(pick, "KXHOUSERACE-NC02-26"); pg.wait_for_timeout(1500)
        h404 = txt("[data-draw=mkt-head]")
        check("missing market file is not reported as no trades", "does not include its market file" in h404 and "no trades" not in h404.lower(), h404[:110])
        ev(pick, "KXNCAAFGAME-26NOV03BUFFMOH"); pg.wait_for_timeout(2000)
        check("non-midterm card: price labels, not last trade", "hourly bid/ask midpoint" in txt("[data-draw=mkt-chart-hint]") and pg.locator("[data-draw=mkt-th]").text_content() == "Price"
              and "last traded" not in txt("[data-draw=mkt-chart-hint]"), txt("[data-draw=mkt-chart-hint]"))
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
        pg.set_viewport_size({"width": 320, "height": 800}); pg.wait_for_timeout(1500)
        sw = ev("document.documentElement.scrollWidth")
        ev(pick, "SENATETX-26"); pg.wait_for_timeout(1500)
        olap = ev("""() => { const t = [...document.querySelectorAll('.wf-pk svg text')].map((e) => e.getBoundingClientRect()).filter((r) => r.width);
          let n = 0; for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) { const a = t[i], b = t[j];
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) n++; } return n; }""")
        check("polls panel labels don't overlap at 320 px", olap == 0, f"{olap} overlapping label pairs")
        check("no sideways scroll at 320 px", sw <= 320, f"page width {sw} px")
        pg.screenshot(path=f"{out}/{mode}_05_320px.png", full_page=True)
        b.close()
    check("no page errors / failed requests", not errs, "; ".join(errs[:5]))


for mode in ["public", "private"]:
    for attempt in range(4):             # the headless shell sometimes dies on this page; retry
        try: run(mode); break
        except Exception as e: print(f"  [{mode}] retry: {str(e)[:150]}", flush=True)
    else:
        fails += 1; print(f"  [{mode}] FAIL walkthrough never completed (4 crashes)", flush=True)
srv.shutdown()
print("WALKTHROUGH", "PASSED" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
