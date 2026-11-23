// Trend-rider bot for the make.fun cbBTC 24h race (agent-fun/bars-replay/v1).
//
// A full round trip costs roughly 35-45 bps in fees, slippage and price
// impact, so this bot trades as rarely as it can get away with:
//
//   Entry: the fast EMA is above the slow EMA, the trailing 60-bar return
//     is at least +0.30%, and the close is a fresh 60-bar high. Together
//     they say a real move is under way, not one-minute noise. It then
//     commits 90% of its cash and, in the ordinary run of things, simply
//     holds: with costs this size, selling on every wobble of the trend
//     gives the move back to the market.
//   Exit: only risk controls fire a sale — the position worth 3% less
//     than its cost (hard stop), or its value 2.5% below the best it has
//     reached (a trailing stop wide enough to ignore plateau noise and
//     lock in only a genuine reversal). After an exit, a cooldown and
//     the full entry confirmation are both required again.
//   Fallback: a bot that never trades fails the race's guardrail, so if
//     no confirmed trend has appeared by bar 1000 it takes one small
//     position (25% of cash) on the least-bad sign available — the close
//     above the slow EMA, or a positive 30-bar return — under the same
//     stops. It risks a few dollars to stay eligible.
//
// Everything derives from the bars alone (float64 EMA arithmetic, no
// clock, no randomness), so both graded runs agree byte for byte.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** EMA spans in bars: a 20-bar fast line against a 100-bar slow line. */
const FAST_SPAN = 20;
const SLOW_SPAN = 100;
/** Trailing window for the momentum and breakout checks. */
const MOMENTUM_BARS = 60;
/** Minimum trailing return, as a fraction, before an entry is confirmed. */
const MIN_TREND_RETURN = 0.003;
/** Share of the cash balance the confirmed entry spends (9000 = 90%). */
const SIZE_BPS = 9000n;
/** Hard stop: exit when the position is worth this fraction under its cost. */
const STOP_LOSS = 0.03;
/** Trailing stop: exit when value falls this fraction below its best ratio to cost. */
const TRAIL_DROP = 0.025;
/** Bars to sit out after an exit before any re-entry. */
const COOLDOWN_BARS = 45;
/** Bar from which the fallback entry arms, if nothing has traded yet:
 * late enough that a real trend has had most of the day to show itself. */
const FALLBACK_BAR = 1000;
/** Share of cash the fallback entry spends (2500 = 25%). */
const FALLBACK_SIZE_BPS = 2500n;
/** Slippage cap on every order: fills rarely move 2% in one minute. */
const MAX_SLIPPAGE_BPS = 200;

/** One EMA, seeded with the mean of its first span of closes (as freqtrade does). */
class Ema {
  value: number | null = null;
  readonly span: number;
  #warm: number[] = [];
  constructor(span: number) {
    this.span = span;
  }
  step(close: number): void {
    if (this.value !== null) {
      this.value += (2 / (this.span + 1)) * (close - this.value);
      return;
    }
    this.#warm.push(close);
    if (this.#warm.length === this.span) {
      this.value = this.#warm.reduce((a, x) => a + x, 0) / this.span;
    }
  }
}

const fast = new Ema(FAST_SPAN);
const slow = new Ema(SLOW_SPAN);
/** Every close seen, oldest first; only the tail is ever read. */
const closes: number[] = [];
/** Bars since the last exit (Infinity while never traded or long ago). */
let barsSinceExit = Number.POSITIVE_INFINITY;
/** Best value/cost ratio of the open position so far; null while flat. */
let peakRatio: number | null = null;
/** Whether the previous batch held a position (to spot the exit bar). */
let wasHolding = false;
/** Whether any position has been held this run (the fallback disarms). */
let traded = false;

function trailingReturn(bars: number): number | null {
  if (closes.length <= bars) return null;
  const then = closes[closes.length - 1 - bars]!;
  return closes[closes.length - 1]! / then - 1;
}

function isBreakout(): boolean {
  if (closes.length <= MOMENTUM_BARS) return false;
  const last = closes[closes.length - 1]!;
  for (let i = closes.length - 1 - MOMENTUM_BARS; i < closes.length - 1; i++) {
    if (closes[i]! >= last) return false;
  }
  return true;
}

function entryConfirmed(): boolean {
  if (fast.value === null || slow.value === null) return false;
  if (fast.value <= slow.value) return false;
  const ret = trailingReturn(MOMENTUM_BARS);
  if (ret === null || ret < MIN_TREND_RETURN) return false;
  return isBreakout();
}

/** The fallback's least-bad sign: price above the slow trend line, or rising over 30 bars. */
function fallbackConfirmed(): boolean {
  const last = closes[closes.length - 1]!;
  if (slow.value !== null && last > slow.value) return true;
  const ret = trailingReturn(30);
  return ret !== null && ret > 0;
}

function buyOrder(state: BarsState, sizeBps: bigint): BuyInput | null {
  let notional = (state.cash * sizeBps) / 10_000n;
  const room = state.weightRoom(SYMBOL);
  if (notional > room) notional = room;
  if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state: BarsState) {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined || bar.t !== state.t) return [];
    const close = Number(bar.c);
    closes.push(close);
    fast.step(close);
    slow.step(close);
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      wasHolding = true;
      traded = true;
      const value = state.value(SYMBOL, held.qty);
      const ratio = Number(value) / Number(held.cost);
      if (peakRatio === null || ratio > peakRatio) peakRatio = ratio;
      const stopped = ratio <= 1 - STOP_LOSS;
      const trailed = peakRatio !== null && ratio <= peakRatio - TRAIL_DROP;
      if (stopped || trailed) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    if (wasHolding) {
      // The position vanished since the last batch: that was our exit fill.
      wasHolding = false;
      peakRatio = null;
      barsSinceExit = 0;
    } else if (barsSinceExit !== Number.POSITIVE_INFINITY) {
      barsSinceExit++;
    }

    if (barsSinceExit >= COOLDOWN_BARS && entryConfirmed()) {
      const order = buyOrder(state, SIZE_BPS);
      if (order !== null) orders.push(order);
    } else if (!traded && closes.length >= FALLBACK_BAR && fallbackConfirmed()) {
      const order = buyOrder(state, FALLBACK_SIZE_BPS);
      if (order !== null) orders.push(order);
    }
    return orders;
  },
});
