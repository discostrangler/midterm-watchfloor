# Midterm Watchfloor · election-night edition

A replay console for the 2026 U.S. midterms that lines up Kalshi prices, quotes and every trade with what
political streamers were saying on election night. Static site, no build step.

**Credits.** Built on [Lawrence Lu's Midterm Watchfloor](https://github.com/LawrenceLu0904/midterm-watchfloor)
(the page, map, timeline, market card, trades and most data layers; his original README follows below), with
election-night stream, poll and Bluesky data from Subhrajit's
[kalshis_eye](https://github.com/subro608/kalshis_eye). Kalshi data from the Kalshi public API.

## What this edition adds
- **Election night panel** (Nov 3 6 PM – Nov 4 8 AM ET), following the page cursor: Senate and House control
  plus any of the 504 races picked on the map, the dropdown or the heatmap. Bid, ask and quoted midpoint at
  each minute's end, with the quote's age; every trade at its exact execution time; Kalshi's trading close
  and settlement shown separately (neither is a media call); the streams on air, each with a link to the
  original video at that moment and its chat messages per minute.
- **One price definition** for the map, state panel, timeline and heatmap: the quoted midpoint of the
  Democratic contract of each race's party event. Periods without a two-sided quote show as gaps. The market
  card's percentages are last trades and say so, with the quoted midpoint next to them on election night.
- **One result and settlement time per race** everywhere, from the Democratic contract (this fixes WA-09,
  whose date came from an eliminated candidate's contract).
- **Heatmap** row order and upset list from the 6 PM ET Nov 3 quoted midpoint, with quote time and spread.
- **Race crosswalk and coverage tables** in `crosswalk/`, and a panel-by-panel description in `DASHBOARD.md`.

## What is public and what is not
Public here: Kalshi market data (trades are anonymous), counts, stream metadata and links to the original
streams. **Not published:** stream transcripts, chat messages, video files, post text or usernames. Those stay
in a private research copy (`private/`, git-ignored); the page notes where they would appear.

## Rebuilding the election-night and campaign data
`tools/` holds the builders. They read our raw Kalshi pull (`KALSHI_RAW`, default `../../raw`) and
Subhrajit's stream data (`STREAMS_WINDOW`); neither is in this repo.
`build_crosswalk.py` → `crosswalk/`; `build_races_night.py` → `data/night_state/`, `data/night_races.json`,
`crosswalk/night_coverage.tsv`; `build_night.py` → control markets and streams; `build_campaign.py` →
`data/race_odds.json`, `data/heatmap.json`, `data/races.json`; `verify_night.py` checks the built files
against the raw pull; `walkthrough.py` clicks through every view headless.

---

# Original README (Lawrence Lu)

# Midterm Watchfloor

**Live site: https://lawrencelu0904.github.io/midterm-watchfloor/**

A replay console for the 2026 U.S. midterms: what was happening, when and where. Kalshi prices and bets, race settlements, Reddit and Bluesky activity, election-night streams, gas prices and weather are lined up on one timeline and one map.

Open `index.html` through any static web server (this repository is served with GitHub Pages). There's no build step: plain HTML, CSS and JavaScript with a vendored copy of d3 v7.9.0.

## What you can do
- **Timeline.** Drag the cursor across the time lanes, press Play, or switch between election night, Nov 1–8 and Oct 4 – Nov 12. Amber diamonds mark key moments.
- **Map layers.**
  - Races: Kalshi odds, then the settled result.
  - Bets: dollars bet on each state's races per hour.
  - Social: comments in the state's subreddit compared with its usual hour.
  - Also gas price, rain and turnout markets.
- **State panel.** Click a state for its races, odds, bets, social activity, gas price, weather and turnout market.
- **Key moments**, split into before election day, election night and after:
  - **Before:** the sharpest 24-hour swings in chamber control and race odds, the largest bets, surges on political Reddit, and big stock-market days.
  - **Election night:** the chamber-control settlements, the biggest race calls, 15-minute swings and the largest bets.
  - **After:** races Kalshi settled later.
  - Each moment can show the public posts made around it, through Bluesky's, Reddit's and X's own embeds.
- **Every race · 120 days.** A heatmap of the Kalshi chance the Democrat wins for all 504 races (34 Senate, 34 Governor, all 435 House seats plus DC's delegate) on a log time axis, ending at each race's settlement or at Nov 10. Hover a row to see the race, click it to open its market, and see the 20 races where the election-eve favorite lost.
- **Polls.** Each race's market card lists its public polls up to the cursor, with the average margin of the latest five, next to the market's odds.
- **Market card.** Laid out the way Kalshi shows a market: each outcome's chance over time, Yes/No prices, volume and settlement. Besides every midterm race, it opens the most-traded Kalshi events in each category: sports games (election night was Tuesday-night college football, tennis, cricket and the Champions League), crypto, stock indexes, other elections such as the Los Angeles mayor's race, finance, weather and more.
- **Trades.** Every bet in the chosen market up to the cursor, the largest midterm bets, or the largest bets anywhere on Kalshi.
- **All of Kalshi.** One timeline lane per category (other politics, sports, crypto, parlays, stock indexes, finance, weather, other), so the midterms can be seen in context. A stocks lane adds S&P 500, Nasdaq and VIX daily closes.

## Data (`data/`)
Each JSON file is `{rows: [...], meta: {inputs}}`. Times are UTC Unix seconds; the page shows US Eastern time.

| file | what |
|---|---|
| `races`, `race_odds`, `milestones`, `control` | Kalshi 2026 Senate, Governor and House race markets (34 Senate, 34 Governor, all 435 House seats plus DC's delegate; Kentucky's Senate race had no winner market): winner, settlement time, hourly odds (per minute on election night, from 1-minute bid/ask candles); chamber-control odds (per minute on election night) |
| `bets_flow`, `bets_state`, `big_bets`, `race/<id>` | Kalshi trades, Oct 4 – Nov 12, grouped into bets (one taker order = all its fills at one instant), by which party the bet backs (midterm markets include chamber control and the House + Senate balance-of-power market); each race file also has every outcome's last traded price per minute (election night) or per 10 minutes |
| `trades/<race>/<day>` | Every bet in that race's markets on that Eastern-time day: `[time, outcome, Yes=1/No=0, price paid, contracts, $ paid]` |
| `heatmap` | Every race's Kalshi chance the Democrat wins over 120 days at 360 log-spaced times, in two views (ending at each race's settlement, or at Nov 10 12 AM ET), from per-minute bid/ask candles; one byte per cell, base64. Also the 20 races where the 6 PM ET Nov 3 favorite lost. |
| `polls` | General-election polls since Aug 1 for 148 races (1,146 polls, one version per pollster and date), from Wikipedia (CC BY-SA 4.0) and VoteHub (CC BY 4.0), matched to Kalshi races |
| `stocks` | Daily closes of the S&P 500, Nasdaq Composite, Dow and VIX (FRED) |
| `kalshi_index` | Election night, every 5 minutes: the Kalshi-implied S&P 500 and Nasdaq-100 at 10 AM, 11 AM and 4 PM on Nov 4, from every trade in Kalshi's "at or above K" ladders. Each point is the strike where the chance crosses 50%, as a % change from the Nov 3 close. Also the chance the S&P closed Nov 4 higher, and the values Kalshi settled at. |
| `markets_index`, `race/<event>`, `trades/<event>/<day>` | The most-traded non-midterm Kalshi events per category: hourly prices from Kalshi candlesticks, plus per-minute prices and every bet on election night |
| `kalshi_cats`, `kalshi_big` | The whole Kalshi exchange: contracts traded by category per minute on election night, Nov 3 5 PM – Nov 4 11 AM ET (every trade) and per hour otherwise (estimated from short-lived markets), and the largest bets anywhere on Kalshi on election night |
| `reddit_hourly`, `reddit_night` | Post and comment counts per hour, Oct 4 – Nov 12 (per minute on election night) for national political subreddits and one main subreddit per state, from the Arctic Shift Reddit archive |
| `bluesky` | Election-night Bluesky sample: top posts per candidate / state query, counts per 10 minutes and state |
| `moments` | Key moments before election day, on election night and after, each with links to public Bluesky, Reddit and X posts to embed |
| `streams`, `chat`, `polymarket` | Election-night political streams (on-air times), live-chat messages per minute, Polymarket comments per hour |
| `states_geo` | State outlines (us-atlas, Census cartographic boundaries) |
| `gas`, `oil`, `weather_state`, `weather_grid`, `turnout_races`, `turnout_daily` | AAA gas and WTI/Brent via Kalshi's settled markets; NOAA GHCN-Daily station weather; Kalshi turnout markets with the last midterm Senate total (MEDSL) |

## What is and isn't published
- **Published:**
  - Kalshi market data (trades are anonymous)
  - counts
  - links to public posts
- **Not published:**
  - any post text, image, username or chat message
  - any video
- **How embedded posts work:**
  - They render from Bluesky, Reddit and X only after a viewer clicks "Show posts", so a deleted post stops showing.
  - Bluesky embeds are limited to accounts with 25,000+ followers. Reddit embeds are limited to posts with 50+ points.
  - X posts are ones linked from those Reddit posts, checked with X's public embed endpoint. We don't use X's paid API or scrape X, so there are no X post counts.

Official vote counts and AP call times are not included yet.

## Sources
Kalshi Trade API · AAA (via Kalshi settlement values) · NOAA NCEI GHCN-Daily · MIT Election Data and Science Lab · Wikipedia and VoteHub (polls) · Arctic Shift (Reddit archive) · Bluesky public API · X embeds (publish.x.com) · FRED (stock indexes) · Polymarket Gamma API · YouTube live-chat replays (counts only) · us-atlas (Census cartographic boundaries) · d3 (ISC license).

This is an independent research project. It is not affiliated with or endorsed by Kalshi, Polymarket, Reddit, Bluesky or any other source.
