[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Elies87/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Elies87/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# BTC Race 24h — Trend-Rider Bot

An entry for the make.fun bounty [btc-race-24h-20261123-0511](https://make.fun/bounty/btc-race-24h-20261123-0511): a bot that trades cbBTC against USDC, one one-minute bar at a time, under the `agent-fun/bars-replay/v1` protocol.

`main.ts` (Node 22, standard library only, plus the kit's SDK shim vendored byte-identical under `vendor/`) runs a disciplined trend strategy:

- **Entry** — only on a confirmed uptrend: the 20-bar EMA is above the 100-bar EMA, the trailing 60-bar return is at least +0.30%, and the close is a fresh 60-bar high. It then commits 90% of its cash.
- **Exit** — only risk controls sell: a hard stop at 3% under cost, or a trailing stop 2.5% below the position's best value. A round trip costs roughly 35–45 bps in fees, slippage and impact, so the bot holds through plateau noise instead of churning; after an exit it waits out a 45-bar cooldown and needs the full confirmation again.
- **Fallback** — if no confirmed trend has appeared by bar 1000, it takes one small position (25% of cash) on the least-bad sign available (close above the slow EMA, or a positive 30-bar return), under the same stops, so it stays eligible under the race's at-least-one-trade guardrail.

The bot is fully deterministic: float64 EMA arithmetic over the bars alone, no clock, no randomness, no network.

Dev-window result (the kit's own `grade-local`, dev window of 2026-11-23): **net PnL +$24.40** on the $1,000 start, max drawdown 1.79%, one entry — comfortably past the dev gate (net PnL > 0).

Run it the way the grader does, from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver docker
```

Licensed under the MIT License (see `LICENSE`).
