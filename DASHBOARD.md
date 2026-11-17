# What is in the dashboard

Panel-by-panel map of the Midterm Watchfloor page as it stands on branch `night-control`: what each panel
reads, how the numbers are derived and how they are drawn. Written 2026-11-14 from the code
(`index.html`, `assets/app.js`, `assets/night.js`) and the `meta` block of every file in `data/`.

- Lawrence's original page: https://lawrencelu0904.github.io/midterm-watchfloor/ (public, GitHub Pages).
  His builder (`build_site_data.py`, `analysis/heatmap_dem_odds.py`) is **not** in the repo; only its output is.
- Our copy with the election-night panel: https://claude.ai/artifact/72Vg52m4LkoXARZP4mj4ws (private).
- Our builder for the new panel: `tools/build_night.py` (run with `sbatch tools/build_night.sbatch`).

## 0. How the page works

- **Static page, no build step.** `index.html` + `assets/style.css` + `assets/dash.js` (tiny loader:
  fetch a JSON once, redraw every `[data-draw=name]` element) + `assets/app.js` (all of Lawrence's panels)
  + `assets/night.js` (our panel) + vendored `assets/d3.v7.9.0.min.js`.
- **One shared cursor `WF.t`** (UTC seconds, snapped to the minute). Every panel reads it. It moves when you
  drag the timeline lanes, drag the bottom scrubber, press Play, use ← / → on the lanes, click a key moment,
  click the market chart, or click our night chart.
- **Three time windows** (buttons above the lanes): Election night = Nov 3 6 PM – Nov 4 8 AM ET;
  Nov 1 – 8; Oct 4 – Nov 12. Changing the window changes the x-axis of the lanes, the state sparklines and
  the market chart; the cursor is clamped into it.
- **"Per-minute detail window"** used by several files: Nov 3 5 PM – Nov 4 11 AM ET (`N0`, `N1` in app.js).
  Inside it, odds, bets, Reddit and whole-Kalshi counts are per minute; outside it they are hourly or
  10-minute.
- **Times** are stored as UTC Unix seconds and shown in US Eastern time.
- **"Settled" vs "called".** Lawrence's `called_ts` is the Kalshi **settlement** time of the contract
  (`settlement_ts`), not a media call. Our panel shows Kalshi's trading **close** and **settlement** separately.

## 1. Where every data file comes from

"Ours" = `Midterm_markets/raw` (our Kalshi API pull). "Subhrajit" = the `data/` folder of his kalshis_eye collection (not in this repo).

| File | Rows | Source | What a row is |
|---|---|---|---|
| `races.json` | 504 | ours: `winner`/`called_ts` = result and settlement of the party event's **Democratic contract**, `p_dem_eve` = its quoted mid at 6 PM ET Nov 3 (`tools/build_campaign.py`); label/volume from Watchfloor. Original in `private/races.lawrence.json` | one race: `race_id, office, state, district, special, label, winner, called_ts, volume, p_dem_eve, has_odds`. 34 Senate, 34 Governor, 436 House (435 + DC). 482 have odds |
| `race_odds.json` | 191,796 | **rebuilt from ours** (`tools/build_campaign.py`): quoted midpoint of the **Democratic contract of the party event**, hourly from Oct 4 and per minute Nov 3 5 PM – Nov 4 11 AM ET, a row only when it changes; `p_dem` null = the observed book was one-sided (a gap, 394 rows), or `closed: 1` = Kalshi stopped trading and has not settled yet (481 rows), so a last quote is never carried past the close; 1/0 at settlement. Lawrence's original (D/R blend, last-trade fallback) is kept in `private/race_odds.lawrence.json` | `t, race_id, p_dem` |
| `control.json` | 576 | **rebuilt from ours** (`tools/build_campaign.py`, same definition as `race_odds`): quoted midpoint of `CONTROLH-2026-D` / `CONTROLS-2026-D` from our hourly + 1-minute candles, hourly from Oct 4 and per minute in the detail window, a row only when it changes; null = gap, `closed: 1` from trading close to settlement; 1 after settlement. Lawrence's version (last trade before Oct 20, last mid carried past the close) is in `private/control.lawrence.json` | `t, chamber, p_dem, closed?` |
| `milestones.json` | 2 | ours (catalog) | chamber control: `event, chamber, winner, settled_ts, volume` |
| `race/<id>.json` | 551 files | Kalshi trades | per market: `px` = last YES trade price per outcome per bin (1 min in the detail window, 10 min otherwise; for the 54 non-midterm events, hourly bid/ask mid else last trade) with contracts. Rows are stamped at the bin START; the page re-stamps each at the bin END so the card never shows a price from a bin the cursor is still inside; `rows` = 10-min/1-min bet totals; `bets` = largest bets; `days` with trades; `question`; `outcomes` |
| `trades/<id>/<day>.json` | ~10k files | Kalshi trades grouped into **bets** (one taker order = all fills of the same contract and side at the same instant) | `[time (whole s), outcome index, bought YES=1/NO=0, price, contracts, $ paid]`, one file per ET day |
| `bets_flow.json` | 6,535 | Kalshi trades, every race + control market | 10-min (1-min on the night) totals: `d` $ backing D, `rr` $ backing R, `o` other, `bets` |
| `bets_state.json` | 28,196 | Kalshi trades, race markets only | per state per hour: `usd, bets` |
| `big_bets.json` | 1,500 | Kalshi trades | 1,500 largest midterm bets priced 3–97¢: `t, race_id, backs, usd, n, price` |
| `kalshi_cats.json` | 16,940 | Kalshi: every trade on the exchange in the detail window (exact, per minute); outside it **estimated** from markets open < 7 days (settled volume spread over open hours) | `t, r (bin s), g (category), n (contracts)` |
| `kalshi_big.json` | 1,500 | Kalshi, whole exchange, detail window | largest bets anywhere, 3–97¢ |
| `markets_index.json` | 54 | Kalshi | most-traded non-midterm events per category (sports, crypto, stocks…), plus balance-of-power |
| `kalshi_index.json` | 691 | Kalshi trades in S&P 500 / Nasdaq-100 "at or above K" ladders for Nov 4 | every 5 min: strike where P crosses 50%, as % vs Nov 3 close |
| `heatmap.json` | 504 races × 360 cols | **rebuilt from ours** (`tools/build_campaign.py`): quoted midpoint of the Democratic contract (book in effect at each column's right edge), 1/0 after settlement. Lawrence's columns are kept; row order, upsets, winners and settle-view anchors are recomputed from the same contract; original in `private/heatmap.lawrence.json` | one byte per cell: 0–200 = 0–100%, 253 = trading closed not settled, 254 = gap (one-sided book), 255 = not open; two views (§9) |
| `polls.json` | 1,146 | Subhrajit's `polls.csv` (Wikipedia CC BY-SA + VoteHub CC BY), one version per pollster and end date, LV preferred, party tag split out | `race_id, t, date (field end), pollster, partisan, D, R, names, sample, source` |
| `streams.json` | 8 | Subhrajit's yt-dlp metadata | `stream_id, streamer, lean, platform, title, start, end, views, url` |
| `chat.json` | 2,056 | Subhrajit's YouTube live-chat replays, **counts only** | messages per minute per stream |
| `bluesky.json` | 4,838 | Subhrajit's Bluesky sample (top posts per query, Nov 3 11 AM – Nov 4 3 PM ET), counts only | per state per 10 min: `posts, likes` |
| `reddit_hourly.json` | 58,968 | Arctic Shift archive | per subreddit per hour: posts, comments (national subs as `US`, one main sub per state) |
| `reddit_night.json` | 5,672 | Arctic Shift | per minute, national subs, detail window |
| `polymarket.json` | 343 | Polymarket Gamma API | comments per hour on 3 control events |
| `moments.json` | 57 | Lawrence's selection; the numbers in the 16 swing titles are restated from `race_odds` / `control` by `tools/build_campaign.py` (original in `private/moments.lawrence.json`) | key moments: 21 calls, 16 swings, 10 big bets, 4 stocks, 3 Reddit surges, 3 control; each with links to public posts |
| `stocks.json` | 206 | FRED | daily closes S&P 500, Nasdaq, Dow, VIX |
| `gas.json`, `oil.json` | 2,029 / 50 | Kalshi AAA gas and WTI/Brent markets (settlement value = the day's price) | per state per day / per series per day |
| `weather_state.json`, `weather_grid.json` | 1,683 / 2,994 | NOAA GHCN-Daily | state daily rain, wet share, high temp / election-day rain on a 0.5° grid |
| `turnout_races.json`, `turnout_daily.json` | 502 / 20,080 | Kalshi turnout ladders + MEDSL baseline | ladder metadata / implied median votes per day at 6 PM ET |
| `states_geo.json` | 51 features | us-atlas 3.0.1 | state outlines |
| **`night_control.json`** (ours) | — | **ours**: 1-min candles + catalog of both control markets; Subhrajit's stream metadata and chat **timing** | see §11 |
| **`night_trades/<event>.json`** (ours) | 80,082 Senate, 30,653 House | **ours**: raw trades, deduped on `trade_id` | `[exact time (ms), outcome 0=D 1=R, bought YES=1/NO=0, YES price, contracts]`, Nov 3 6 PM – Nov 4 8 AM ET |
| **`private/night_private.json`** (ours, git-ignored) | 8 transcripts, 4 chats | Subhrajit's Whisper transcripts and chat **text** | see §11 |

## 2. Header

| Element | Reads | How |
|---|---|---|
| Takeaway sentence | `milestones`, `big_bets`, `races` | "Kalshi settled Senate control for … at …": winner and `settled_ts` of each control market. The biggest bet in `big_bets` with its race, price and whether it won |

## 3. Reading strip (KPI tiles across the top)

All values are **at the cursor**.

| Tile | Reads | How |
|---|---|---|
| Cursor · ET | `WF.t` | day + time |
| Senate / House control · P(D) | `control` | last row at or before the cursor (bid/ask mid of the D contract, 1 after settlement); blue if ≥ 50% |
| Races settled | `races` | count with `called_ts ≤ cursor`, of 504 |
| Midterm bets · past hour | `bets_flow` | $ of all midterm bets in the 10-min bins that ended in the hour before the cursor; colour = side with more money; tooltip = % D / % R |
| All Kalshi · contracts past hour | `kalshi_cats` | contracts traded in the last full hourly bin that ended by the cursor |
| Reddit · comments/min | `reddit_hourly` + `reddit_night` | national subs; per-minute average over the 10 one-minute bins that ended by the cursor in the detail window, otherwise over the last full hour |
| Stream chat · msgs/min | `chat` | messages in the last full minute before the cursor, summed over all streams |
| US gas · AAA | `gas` | US price on the cursor's ET date |
| WTI crude | `oil` | last WTI settlement on or before that date |
| S&P 500 · last close | `stocks` | last close before the cursor; tooltip = % vs the day before |

## 4. Map

d3 `geoAlbersUsa` choropleth of `states_geo`, coloured at the cursor. Click a state to select it (fills the
state panel and picks its Senate race, else Governor). Hover shows the same text as the fill.

| Layer | Reads | Fill |
|---|---|---|
| **Races · Senate / Governor** | `races`, `race_odds` | P(D) of the state's race (non-special first) at the cursor on a red–grey–blue scale (`partyScale`, 0 → 0.5 → 1). Solid blue/red once the cursor passes `called_ts`. Grey = no price yet |
| **Races · House** | `races` | share of the state's House seats settled D vs R by the cursor: fill = 0.5 + (D − R) / (2·seats); grey until any seat settles |
| Rings | `races` | a ring at the state centroid for each race (current office) settled in the last 30 min, coloured by winner |
| **Bets** | `bets_state` | $ bet on the state's races in the cursor's clock hour (full hour, labelled so: per-state bets are hourly), log scale $1K → max |
| **Social** | `reddit_hourly` (+ `bluesky` in the tooltip) | comments in the state's subreddit in the cursor's clock hour (full hour, labelled) ÷ its median hour; Bluesky = last 10-min bin ended by the cursor, log scale ½× → 4×+ |
| **Gas price** | `gas` | AAA regular in the state on the cursor's date |
| **Rain** | `weather_state`, `weather_grid` | station-average rain that day (sqrt scale, 0–25 mm); on Nov 3 also dots per 0.5° cell sized by rain |
| **Turnout markets** | `turnout_races`, `turnout_daily` | implied median votes (Senate ladder, else Governor) ÷ last midterm Senate total, −20% → +20% |

## 5. State panel (right side, "Selected state")

| Block | Reads | How it's drawn |
|---|---|---|
| Races at the cursor | `races`, `race_odds` | each statewide race: P(D) bar + %, or "settled D/R at …"; contracts traded. A House line: seats, D/R settled, open. Click a race → market card |
| Statewide race odds sparkline | `race_odds` | primary race's P(D) over the time window, step line, area above 50% blue and below red, amber cursor rule, dot at settlement |
| Bets on this state's races | `bets_state`, `big_bets` | text: $ in the cursor's clock hour, labelled "6:00–7:00 PM ET, full hour" because it includes bets after the cursor; $ from Oct 4 through completed hours only; largest bet so far. Bar sparkline: $ per hour over the window (up to 160 bars) |
| Social activity | `reddit_hourly`, `bluesky` | text only: subreddit comments/posts in the cursor's clock hour, labelled "full hour" (only hourly counts exist per state) and ratio to usual; Bluesky top posts and likes in the 10-min bins that ended in the hour before the cursor |
| Gas | `gas` | state price that day; sparkline Oct 1 – Nov 12, state solid vs US dashed |
| Weather | `weather_state` | text: rain mm, % wet stations, average high |
| Turnout market | `turnout_races`, `turnout_daily` | text: implied median votes, comparison year, strikes, volume, eve spread, settled bucket |

## 6. Settlement feed

`races` + `milestones`. Every race (and both control markets) whose `called_ts ≤ cursor`, newest first,
up to 60. Chip = winner, amber highlight if settled in the last 30 min. Click → opens that race.

## 7. Market card ("Kalshi-style" card, picked from the dropdown)

Dropdown lists chamber control, every Senate / Governor / House race by volume, and the most-traded
non-midterm Kalshi events by category (`markets_index`). Loads `race/<id>.json` on demand.

| Part | Reads | How |
|---|---|---|
| Volume line | `races` / `markets_index` | $ volume (midterms) or $ on election night + contracts (other markets); "Settled: … at …" or "Open at the cursor" |
| Question | `race/<id>.question` | |
| Headline number | `race/<id>.px` | leading outcome's chance at the cursor = **last traded YES price** in the last bin that ENDED at or before the cursor (never a later trade); ▲/▼ points since the window start; "settled" once past settlement |
| Chart | `race/<id>.px` | one step line per outcome over the time window (D blue, R red, others from a 5-colour set), y 0–100%. Faint bars underneath = contracts traded per bin (30–200 bins). Dashed "settled" rule. Amber cursor with each outcome's % labelled. Hover tooltip; click moves the cursor |
| Table | `race/<id>` | per outcome: chance, Yes ¢ / No ¢ (or Won/Lost), contracts traded up to the cursor |
| Polls | `polls` | polls with field end date ≤ cursor: "average of the latest 5" margin (D − R) and the last 8 polls (date, pollster, party tag, D–R, sample, margin). Not shown for control or non-midterm markets |

**Price labels and status (consistency pass, 2026-11-14).** The card's percentages are **last trade**
prices, and every place shows it ("last trade" under the headline number, the "Last trade" table column,
the chart tooltip, a note under the outcome keys). Non-midterm events say "price" instead: their files hold hourly
bid/ask midpoints, else last trade. On election night the note adds the **quoted midpoint**
of the Democratic contract with its bid, ask and observation time, so a reader sees why the two differ
(e.g. NC-11 at 8:30 PM: last trade 97¢, quoted mid 92.5¢). Everywhere else (map, reading strip, state panel,
timeline, heatmap, night panel) is labelled "quoted mid".
The status line ("Trading at the cursor · trading closes …", "Kalshi trading closed …", "Kalshi settled for
… , <date>") comes from the same file as the night panel (`night_races.json` / `night_control.json`).
Empty states name the period: a race settled before Oct 4 says so with its settlement date (the nine
California districts); a race with no trades in the chart window says "No trades between … and …".
A button jumps to the race's election night (keeps the cursor if it is already in the night window,
otherwise 15 minutes before Kalshi stopped trading it) and scrolls to the night panel.

## 8. Trades panel ("tape")

| Button | Reads | How |
|---|---|---|
| This market | `race/<id>.days`, `trades/<id>/<day>.json` | the last 120 bets up to the cursor, from the cursor's day and the two before, newest first: time, Yes/No chip, outcome, contracts @ price, $ paid; amber if ≥ $10K |
| Big · midterms | `big_bets` | the last 80 of the 1,500 largest midterm bets before the cursor; click → open that race |
| Big · all Kalshi | `kalshi_big` | the last 80 of the 1,500 largest bets on the whole exchange (detail window only); click opens the market if it is indexed |

## 9. Every race · 120 days (heatmap)

`heatmap.json` (rebuilt from our pull, §1), drawn on a canvas. One row per race, three bands (Senate 34, Governor 34, House 436).
Cells are the quoted midpoint of the Democratic contract; brown = gap (book one-sided, e.g. no asks left at
100¢ in a decided race), slate = trading closed but not settled yet, dark = not open. The selected race has
an amber outline, and clicking a row opens its market card and election-night panel.
Columns are 360 **log-spaced** time steps before an anchor, so the last day fills most of the width.
Colour = chance the Democrat wins (red 0% → pale 50% → blue 100%), dark = no market yet.

| View | Anchor | Row order |
|---|---|---|
| Up to each settlement | each race's settlement (Democratic contract; unsettled races end at Nov 10) | same in both views (below) |
| Up to Nov 10 | Nov 10 12 AM ET; dotted line at first polls close (Nov 3 7 PM ET); amber line = page cursor | same in both views |

**Row order:** within each office, by the quoted mid of the Democratic contract in effect at 6 PM ET Nov 3
(the last observed book at or before 6 PM, usable only if two-sided and the contract was still trading),
Republican-favoured first. Races without a usable 6 PM quote go to the bottom of their group: the nine
California districts settled in June, and SD Senate (book at 6 PM: bid 0 / ask 0.3¢, no bids).

**Upsets** (chips under the heatmap): races whose 6 PM quoted favourite lost, ranked by how strongly the
loser was favoured, each with its quote time and spread. Excluded: races closed by 6 PM, a 50¢ mid, no usable
quote. Races whose 6 PM bid and ask straddle 50¢ are kept in the data but left out of the headline list
(none this year). Result: **21 upsets**, all Republican favourites that lost, led by MS Senate (13.5¢),
NC-06 (14.5¢), IN-05 (21.5¢), NC-14, TX-09, OH-10, SC Senate, TX Governor.

Hover shows race, % and time; click opens the race's market card. Keyboard: focus the heatmap, Up/Down pick a race,
Left/Right step through time, Enter opens it; the cell's value and time show in a tip at the cell and are read out. Chips below: the 21 races where the
6 PM ET Nov 3 favourite lost.

## 10. Timeline lanes (shared cursor)

One SVG, x = the chosen time window. Lanes are binned into 30–220 bins depending on width. Amber
diamonds on top = key moments (click to jump). Amber vertical line = cursor.

| Lane | Reads | How it's drawn |
|---|---|---|
| Chamber control P(D) | `control` | two step lines (House light blue, Senate white), 0–100%, dashed 50% line |
| Races settled | `races` | stacked bars per bin: R settlements red at the bottom, D blue on top; sqrt height |
| Kalshi · 9 category lanes (Midterms, Politics, Sports, Crypto, Parlays, Stocks, Finance, Weather, Other) | `kalshi_cats` | filled step area of contracts/min, each lane on its own scale; dotted rules at the edges of the exact (per-trade) window |
| Midterm bets $/min · D ▲ R ▼ | `bets_flow` | diverging bars: $ backing D up (blue), backing R down (red), sqrt scale |
| Big midterm bets | `big_bets` | one circle per bet, area ~ $, blue above / red below the centre line |
| Streams on air | `streams` | one thin bar per stream from `start` to `end` (blue = left, red = right) |
| Live-chat msgs/min | `chat` | filled area, all streams summed |
| Reddit comments/min | `reddit_hourly` + `reddit_night` | filled area, national subs |
| Bluesky top posts | `bluesky` | filled area, per 10 min (it's a top-posts sample, not volume) |
| Polymarket comments | `polymarket` | filled area, per hour |
| Stocks | `kalshi_index` on election night, else `stocks` | night: Kalshi-implied S&P 500 at 10 AM Nov 4 as 30-min candles (% vs Nov 3 close) + Nasdaq-100 dashed line; otherwise S&P, Nasdaq, VIX daily closes |
| US gas · WTI | `gas`, `oil` | two step lines (US gas solid, WTI dashed) |

Hover tooltip: Senate and House P(D), races settled, contracts/min on all of Kalshi.

## 11. Election night · control markets, the selected race and what was on air (our panel, `assets/night.js`)

Our Kalshi pull joined with Subhrajit's stream data. Window **Nov 3 6 PM – Nov 4 8 AM ET**. Follows the page
cursor; clicking its chart moves the cursor. Each source keeps its own clock.

- Always shows **Senate control** and **House control**.
- Picking a race on the map or in the market dropdown adds it as a third row, **without moving the cursor**.
  **Every one of Watchfloor's 504 races** is exported (`tools/build_races_night.py` → `data/night_races.json`
  index + one file per state in `data/night_state/`, loaded when a race in that state is picked).
  - The event shown is Watchfloor's race ID, i.e. the **party** event. For California and Alaska governor the
    candidate events (`KXGOVCA-26`, `KXGOVAK-26`) stay in `crosswalk/race_contracts.tsv` as separate markets.
  - The Democratic and Republican contracts are found by Kalshi's own party ID (`custom_strike.political_party`),
    falling back to the ticker suffix. This is what maps NC-11, whose contracts are `-DEM` / `-GOP`
    (rules: Yes if the member sworn in is a Democratic / Republican Party member).
  - Races settled before election night (nine California districts) stay selectable; the readout shows
    "Settled for D/R" with the settlement date and no quotes. Sparse markets (e.g. DC-AL: 6 quote minutes,
    no trades) show whatever quote exists with its age and spread, plus a warning line.
  - Coverage of every race in the actual window: `crosswalk/night_coverage.tsv` (see §15).
- **Price definition here:** the **Democratic contract's YES side only**. Bid, ask and quoted midpoint come
  from its 1-minute candles; nothing is blended with the Republican contract. Trades on the Republican
  contract are shown at 1 − price and labelled so. The map, tiles, state panel, lanes and heatmap use the same
  quoted mid, rebuilt from our pull (`race_odds.json`, `control.json`, `heatmap.json`); only the market card
  uses last trade (§7).
- **Quote timing and gaps:** a book is stamped with the end of its minute candle. Kalshi omits candles for
  quiet minutes (NY-06 has 10 rows in the window, with the same 99¢ / 99.9¢ book on both sides of a 75-minute
  hole), so the last observed book stands until the next candle. The readout uses the latest book observed
  at or before the cursor and prints its time and age. If that book is one-sided (bid 0 or ask 100¢) there
  is no two-sided quote and no midpoint. No book is shown after trading stops.
- **Marks:** "Kalshi trading close" (`close_time`) and "settlement" (`settlement_ts`) are separate, with dates.
  Neither is a media call; no media call time exists in any of our data.
- **Stream clocks:** transcripts sit at stream start + video offset. The chat-derived offsets (BTC +27 s,
  TYT 0, Tim Pool 0, Kirk −3 s) are **shown on the badge and not applied**. Chat lines use YouTube's own
  send time.
- **Checked against the raw pull** (`tools/verify_night.py`, run inside `tools/shot_night.sbatch`): bid/ask with
  its observation time, last trade, and the trade count and contracts within 60 s match for Senate control
  10:30 PM, TX Senate 8:06 PM, NC-03 10:34 PM, CA Governor 10:30 PM (picked by clicking California on the
  map), NC-11 8:30 PM, CA-37 10:30 PM (settled June 30: no quote, no trades) and DC-AL 1:00 AM (quote from
  6.2 h earlier, 77.8¢ spread). Across all seven switches the cursor and the on-air streams stayed put.

**Data** (`tools/build_night.py`):
- `night/<event>.json`: the same quote arrays and marks for one race.
- `night_control.json`: for `CONTROLS-2026` and `CONTROLH-2026`, from our 1-minute candles: per minute
  `bid`, `ask` (best YES quote at the **end** of the minute), `last`, `lo`, `hi` (trades inside the minute,
  null if none), `vol`. An empty book (bid 0, ask 100¢, e.g. after trading stops) is stored as "no quote".
  Close time (`close_time`) and settlement time (`settlement_ts`) from our catalog. For each stream: start,
  duration, and a clock check (median of YouTube chat send time − video offset, compared with the start).
- `night_trades/<event>.json`: every raw trade from our pull in the window, deduped on `trade_id`, with
  millisecond execution time.
- `private/night_private.json` (git-ignored): transcripts as `[start + offset, start + end offset, text]`
  and chat sampled to 12 messages/min as `[YouTube send time, text]`, no author names.

| Part | Reads | How it's drawn |
|---|---|---|
| Whole-night chart | `night_control` | per chamber: blue band from bid to ask at each minute's end, light line = midpoint, white dots = last trade in minutes that had one. Dashed amber = Kalshi stops trading (Senate 11:46 PM, House 12:02 AM ET); dotted amber = settlement (12:46 AM, 1:02 AM). Amber cursor line |
| ±10-minute zoom (one per chamber) | `night_control`, `night_trades` | canvas. Every trade as a dot at its exact time, priced as P(Democrats) (a Republican-contract trade is drawn at 1 − price); blue = backs D, red = backs R; dot size ~ √contracts. Green line = bid, amber line = ask at each minute's end. y-axis zooms to the data |
| Readout cards | `night_control`, `night_trades` | bid / ask with the minute it's from; midpoint and spread; last trade price, how long before the cursor and its exact time; status (Trading / Closed, not yet settled / Settled for D) with both times |
| Trades near the cursor | `night_trades` | every trade within ±60 s of the cursor, both chambers, newest first (largest 80 if more): time to the ms, chamber, YES/NO on D/R, P(D), contracts. Header: count and total contracts |
| On air at the cursor | `night_control.streams`, `private/night_private.json` | for each stream on air at the cursor: name (blue = left, red = right), clock badge, time into the stream; transcript segments from 45 s before to 20 s after the cursor (the one spanning the cursor highlighted); up to 8 chat messages within ±30 s. By default only the 4 streams whose clock was checked against chat (BTC +27 s, TYT 0 s, Tim Pool 0 s, Kirk −3 s); a checkbox adds Hasan (Twitch, unchecked), Crowder, Daily Wire (unchecked) and Hasan YouTube (upload, placed by upload time) |

What this panel does **not** claim: a transcript line next to a price move shows what was being said at
that time, not that the speaker was talking about that market. When the private file is missing (e.g. on
the public site) the "On air" block says so instead of showing text.

## 12. Other page parts

| Part | Reads | How |
|---|---|---|
| Key moments list + detail | `moments` | tabs Before / Election night / After with counts. List of moments (time, kind chip, title); the one at/before the cursor highlighted. Detail: title, time, kind, and "Show posts", which loads Bluesky / Reddit / X embeds from those sites (blocked on the claude.ai copy) |
| "How to read this" notes | static text | definitions of odds, bets, Reddit, Bluesky, moments, embeds |
| Bottom scrubber | `WF.range` | range slider over the chosen window, 1-minute steps, with Play |

## 13. What is and isn't on each copy

| | Public edition (GitHub Pages, discostrangler/midterm-watchfloor) | Private research copy (claude.ai) |
|---|---|---|
| Panels §2–§10, §12 | yes | yes |
| Night panel §11, all 504 races | yes | yes |
| Stream timeline, links to the original streams, chat counts | yes | yes |
| Transcripts and chat text | no (`private/` is not published) | yes, private file |
| Market card files `race/<id>`, `trades/<id>` | all 551 markets / ~10k day files | the two control markets, TX Senate and NC-03 (other market cards say the copy does not include their market file) |
| Bluesky / Reddit / X embeds | yes, on click | blocked by the hosting |
| Videos | no | no |

Lawrence's original site (LawrenceLu0904.github.io/midterm-watchfloor) is unchanged and has none of §11.

## 14. Known gaps

- No external race-call times (AP, networks): "settled"/"called" everywhere is Kalshi's settlement; our
  panel adds Kalshi's trading close.
- Polls are placed by **field end date**; no release date is stored.
- Bluesky is a capped top-posts sample (≤ 100 per query), so its lanes show attention among popular posts,
  not total volume.
- Stream clocks for Hasan (Twitch), Crowder and Daily Wire have no chat to check against; Hasan's YouTube
  video is an upload.
- Lawrence's `build_site_data.py` is not in the repo, so his files can't be rebuilt from here. In particular the
  key moments keep his selection (only the swing numbers are restated), and the hourly rows of the non-midterm
  market files are assumed to start at their stamp (if they are candle ends, those cards are an hour late, never early).

## 15. Race crosswalk and election-night coverage (`crosswalk/`)

Denominator: **Watchfloor's 504 races** (34 Senate, 34 Governor, 436 House incl. DC). The earlier "492" was the
heatmap/linked-set subset and is not used.

`race_crosswalk.tsv` (`tools/build_crosswalk.sbatch`): one row per race key (office, state, district, special,
cycle 2026), Watchfloor ID vs every Kalshi event in our catalog.
- 495 matched one-to-one, 9 have more than one event, 1 is ours only (ND governor, closed Dec 2025, never traded).
- The 9: CA and AK governor (party event + candidate event, both live: the party event is the default);
  Senate AR, CO, ID, LA, OK and House NH-02, NY-21 (a second party event that closed Dec 22 2025 with no trades).
- `race_contracts.tsv`: every contract with its side (D/R by party ID or suffix), party/candidate kind,
  politician, result, open/close/settlement, and quote/trade counts.
- Export-ready by the catalog (tradable on election day, D and R contracts, minute quotes pulled): **495 of 504**.
  The 9 that are not are the California districts settled June 30.

`night_coverage.tsv` (`tools/build_races_night.sbatch`): one row per race for **Nov 3 6 PM – Nov 4 8 AM ET**:
D and R tickers and how they were found, window status, result, close and settlement times, `open_minutes`
(minutes of the window the D contract was trading), two-sided quote minutes counted two ways, median spread,
first and last quote, trades and contracts, first and last trade.

- **Observed quote coverage** (`observed_quote_coverage`, `_le10c`; minutes in `D_two_sided_minutes`): share of open minutes **with a candle** showing a two-sided book (≤ 10¢ wide).
- **Carried-forward quote coverage** (`carried_forward_quote_coverage`, `_le10c`; minutes in
  `D_carried_forward_*`): share of open minutes where the last observed book, carried over minutes without a
  candle, was two-sided (≤ 10¢). Reasonable for display (NY-06 shows the same book on both sides of a 75-minute
  hole), but what happened between candles is unknown.
- **Quote age** (`quote_age_median_min`, `_p90_min`, `_max_min`): age of the carried-forward book over the open
  minutes, so a modelling team can cap how much carry-forward it accepts and use observed coverage otherwise.

| In the window (of 504) | Races |
|---|---|
| Kalshi trading open the whole window | 72 |
| Trading closed during the window | 423 |
| Settled before the window (CA-04, 07, 11, 12, 14, 29, 34, 37, 40) | 9 |
| Carried-forward quote coverage ≥ 25% / ≥ 50% / ≥ 90% (of 495 open) | 494 / 483 / 385 |
| … no wider than 10¢ | 493 / 480 / 348 |
| Observed quote coverage ≥ 25% / ≥ 50% / ≥ 90% | 309 / 157 / 25 |
| … no wider than 10¢ | 303 / 139 / 24 |
| At least one trade | 493 (957,584 trades in all) |
| Quotes but no trades | 2: DC-AL (median spread 86¢), NY-06 |

The older "≥ 420 of 840 minutes" count (45 races) is still printed by the builder but understates races
that closed early; prefer the open-minute shares.

## 16. Reconciliation status (2026-11-14)

- **One source for result and settlement time** across map, settlement feed, market card, heatmap and night
  panel: the party event's Democratic contract in our catalog. Checked: all 504 races agree across
  `races.json`, `heatmap.json` and `night_races.json`.
- **WA-09:** event `KXHOUSERACE-WA09-26` has three contracts: `-D` (result yes) and `-R` (no), both trading close
  Nov 4 04:31:01 UTC and settled 05:01:05 UTC (12:01 AM ET); and `-KSAW`, an eliminated candidate, trading close Aug 5
  23:01:58 UTC, settled ~23:32 UTC. Watchfloor had used the `-KSAW` settlement (Aug 5 23:32) for the race. Now Nov 4
  everywhere; it was the only race whose result or time changed (others differed only by Watchfloor dropping
  the fraction of a second).
- **CA-37 and the other June-settled districts:** the market card no longer requests a file it does not have
  (status from the shared index); the page loads with no errors.
- **Credits** in the page header: Lawrence Lu's Midterm Watchfloor and Subhrajit's kalshis_eye. The footer links
  this edition's repo and, separately, Lawrence's.

## 17. Audit fixes (2026-11-14)

An outside read-only audit of the live site listed 26 findings; each was checked against the code and data first.
- **No look-ahead at the cursor.** Market card prices, totals and tooltips use bins that ended by the cursor;
  reading-strip counts, Bluesky and chat counts use finished bins; per-state bets and subreddit counts exist only
  hourly and say "full hour".
- **Closed is its own state.** `race_odds` and `control` carry a `closed` marker from trading close to
  settlement; the map, state panel, tiles and lanes say "trading closed, not settled yet" instead of a last quote.
  Control is quoted mid for the whole campaign (it was last trade before Oct 20).
- **Moments:** swing numbers restated from the plotted series (SC Governor 9% → 38%, NE Senate to 0.4%);
  a jump to a moment rounds up to the minute, so settlement moments show as settled.
- **Charts:** stock-lane note follows the cursor; state sparkline holds its last value to the window end;
  zoom bid/ask lines break at one-sided books; night overview scales include last trades; last axis label fits.
- **Failures:** a market file that fails to download says so and offers Retry; a 404 says the copy lacks the file
  (every market with trades has one; the nine June-settled districts are never requested), never "no trades";
  trade-day files that fail are listed under the tape and retried.
- **Layout and access:** night grid fits 320 px; nearby-trade rows wrap; faint text 5.1:1 contrast (was 3.5:1);
  cursor time never truncates; heatmap keyboard access; night overview labelled.
- **Text:** first note (prices, no media-call claim), 3–97¢ filter scope, latest-120 tape, 148 races / 1,146
  polls, "Before election night" tab, footer link, jump-button reason.
- `tools/walkthrough.py` now fails on a crash, exits non-zero on failure, and counts errors caught by `dash.draw`.

## 18. Polls vs Kalshi · whole cycle (`assets/polls.js`, `tools/build_polls_kalshi.py`)

One daily timeline, Nov 5 2024 – Nov 12 2026 (ET days), for the selected race; for chamber control (or a
non-midterm market) a national view.

| Row | Reads | How |
|---|---|---|
| Poll margin D − R | `polls_kalshi/<ST>.json` `polls` | one circle per nominee head-to-head poll (blue D lead, red R lead, hollow = party-sponsored); circle **area ∝ people polled** (largest 5% in the view drawn at the top size; square = sample size not published; key above the chart; hover for pollster, date, margin, size); line = unweighted mean of the latest five |
| Polls | same | polls per bin |
| Kalshi trades / Kalshi $ | `k` = `[day, trades, dollars]` | every trade in **all** the race's Kalshi events (party + candidate markets, from `crosswalk/race_crosswalk.tsv`); dollars = what the taker paid |
| Quoted mid P(D) | `mid` | quoted mid of the party event's Democratic contract at the end of each ET day (same reader as `race_odds`); gaps = one-sided book; stops at trading close; 1/0 after settlement |

- **Polls:** from Subhrajit's `collect/polls_full.py` (Wikipedia race pages, CC BY-SA 4.0; VoteHub, CC BY 4.0).
  Only general-election polls that name **both** actual nominees (names from our catalog's D/R contracts).
  The same poll in both sources (same race, pollster, field end within a day) is kept once; a poll VoteHub lists
  twice (same race, pollster, field end, result and sample: 7 cases) is kept once with its earliest added date;
  polls ending before Nov 5 2024 are left out (2 from 2023). Result: 1,584
  polls in 171 of 504 races (1,387 from Wikipedia, 903 from VoteHub, 699 in both); 1,556 have a sample size
  (VoteHub's number, or Wikipedia's "1,000 (LV)" text); 405 of the 423 generic-ballot polls do. NBC exit polls are not used
  (research only, not for republication).
- **National:** 423 VoteHub generic-ballot polls (likely voters over registered over adults when a pollster —
  matched on its FULL name, so "YouGov" and "YouGov Blue" stay separate — released several for the same dates), against the Senate and House control markets (trades summed; two
  quoted-mid lines). Kalshi's own generic-ballot series (`KXVHGCB`, daily markets on an aggregator's margin)
  covers only Oct–Nov 2026 and is not used.
- **Poll date toggle:** field **end** date (earliest it could be public) or the date VoteHub **added** it
  (latest bound; median 5 days after the end). Wikipedia-only polls have no added date and are hidden in that
  mode, with the count shown. Two VoteHub polls list an added date BEFORE their field end (MI Governor/Guidant,
  NY Governor/Siena); that contradiction is in the source, so their added date is dropped. Any lead/lag shorter than the end→added gap is inside the release uncertainty.
- **Bins:** daily if the shown span is ≤ 150 days, else weekly; the same bins for polls and Kalshi. Bars use a
  square-root scale. The x-axis starts a week before the race's first poll, trade or quote.
- **Readout under the chart** uses only whole days **before** the cursor's day: polls so far, the latest five's
  average, the last 7 days' polls / trades / dollars, and the quoted mid at the end of the previous day.
- **Click** moves the page cursor when the day is inside Oct 4 – Nov 12, 2026 (the dashboard's campaign window).
- **Keyboard:** focus the chart; Left/Right step a bin, Shift+Left/Right jump between polls (pollster, size),
  Home/End, Enter moves the page cursor; values show in a visible tip and an aria-live line.
- **Failures:** a state file that does not load clears the previous race's numbers and offers Retry.
- Spot-check: TX Senate, Oct 20 2026: 3,004 trades, $717,593 in both the built file and a recount from raw.
- Rebuild: `POLLS_FULL=<polls_full output dir> python3 tools/build_polls_kalshi.py` (pandas + pyarrow; ~25 s).

## 19. Race-list corrections: Kentucky / Louisiana Senate, Kansas / New Hampshire Governor (2026-11-16)

Kalshi listed the **Kentucky** Senate race under a **Louisiana** ticker: `SENATELA-26` is titled "Kentucky Senate
winner?", its contracts are Andy Barr (R) and Charles Booker (D), and both resolve on who is "sworn in as a Senator of
Kentucky". Watchfloor (and this edition, until now) read the state from the ticker, so the map showed Kentucky's race on
Louisiana and Kentucky had no Senate race. Louisiana's real race is `KXSENATELA-26NOV` (Julia Letlow R vs Jamie Davis D,
3.3M contracts), which no list had because its ticker ends in `26NOV`.

- `tools/build_crosswalk.py` now takes a statewide event's state from Kalshi's own titles and rules when they name a
  different state than the ticker, accepts ticker years like `26NOV`, and corrects `data/races.json` in the same pass
  (changes listed in its `meta.corrections`). Checked across all 513 race events: this is the only mislabeled one.
- **Ticker year ≠ election year:** `GOVPARTYKS-27` (Holscher D vs Masterson R, 4.0M contracts, not settled) and
  `GOVPARTYNH-28` (Warmington D vs Ayotte R, settled R) are the **2026** Kansas and New Hampshire governor races
  (rules: "inaugurated … pursuant to the 2026 election"); Watchfloor's list had neither. The crosswalk now takes the
  election year from the rules when they name one. A scan of every race event in the catalog finds no other state
  or year mismatch; the list now matches the 2026 ballot: 35 Senate (33 + FL and OH specials), 36 Governor, 435 House + DC.
- **507 races** (35 Senate, 36 Governor, 436 House). Every file built from the race list was rebuilt: crosswalk,
  `race_odds` / `heatmap` / `races` (new LA Senate heatmap row), `night_races` + `night_state`, `polls_kalshi`.
- **Full audit against Kalshi's live API** (`tools/audit_races.py` → `crosswalk/race_audit.tsv`, one row per race):
  for all 507 races the live market text names the race's state (House: its district code), office and the 2026
  election, specials are flagged consistently, and the live contracts and results equal ours. The list matches the
  2026 ballot (33 + 2 special Senate, 36 Governor, House seats per state = 2020 apportionment, DC). 0 failures.
- **Late settlements:** five races settled after our Nov 12 catalog crawl (KS Governor D, CO-04 D, AK Governor D,
  NC-07 R, CA-23 R). Their live status / result / settlement / close are in `raw/catalog/markets_refresh.jsonl`
  (written by `audit_races.py --write-refresh`), which `build_crosswalk.py` and `build_races_night.py` apply on top of
  the crawl; the crawl itself is unchanged. Trades after Nov 14 02:33 UTC are not pulled (outside every window shown).
- `data/bets_state.json` (map "Bets" layer, state panel) is rebuilt from our trades by `tools/build_bets_state.py`
  with Watchfloor's definition, reverse-engineered: each race's own event, UTC hour, taker cost, one bet = fills of
  the same contract and side at the same millisecond. Every state other than KY and LA reproduces Watchfloor's file
  exactly (25,917 of 25,917 state-hours outside KY, LA, KS, NH). `kalshi_big.json` rows on a race event now carry its race_id.
- Election-night readout for both markets matches a recount from raw (`tools/verify_night.py`).
- **Second audit (Audit/api-race-audit-20261116), all five findings checked and handled:**
  1. *New Hampshire minute candles* were never pulled (its `-28` ticker kept it out of the linked set). Added to the
     linked lists and fetched with `scrape.py`'s own fetchers (`Midterm_markets/backfill_20261116.py`): 5,986 window rows,
     115,010 full-life rows; its night readout now has quotes (checked against raw).
  2. *15 candidate-style winner events* (`KXMISENATE-26`, `KXAKSENATE-26NOV03`, `KXMESENATEPERSON-26`, `KXIASENATE-26`,
     `KXALASKAHOUSE-26`, `KXCA11PERSON-26`, `KXCA17PERSON-26`, `KXCAELECTION-26xx` ×8) are now keyed from their event
     titles and listed in their race's `kalshi_events`, so the Polls vs Kalshi trade and dollar totals include them.
     Prices still come from the party event; `bets_state` still counts each race's own event only (Watchfloor's definition).
  3. *Three-way races:* 15 races list a third contract (an independent or other candidate). There a NO bet is not a
     bet on the other party and P(D) ≠ 1 − P(R). Winners now come from the contract that settled YES; the night export
     marks `binary: false` and the panel draws only Democratic-contract trades as P(D), NO bets as "against";
     `big_bets.json` relabels the two such NO bets (NE Senate $129,518, NE-01 $41,212) as other; `bets_flow.json` moves
     $2.19M of such NO bets to other and adds the three races Watchfloor's list lacked ($3.51M). Originals in `private/`.
  4. *Withdrawn Democrats:* in ID (David Roth), NE (Cindy Burbank) and SD (Julian Beaudion) Senate the race was
     Republican vs an independent (Achilles, Osborn, Bengs). The polls panel uses the independent as the opponent
     (margin "I − R", price row = the independent's contract); each of the seven earlier Democrat polls also polled
     the independent, so it now shows that number from the same survey. Nothing is relabeled.
  5. *Volume shortfalls* on 11 finalized contracts: a complete fresh re-fetch from the API (`raw/trades_refetch_20261116/`)
     returns exactly the trades we hold (0 new trade IDs). Kalshi's volume figure exceeds the trades its API serves by
     0.002–0.26%; this is on Kalshi's side, not a gap in our pull.
- **Still open:** (1) `KXSENATELA-26NOV`, `GOVPARTYKS-27` and `GOVPARTYNH-28` have no market-card file (`data/race/`, `data/trades/`): those come from
  Watchfloor's build script, which is not in the repo; its card says the copy does not include the file. (2) Kentucky
  Senate has no polls: Subhrajit's `polls_full.py` builds its race list from tickers too, so it fetched Louisiana's
  Wikipedia page for `SENATELA-26` and never Kentucky's; VoteHub has no Kentucky Senate polls. (3) Watchfloor's
  national `bets_flow.json` and `big_bets.json` still lack these three markets (national totals only). (4) New Hampshire's
  governor market has no minute candles in our pull, so its election night has only the hourly book. (5) Several races
  also have a candidate-style "who wins" market the crosswalk does not list (e.g. `KXMISENATE-26`, `KXAKSENATE-26NOV03`,
  `KXMESENATEPERSON-26`, `KXCAELECTION-26xx` for the nine California districts); their trades are not in the race totals.

## 20. Exhaustive audit fixes (Audit/exhaustive-65e9295, 2026-11-16)

Every confirmed defect is fixed; Kalshi-side inconsistencies are recorded, and no consumer depends on them.

1. **Glued ticker in the linked lists** (`SENATEMN-26-DGOVPARTYNH-28-D`, from the NH backfill appending to a file
   without a final newline): `build_linked.py` now writes all three lists from one table, newline-terminated, and
   asserts they agree and are in the catalog.
2. **Selector still excluded NH:** `build_linked.py` uses the election year the rules state ("pursuant to the 2026
   election"); the ticker year only when they name none. Asserts KS, NH and both LA/KY Senate events are selected.
   Six 2027 governor contracts (KY, LA, MS) correctly drop out.
3. **Market cards for LA Senate, KS and NH Governor:** `tools/build_market_cards.py` builds every race card, its
   per-day bet files, `big_bets.json` and `bets_flow.json` from our raw trades. Its `--check` mode (Watchfloor's
   rules and race list) reproduces Watchfloor's files: **498 of 498 cards**, all 6,535 national flow bins, and the
   1,500-row big-bets list (two rows differ by 10¢ of float rounding). Remaining tolerances, all checked: a bin
   price may differ only where several fills share one millisecond at different prices; bet times within 1 s
   (truncated to the second here); money within 1¢ (exact decimal half-up here, Watchfloor used floats).
   510 cards written (507 races + 2 control + balance of power). The walkthrough no longer exempts any 404.
4. **Big bets from the added races:** the rebuilt list includes KS Governor $130,715.52 and LA Senate $49,804.39
   and $20,937.17, as the audit found.
5. **Three-way races in cards:** the per-bin D / R / other split now follows the two-way rule; all 71 bins the
   audit flagged hold its independently computed values.
6. **Contract volume shown with a dollar sign:** the market card says "N contracts traded"; the notes explain that
   Kalshi's "$ volume" is a contract count, not money.
7. **Bins from rounded timestamps:** bins use native fill times (rounding only for display / grouping keys). All
   14 national bins the audit flagged now carry its bet counts; dollars agree to the cent or within 4¢ of float sums.

Also: `scrape.py` fails on error responses, missing collection lists and repeating cursors instead of treating them
as empty (fault-injection tested); the night export no longer carries Kalshi's candle volume; and
`raw/provider_anomalies.jsonl` lists the provider inconsistencies (candle volume vs trades, minute vs hour candle
volume, traded hours with no candle, trades after catalog close, catalog volume above the trades the API serves),
each with whether a fresh request reproduced it. Traded quantity and dollars everywhere come from deduplicated trades.
