"""Headless check of the night panel: console errors, readout text at 10:30 PM ET, screenshots. Usage: shot_night.py <out_dir>"""
import functools, http.server, os, sys, threading
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..")); out = sys.argv[1]; os.makedirs(out, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
H = functools.partial(Q, directory=ROOT)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
def run():
    errs = []
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 1000})
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text)); pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("response", lambda r: r.status >= 400 and errs.append(f"HTTP {r.status} {r.url}"))
        pg.goto(f"http://127.0.0.1:{srv.server_port}/index.html"); pg.wait_for_timeout(9000)
        setT = "t => { const s = document.getElementById('wf-scrub'); s.value = t; s.dispatchEvent(new Event('input')); }"
        pick = "id => { const s = document.getElementById('wf-race-select'); s.value = id; s.dispatchEvent(new Event('change')); }"
        state = lambda: f"cursor {pg.evaluate('WF.t')} | race {pg.evaluate('WF.race')} | on air {pg.locator('.wf-nt-air').count()} streams, {pg.locator('.wf-nt-tx').count()} transcript lines"
        def show(name):
            pg.wait_for_timeout(2500); pg.locator(".wf-night").screenshot(path=f"{out}/night_{name}.png")
            for c in pg.locator(".wf-nt-card").all(): print("  ", c.inner_text().replace("\n", " ; ")[:420])
            mk = lambda sel: pg.locator(sel).inner_text().replace("\n", " ; ")[:330]
            print("   CARD:", mk("[data-draw=mkt-vol]"), "|", mk("[data-draw=mkt-head]"), "|", mk("[data-draw=mkt-chart]") or "(chart drawn)")
            print("   near:", pg.locator("[data-nt=nearh]").inner_text(), "|", state(), "| status:", pg.locator("[data-nt=status]").inner_text(), flush=True)
        steps = [("control_2230", 1793763000, None, "control only, 10:30 PM"),
                 ("tx_senate_2006", 1793754360, "SENATETX-26", "TX Senate from the dropdown, 8:06 PM"),
                 ("nc03_2234", 1793763240, "KXHOUSERACE-NC03-26", "switch to NC-03 at 10:34 PM"),
                 ("ca_gov_map_2230", 1793763000, "MAP:California", "click California on the map (Senate layer -> its Governor race), 10:30 PM"),
                 ("nc11_2030", 1793755800, "KXHOUSENC11-26", "NC-11 (DEM/GOP contracts) from the dropdown, 8:30 PM"),
                 ("ca37_2230", 1793763000, "KXHOUSERACE-CA37-26", "CA-37, settled June 30, 10:30 PM"),
                 ("dc_0100", 1793772000, "KXHOUSERACE-DCAL-26", "DC delegate (sparse quotes), 1:00 AM")]
        for name, t, pickid, label in steps:
            pg.evaluate(setT, t); pg.wait_for_timeout(600); before = state()
            if pickid and pickid.startswith("MAP:"):
                pg.locator(f'path.wf-st[aria-label^="{pickid[4:]}:"]').click(force=True)
            elif pickid: pg.evaluate(pick, pickid)
            print(f"== {label} | before: {before}", flush=True); show(name)
        pg.evaluate(pick, "SENATETX-26"); pg.wait_for_timeout(1500)
        pg.locator(".wf-heat").screenshot(path=f"{out}/heatmap_settle_tx.png")
        pg.locator("[data-heat=nov10]").click(); pg.wait_for_timeout(1500); pg.locator(".wf-heat").screenshot(path=f"{out}/heatmap_nov10_tx.png")
        pg.locator(".wf-mkt").first.screenshot(path=f"{out}/market_card_tx.png") if pg.locator(".wf-mkt").count() else None
        pg.screenshot(path=f"{out}/page_top.png")
        b.close()
    print("errors:", errs[:10] or "none")
for attempt in range(4):      # the headless shell sometimes dies on this page; retry
    try: run(); break
    except Exception as e: print("retry:", str(e)[:120], flush=True)
srv.shutdown()
