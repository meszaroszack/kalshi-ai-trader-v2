import { storage } from "./storage";
import * as memory from "./memory";
import {
  getBtcPrice, getBtc15mMarkets, getBalance, getOpenPositions,
  getSettledPositions, getOpenOrders, placeOrder, KalshiMarket
} from "./kalshi";
import type { EventEmitter } from "events";

export interface AIEngineState {
  running: boolean;
  lastRun: Date | null;
  btcPrice: number;
  balance: number;
  openPositions: any[];
  currentMarket: KalshiMarket | null;
  error: string | null;
  priceHistory: Array<{ time: number; price: number }>;
  activeSwingTrade: AISwingTrade | null;
  lastExitReason: string | null;
  lastAIDecision: AIDecision | null;
  aiCallCount: number;
  aiCostEstimate: number;
  performanceContext?: import("./memory").PerformanceContext;
}

interface AISwingTrade {
  tradeId: number;
  orderId: string;
  ticker: string;
  side: "yes" | "no";
  count: number;
  entryPriceInCents: number;
  btcPriceAtEntry: number;
  openedAt: number;
  aiReasoning: string;
  holdToSettlement?: boolean;
  regime?: string;
}

export type Regime = "GRINDING_UP" | "GRINDING_DOWN" | "VOLATILE" | "FLAT_NEAR_STRIKE" | "BREAKOUT";

export interface AIDecision {
  action: "buy_yes" | "buy_no" | "skip";
  confidence: number; // 0-100 (from conviction * 100 for backward compat)
  size_multiplier: 0.5 | 1.0 | 1.5;
  reasoning: string;
  sources?: string[];
  timestamp: Date;
  // V2 fields
  hold_to_settlement?: boolean;
  conviction?: number; // 0–1
  model_probability_yes?: number;
  edge?: number;
  regime?: Regime;
  contracts?: number | null;
  limit_price?: number | null;
}

interface AIExitDecision {
  action: "hold" | "exit";
  reasoning: string;
  confidence: number;
}

const state: AIEngineState = {
  running: false,
  lastRun: null,
  btcPrice: 0,
  balance: 0,
  openPositions: [],
  currentMarket: null,
  error: null,
  priceHistory: [],
  activeSwingTrade: null,
  lastExitReason: null,
  lastAIDecision: null,
  aiCallCount: 0,
  aiCostEstimate: 0,
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let emitter: EventEmitter | null = null;
let priceHistory: number[] = [];

// V2: one entry per market, skip optimization, cooldown
const marketTradeCount = new Map<string, number>();
let consecutiveSkips = 0;
let cooldownSkipsRemaining = 0;
let currentMarketTicker: string | null = null;

export function setEmitter(e: EventEmitter) { emitter = e; }
function broadcast(event: string, data: any) {
  if (emitter) emitter.emit("sse", { event, data });
}
export function getState(): AIEngineState { return { ...state }; }

// ── V2 SYSTEM PROMPT: Quant trend-following, one entry per market, 60s TWAP settlement ──
const SYSTEM_PROMPT = `You are a quantitative trading engine for Kalshi binary prediction markets. You output ONLY valid JSON. No commentary, no markdown. Do NOT search the web. All data you need is in the context provided.

=== WHAT THIS MARKET IS ===

You are trading KXBTC15M — a 15-minute binary "up or down" contract on Bitcoin.

HOW THE PRICE TO BEAT IS SET:
- When each 15-minute window OPENS, Kalshi snapshots the live CF Benchmarks BRTI price of BTC at that exact moment.
- That snapshot becomes the "price_to_beat" for the entire window.
- It is NOT a round number. It is NOT a pre-set level. It is simply: what was BTC's price when this market opened?
- The delta_from_open in your prompt tells you exactly how far BTC has moved from that opening snapshot.

THE QUESTION BEING ASKED IS SIMPLY:
- YES wins ($1.00/contract): BTC's 60-second TWAP at close is ABOVE the opening price
- NO wins ($1.00/contract): BTC's 60-second TWAP at close is BELOW the opening price
- This is a pure up/down trade from the market open price. Nothing more.

HOW TO READ THE DATA YOU ARE GIVEN:
- delta_from_open = how far BTC has moved since this market opened
- Positive delta = BTC is currently ABOVE its opening price = YES is currently winning
- Negative delta = BTC is currently BELOW its opening price = NO is currently winning
- The bigger the delta AND the more consistent the trend, the stronger the signal
- delta of +$200 with 5 minutes left = extremely strong YES signal
- delta of -$50 with 8 minutes left = moderate NO signal, still reversible
- delta near $0 = no edge, do not trade

WHAT THE CONTRACT PRICE TELLS YOU:
- YES at 65¢ = market thinks 65% probability BTC finishes above its open price
- YES at 30¢ = market thinks only 30% probability BTC finishes above open
- The contract price IS the crowd's current probability estimate
- Your job is to find cases where that probability is MISPRICED given what BTC is actually doing right now
- A contract at 35¢ when BTC is $150 above open and grinding up is likely mispriced — that is your edge

SETTLEMENT MECHANIC (CRITICAL):
- At expiration, Kalshi samples BRTI once per second for the final 60 seconds
- It computes the simple average of those 60 prices (TWAP)
- If that 60-second average is above the opening price: YES wins
- Single spikes and wicks do NOT determine settlement — sustained position does
- If BTC has been consistently above open for the last 3+ minutes and is not reversing, YES almost certainly wins
- The TWAP mechanic means slow grinds are more reliable than sudden spikes

THIS IS YOUR CORE PROFIT INSIGHT:
You do NOT need to hold to settlement to profit. If you buy YES at 40¢ and the contract moves to 65¢, you SELL at 65¢ and lock in $0.25/contract profit immediately. This is the primary way to make consistent money — enter at mid-range prices, ride the move for 1–4 minutes, exit when the contract reprices in your favor. You never need to gamble on the final outcome.

=== PRIMARY STRATEGY: MID-RANGE MOMENTUM SCALPING ===

CORE LOGIC:
1. Wait for BTC to establish a clear direction from its opening price
2. Buy the contract matching that direction when it is priced in the 25¢–72¢ range
3. Sell when the contract moves 20–40% in your favor — do not wait for $1.00
4. Never hold a close call through the final 90 seconds

WHY THIS WORKS:
The market constantly overreacts to 30-second BTC moves. A YES contract at 38¢ when BTC is $120 above open with 7 minutes left is underpriced — the crowd is nervous about a reversal that is statistically unlikely given the sustained trend. You buy the underpriced contract, the market corrects, you sell at 60¢+, done. This is repeatable because human fear and greed misprice short-term probabilities constantly.

ENTRY CONDITIONS FOR STANDARD TRADE (ALL must be true):
1. delta_from_open is greater than $60 (BTC has meaningfully moved from open)
2. The trend in the last 15 ticks is consistent with that direction (not choppy)
3. The contract on the winning side is priced between 28¢ and 72¢
4. More than 180 seconds remain
5. No active position is currently open
6. You are not in a loss cooldown period

BUY YES when: delta_from_open is positive AND BTC is trending upward from open
BUY NO when: delta_from_open is negative AND BTC is trending downward from open
Never fight the direction. Never buy the losing side hoping for reversal unless it is a penny hunt (see below).

CONTRACT PRICE TARGETING:
- Ideal entry: 30¢–60¢ (maximum upside, reasonable cost)
- Acceptable entry: 60¢–72¢ (less upside but strong signal, hold to settlement)
- Never buy above 75¢ for a new standard position — the easy move has already happened
- Never buy below 15¢ as a standard trade — use penny hunt rules instead

=== BONUS STRATEGY: PENNY CONTRACT HUNTING ===

THE OPPORTUNITY:
When a contract is priced between 1¢ and 8¢, the market believes that outcome has less than 8% probability. But BTC is volatile. If the market is wrong and BTC starts moving toward that side, the contract reprices explosively — 3¢ to 15¢ is a 400% return. You do NOT need the contract to win at settlement. You just need it to move enough to sell at a profit.

PENNY HUNT ENTRY CONDITIONS (ALL must be true):
1. yes_ask is between 1¢ and 8¢ OR no_ask is between 1¢ and 8¢
2. BTC is within $350 of the open price in the direction of that contract (not mathematically hopeless)
3. More than 180 seconds remain on the market
4. BTC price history shows momentum TOWARD that contract's side in the last 5 ticks (early reversal signal)
5. The bid on that contract is greater than 0 (liquid enough to exit)
6. No active swing trade is currently open
7. You are NOT in a loss cooldown

PENNY HUNT SIZING — ABSOLUTE HARD CAPS (no exceptions):
- Maximum total spend: $1.00 per penny hunt
- If account balance is under $10: maximum $0.50 per penny hunt
- At 3¢/contract: buy max 33 contracts ($0.99)
- At 5¢/contract: buy max 20 contracts ($1.00)
- At 7¢/contract: buy max 14 contracts ($0.98)
- This is a lottery ticket. It must be sized like one. Never exceed $1.00.
- Set conviction: 0.3 and regime: BREAKOUT for all penny hunts so they are identifiable

PENNY HUNT EXIT RULES:
- SELL immediately when contract hits 3x your entry price (e.g. bought at 3¢, sell at 9¢ = 200% gain)
- SELL immediately when contract hits 2x your entry price if under 120 seconds remain
- If it never moves: let it expire worthless — loss is capped at $1.00 max
- Never convert a penny hunt into a hold-to-settlement bet by adding size

PENNY HUNT SKIP CONDITIONS:
- Contract has no bid (no_bid = 0 and yes_bid = 0 on that side — untradeable)
- Less than 180 seconds to close
- BTC is more than $400 away from open price in the wrong direction with under 5 minutes left
- An active swing trade is already open
- You are in a cooldown period after 5 consecutive losses

=== WHAT TO ABSOLUTELY NEVER DO ===

1. Never buy a contract above 80¢ for a new entry — you are buying a nearly-settled contract with no upside
2. Never buy a contract below 1¢ bid — no liquidity means you cannot exit
3. Never enter ANY trade with less than 90 seconds remaining
4. Never enter a standard trade when delta_from_open is less than $40 — no edge, pure gambling
5. Never fight the trend — if BTC has been above open for 8 minutes, do not buy NO hoping for a miracle
6. Never hold a losing position past -40% loss if more than 3 minutes remain — cut it
7. Never open a second position while one is already active
8. Never trade during a 5-loss cooldown period

=== ENTRY PHASES ===

PHASE 1 — OBSERVATION (seconds_to_close > 750):
- Output SKIP for all standard trades
- Penny hunt ONLY if all penny conditions are met and delta_from_open is moving fast

PHASE 2 — PRIMARY WINDOW (300 < seconds_to_close <= 750):
- This is where you make your money. Best edge formation happens here.
- Standard entries: require delta_from_open > $60, consistent trend, contract 28¢–72¢
- Penny hunts: eligible if all penny conditions are met
- Target entering once per market. Do not chase if you miss the setup.

PHASE 3 — LATE ENTRIES (90 < seconds_to_close <= 300):
- Standard entries only with delta_from_open > $120 and very strong consistent trend
- Set hold_to_settlement: true — not enough time to trade in and out
- Contract must be 35¢–70¢
- No penny hunts in this phase

PHASE 4 — SETTLEMENT LOCK (seconds_to_close <= 90):
- ZERO new entries of any kind
- If holding: hold to settlement unless contract is below 75¢ (then exit)

=== EXIT STRATEGY — YOUR MOST IMPORTANT SKILL ===

After entering, your only job is to find the best exit. Check these in order:

EXIT IMMEDIATELY if any of the following are true:
1. Contract has moved UP 35%+ from your entry price at any time → take the profit, done
2. Contract has moved UP 20%+ from entry AND more than 120 seconds remain → take the profit and reset
3. BTC has crossed back through the open price AND held there for 2+ consecutive ticks → thesis broken, exit
4. You are DOWN 40%+ from entry AND more than 180 seconds remain → cut the loss, move on
5. Less than 90 seconds remain AND your contract is below 75¢ → too dangerous, exit
6. Less than 90 seconds remain AND you are holding a penny hunt contract below 2x entry → let expire, do not sell into illiquid book

For penny hunts specifically:
- Exit at 3x entry price immediately (do not be greedy)
- Exit at 2x entry price if under 120 seconds remain
- Otherwise hold to expiry — the max loss is already capped at $1.00

HOLD when:
- Contract is above 80¢ with under 2 minutes left — you are winning, let it settle to $1.00
- Under 90 seconds since entry and you are not significantly down — give the trade time
- Trend is still strongly in your direction and you entered at a fair price in phase 2

=== POSITION SIZING ===

Standard trades:
- Base size: 5% of account balance in whole contracts
- High conviction (conviction > 0.8): up to 8% of balance
- After 3 consecutive losses: reduce to 2% of balance
- After 5 consecutive losses: SKIP all trades for the next 2 full market windows (cooldown)
- Minimum trade: 1 contract
- Do not trade if balance is below $2.00

Penny hunts:
- Always $1.00 maximum total spend (hard cap, never exceeded)
- If balance under $10: maximum $0.50
- Penny hunt budget is SEPARATE from standard trade sizing
- A penny hunt does not count toward the 5% standard allocation

=== OUTPUT FORMAT (valid JSON only) ===
{
  "action": "BUY_YES" | "BUY_NO" | "SKIP",
  "contracts": <int | null>,
  "limit_price": <float | null>,
  "hold_to_settlement": <bool>,
  "conviction": <float 0.0 to 1.0>,
  "model_probability_yes": <float 0.0 to 1.0>,
  "edge": <float>,
  "regime": "GRINDING_UP" | "GRINDING_DOWN" | "VOLATILE" | "FLAT_NEAR_STRIKE" | "BREAKOUT",
  "reasoning": "<2 sentences max — must reference delta_from_open, contract price, and seconds_to_close>"
}`;

// ── PERPLEXITY ENTRY CALL (V2: no web search, temperature 0) ─────────────────
async function askPerplexityEntry(prompt: string, apiKey: string): Promise<AIDecision> {
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 400,
      temperature: 0,
      // Omit search_recency_filter to avoid web search; prompt says "Do NOT search the web"
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  const sources = data.citations ?? [];

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in AI response: " + content);

  const parsed = JSON.parse(jsonMatch[0]);

  const inputTokens = data.usage?.prompt_tokens ?? 500;
  const outputTokens = data.usage?.completion_tokens ?? 100;
  const cost = (inputTokens * 3 / 1_000_000) + (outputTokens * 15 / 1_000_000);
  state.aiCostEstimate += cost;
  state.aiCallCount++;

  // V2 output: BUY_YES | BUY_NO | HOLD | EXIT | SKIP
  const rawAction = (parsed.action ?? "SKIP").toString().toUpperCase();
  const action: "buy_yes" | "buy_no" | "skip" =
    rawAction === "BUY_YES" ? "buy_yes" : rawAction === "BUY_NO" ? "buy_no" : "skip";

  const conviction = Math.min(1, Math.max(0, Number(parsed.conviction) ?? 0.5));
  const confidence = Math.round(conviction * 100);

  // Size: high conviction (>0.8) → 1.5x, else 1.0; we also apply 2% after 3 losses in tryAIEntry
  const sizeMultiplier: 0.5 | 1.0 | 1.5 = conviction > 0.8 ? 1.5 : 1.0;

  return {
    action,
    confidence,
    size_multiplier: sizeMultiplier,
    reasoning: parsed.reasoning ?? "No reasoning provided",
    sources,
    timestamp: new Date(),
    hold_to_settlement: Boolean(parsed.hold_to_settlement),
    conviction,
    model_probability_yes: parsed.model_probability_yes != null ? Number(parsed.model_probability_yes) : undefined,
    edge: parsed.edge != null ? Number(parsed.edge) : undefined,
    regime: parsed.regime ?? undefined,
    contracts: parsed.contracts != null ? Number(parsed.contracts) : null,
    limit_price: parsed.limit_price != null ? Number(parsed.limit_price) : null,
  };
}

// ── PERPLEXITY EXIT CALL ───────────────────────────────────────────────────
async function askPerplexityExit(
  swing: AISwingTrade,
  market: KalshiMarket,
  btcPrice: number,
  prices: number[],
  apiKey: string
): Promise<AIExitDecision> {
  const msToClose = new Date(market.close_time).getTime() - Date.now();
  const secsToClose = Math.round(msToClose / 1000);
  const minsToClose = Math.round(msToClose / 60000);

  const currentBid = swing.side === "yes" ? market.yes_bid : market.no_bid;
  const pnlPct = currentBid > 0
    ? (((currentBid - swing.entryPriceInCents) / swing.entryPriceInCents) * 100).toFixed(1)
    : "unknown";
  const pnlDollars = currentBid > 0
    ? (((currentBid - swing.entryPriceInCents) / 100) * swing.count).toFixed(2)
    : "unknown";

  const btcMoveFromEntry = swing.btcPriceAtEntry > 0
    ? `${btcPrice > swing.btcPriceAtEntry ? "+" : ""}$${(btcPrice - swing.btcPriceAtEntry).toLocaleString("en-US", { maximumFractionDigits: 0 })} since entry`
    : "unknown";

  const holdSeconds = Math.round((Date.now() - swing.openedAt) / 1000);

  // Parse strike from market title
  let strikePrice: number | null = null;
  if (market.title) {
    const dollarMatch = market.title.match(/\$([\d,]+)/);
    if (dollarMatch) strikePrice = parseInt(dollarMatch[1].replace(/,/g, ""));
  }
  const btcVsStrike = strikePrice
    ? (btcPrice > strikePrice
      ? `ABOVE strike by $${(btcPrice - strikePrice).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : `BELOW strike by $${(strikePrice - btcPrice).toLocaleString("en-US", { maximumFractionDigits: 0 })}`)
    : "strike unknown";

  const timeContext = minsToClose > 3
    ? `${minsToClose} minutes`
    : `${secsToClose} seconds`;

  // Recent price momentum
  const calcMove = (n: number) => {
    const s = prices.slice(-n);
    return s.length >= 2 ? (((s[s.length-1] - s[0]) / s[0]) * 100).toFixed(4) + "%" : "N/A";
  };

  const exitPrompt = `ACTIVE TRADE — HOLD OR EXIT?

You currently hold: ${swing.side.toUpperCase()} on ${market.title ?? swing.ticker}
Entry: ${swing.entryPriceInCents}¢ × ${swing.count} contracts | Held for ${holdSeconds}s
Current ${swing.side.toUpperCase()} bid: ${currentBid > 0 ? currentBid + "¢" : "no bid"}
P&L so far: ${pnlPct}% ($${pnlDollars})
BTC move since entry: ${btcMoveFromEntry}
BTC is currently ${btcVsStrike}

MARKET STATUS:
Market closes in: ${timeContext} — this is a 15-MINUTE binary market
Order book: YES ${market.yes_bid}¢ bid / ${market.yes_ask}¢ ask | NO ${market.no_bid}¢ bid / ${market.no_ask}¢ ask

RECENT PRICE MOMENTUM:
  Last 15s (3 ticks): ${calcMove(3)}
  Last 25s (5 ticks): ${calcMove(5)}
  Last 75s (15 ticks): ${calcMove(15)}

Entry reasoning was: "${swing.aiReasoning}"

DECISION: Should we EXIT now or HOLD?

Check these in order and EXIT on the FIRST match:
1. Are we UP 35%+ from entry price at any time? → EXIT (excellent profit, take it now)
2. Are we UP 20%+ from entry AND more than 120 seconds remain? → EXIT (lock in profit and reset)
3. Has BTC crossed back through the open price AND held there for 2 ticks? → EXIT (thesis is broken)
4. Are we DOWN 40%+ from entry AND more than 180 seconds remain? → EXIT (cut losses)
5. Under 90 seconds remain AND contract is below 75¢? → EXIT (too close to call)

HOLD if:
- Contract is above 80¢ with under 2 minutes left — hold to settlement, you are winning
- Under 90 seconds since entry and not significantly down — give it time to develop
- Trend is still strongly in your direction and the entry was well-timed

Respond with ONLY valid JSON:
{
  "action": "hold" | "exit",
  "reasoning": "<1-2 sentences referencing current contract price vs entry, BTC position vs open, and time remaining>",
  "confidence": <number 0-100>
}`;

  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: exitPrompt },
      ],
      max_tokens: 200,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity exit API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";

  // Track cost
  const inputTokens = data.usage?.prompt_tokens ?? 300;
  const outputTokens = data.usage?.completion_tokens ?? 80;
  const cost = (inputTokens * 3 / 1_000_000) + (outputTokens * 15 / 1_000_000);
  state.aiCostEstimate += cost;
  state.aiCallCount++;

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Default to hold if AI response is unparseable — don't panic-exit
    return { action: "hold", reasoning: "Could not parse AI response — holding", confidence: 50 };
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    action: parsed.action === "exit" ? "exit" : "hold",
    reasoning: parsed.reasoning ?? "No reasoning",
    confidence: Math.min(100, Math.max(0, parsed.confidence ?? 50)),
  };
}

// ── BUILD ENTRY PROMPT (V2: seconds_to_close, delta, trend, performance_context) ──
function buildEntryPrompt(
  market: KalshiMarket,
  btcPrice: number,
  prices: number[],
  balance: number,
  recentTrades: any[],
  performanceContext: memory.PerformanceContext
): string {
  const msToClose = new Date(market.close_time).getTime() - Date.now();
  const secsToClose = Math.round(msToClose / 1000);
  const minsToClose = Math.round(msToClose / 60000);

  let openPrice: number | null = null;
  if (market.title) {
    const dollarMatch = market.title.match(/\$([\d,]+)/);
    if (dollarMatch) openPrice = parseInt(dollarMatch[1].replace(/,/g, ""), 10);
  }
  if (!openPrice) openPrice = Math.round(btcPrice / 1000) * 1000;

  const deltaFromOpen = btcPrice - openPrice;
  const calcMove = (n: number) => {
    const s = prices.slice(-n);
    return s.length >= 2 ? (s[s.length - 1] - s[0]) / s[0] : 0;
  };
  const move5 = calcMove(5);
  const move15 = calcMove(15);
  const trendStrength = prices.length >= 10
    ? Math.abs(move15) / 0.001
    : 0; // rough: 0.1% move => 1.0

  const perfStr =
    performanceContext.message ??
    JSON.stringify({
      total_trades: performanceContext.total_trades,
      win_rate: performanceContext.win_rate,
      total_pnl: performanceContext.total_pnl,
      best_regimes: performanceContext.best_regimes,
      worst_regimes: performanceContext.worst_regimes,
      recent_10: performanceContext.recent_10?.slice(0, 5),
    });

  const resolvedTrades = recentTrades.filter((t: any) => t.status === "won" || t.status === "lost").slice(0, 10);
  const tradeHistoryStr =
    resolvedTrades.length === 0
      ? "No completed trades yet."
      : resolvedTrades
          .map(
            (t: any) =>
              `  ${t.status.toUpperCase()} | ${t.side?.toUpperCase()} | P&L: ${t.pnl != null ? (t.pnl >= 0 ? "+" : "") + "$" + t.pnl.toFixed(2) : "—"}`
          )
          .join("\n");

  return `KXBTC15M — ENTRY (output ONLY valid JSON, no markdown)

MARKET:
  ticker: ${market.ticker}
  title: ${market.title ?? market.ticker}
  price_to_beat (BTC opening snapshot when this market opened — NOT a round number strike): $${openPrice.toLocaleString()}
  close_time: ${new Date(market.close_time).toISOString()}

CURRENT STATE:
  btc_spot: ${btcPrice}
  delta_from_open: $${deltaFromOpen.toFixed(0)} (BTC is ${btcPrice >= openPrice ? "ABOVE" : "BELOW"} its opening price — ${btcPrice >= openPrice ? "YES is currently winning" : "NO is currently winning"})
  seconds_to_close: ${secsToClose}
  yes_bid: ${market.yes_bid}¢  yes_ask: ${market.yes_ask}¢
  no_bid: ${market.no_bid}¢  no_ask: ${market.no_ask}¢
  penny_hunt_eligible: ${
    ((market.yes_ask > 0 && market.yes_ask <= 8) || (market.no_ask > 0 && market.no_ask <= 8)) && secsToClose > 180
      ? `YES — ${market.yes_ask > 0 && market.yes_ask <= 8 ? `YES contracts at ${market.yes_ask}¢` : ''} ${market.no_ask > 0 && market.no_ask <= 8 ? `NO contracts at ${market.no_ask}¢` : ''}`.trim()
      : 'NO'
  }

PRICE HISTORY (last 30 ticks, OLDEST → NEWEST):
  ${prices.slice(-30).map((p) => Math.round(p)).join(" ")}

TREND (fractional move):
  last 5 ticks: ${move5.toFixed(6)}
  last 15 ticks: ${move15.toFixed(6)}
  trend_strength (approx): ${Math.min(2, trendStrength).toFixed(2)}

BALANCE: $${balance.toFixed(2)}. Minimum trade 1 contract. Base size 5% of balance; high conviction up to 8%.

PERFORMANCE CONTEXT (use to adapt; after 3 consecutive losses use 2% size; after 5 consecutive losses you will be in cooldown):
${perfStr}

RECENT TRADES (session):
${tradeHistoryStr}

Output valid JSON only with keys: action, contracts, limit_price, hold_to_settlement, conviction, model_probability_yes, edge, regime, reasoning.`;
}

// ── EXIT CHECK ────────────────────────────────────────────────────────────
async function checkExit(settings: any, creds: any, swing: AISwingTrade, market: KalshiMarket) {
  const msToClose = new Date(market.close_time).getTime() - Date.now();

  // HARD EXIT 1: Market rolled to new ticker — settle and move on
  if (swing.ticker !== market.ticker) {
    let resolvedPnl: number | null = null;
    let resolvedStatus = "settled";
    if (creds) {
      try {
        const settled = await getSettledPositions(creds.apiKeyId, creds.privateKeyPem, creds.environment);
        const pos = settled.find((p: any) => p.ticker === swing.ticker);
        if (pos) {
          const realized = pos.realized_pnl ?? pos.pnl ?? null;
          if (realized !== null) { resolvedPnl = realized / 100; resolvedStatus = resolvedPnl >= 0 ? "won" : "lost"; }
          else if (pos.settlement_value !== undefined) {
            resolvedPnl = (pos.settlement_value / 100) - (swing.entryPriceInCents / 100 * swing.count);
            resolvedStatus = resolvedPnl >= 0 ? "won" : "lost";
          }
        }
      } catch {}
    }
    await storage.updateTrade(swing.tradeId, {
      status: resolvedStatus, pnl: resolvedPnl,
      signalReason: `SETTLED: market closed${resolvedPnl !== null ? ` | P&L: $${resolvedPnl.toFixed(2)}` : ""}`,
      resolvedAt: new Date(),
    });
    if (resolvedPnl !== null) memory.backfillSettlement(swing.ticker, resolvedStatus, resolvedPnl);
    state.activeSwingTrade = null;
    state.lastExitReason = `Market closed — settled${resolvedPnl !== null ? ` (${resolvedPnl >= 0 ? "+" : ""}$${resolvedPnl.toFixed(2)})` : ""}`;
    broadcast("info", { message: state.lastExitReason });
    return;
  }

  // HARD EXIT 2: Market already closed
  if (msToClose <= 0) {
    await storage.updateTrade(swing.tradeId, { status: "settled", resolvedAt: new Date() });
    state.activeSwingTrade = null;
    state.lastExitReason = "Market closed — settled";
    return;
  }

  // HARD EXIT 3: Final 15 seconds — pure safety, no AI call
  if (msToClose < 15_000) {
    const currentBid = swing.side === "yes" ? market.yes_bid : market.no_bid;
    const currentAsk = swing.side === "yes" ? market.yes_ask : market.no_ask;
    const hasBid = currentBid > 0;

    if (hasBid) {
      try {
        // Taker: sell at bid to hit the bid and get filled immediately (not maker at ask)
        const exitPrice = Math.max(1, Math.min(99, currentBid));
        await placeOrder(creds.apiKeyId, creds.privateKeyPem, swing.ticker, swing.side, "sell", swing.count, exitPrice, creds.environment);
        const pnlDollars = ((currentBid - swing.entryPriceInCents) / 100) * swing.count;
        await storage.updateTrade(swing.tradeId, {
          status: pnlDollars >= 0 ? "won" : "lost",
          pnl: pnlDollars,
          resolvedAt: new Date(),
          signalReason: `EXIT: Final 15s safety exit (P&L: ${pnlDollars >= 0 ? "+" : ""}$${pnlDollars.toFixed(2)})`,
        });
        memory.backfillSettlement(swing.ticker, pnlDollars >= 0 ? "won" : "lost", pnlDollars);
        state.lastExitReason = `Safety exit at close | P&L: ${pnlDollars >= 0 ? "+" : ""}$${pnlDollars.toFixed(2)}`;
        state.activeSwingTrade = null;
        broadcast("trade", { message: `Safety exit: ${swing.side.toUpperCase()} sold @ ${exitPrice}¢ | final 15s`, pnl: pnlDollars });
      } catch (e: any) {
        // No bid? Let it settle naturally
        await storage.updateTrade(swing.tradeId, { status: "settled", resolvedAt: new Date() });
        state.activeSwingTrade = null;
        state.lastExitReason = "Settled at close (no liquidity for safety exit)";
      }
    } else {
      await storage.updateTrade(swing.tradeId, { status: "settled", resolvedAt: new Date() });
      state.activeSwingTrade = null;
      state.lastExitReason = "Settled at close (no liquidity)";
    }
    return;
  }

  // HARD EXIT 4: No liquidity near close
  const currentBid = swing.side === "yes" ? market.yes_bid : market.no_bid;
  if (msToClose < 30_000 && currentBid <= 0) {
    await storage.updateTrade(swing.tradeId, { status: "settled", resolvedAt: new Date() });
    state.activeSwingTrade = null;
    state.lastExitReason = "Settled at close (no liquidity)";
    return;
  }

  // ── AI EXIT DECISION ──────────────────────────────────────────────────
  const perplexityKey = settings.perplexityApiKey;
  if (!perplexityKey) {
    // No key = hold until hard exits trigger
    return;
  }

  try {
    const exitDecision = await askPerplexityExit(swing, market, state.btcPrice, priceHistory, perplexityKey);
    console.log(`[AI Exit] ${exitDecision.action} (${exitDecision.confidence}%) — ${exitDecision.reasoning}`);
    broadcast("ai_exit", { ...exitDecision, ticker: swing.ticker, side: swing.side });

    if (exitDecision.action === "exit") {
      const bidNow = swing.side === "yes" ? market.yes_bid : market.no_bid;
      const askNow = swing.side === "yes" ? market.yes_ask : market.no_ask;
      const hasBid = bidNow > 0;

      if (!hasBid) {
        // AI wants out but no liquidity — note it and wait for hard exit
        state.lastExitReason = `AI wants to exit but no liquidity — waiting for close`;
        broadcast("info", { message: state.lastExitReason });
        return;
      }

      // Taker: sell at bid to get filled immediately (not maker at ask)
      const exitPrice = Math.max(1, Math.min(99, bidNow));
      await placeOrder(creds.apiKeyId, creds.privateKeyPem, swing.ticker, swing.side, "sell", swing.count, exitPrice, creds.environment);
      const pnlDollars = ((bidNow - swing.entryPriceInCents) / 100) * swing.count;
      await storage.updateTrade(swing.tradeId, {
        status: pnlDollars >= 0 ? "won" : "lost",
        pnl: pnlDollars,
        resolvedAt: new Date(),
        signalReason: `EXIT [AI ${exitDecision.confidence}%]: ${exitDecision.reasoning}`,
      });
      memory.backfillSettlement(swing.ticker, pnlDollars >= 0 ? "won" : "lost", pnlDollars);
      state.lastExitReason = `AI exit: ${exitDecision.reasoning} | P&L: ${pnlDollars >= 0 ? "+" : ""}$${pnlDollars.toFixed(2)}`;
      state.activeSwingTrade = null;
      broadcast("trade", {
        message: `AI exit: ${swing.side.toUpperCase()} sold @ ${exitPrice}¢ | ${exitDecision.reasoning}`,
        pnl: pnlDollars,
      });
    }
    // hold = do nothing, revisit next poll
  } catch (e: any) {
    // AI exit call failed — log it, hold the trade (don't panic)
    const errMsg = "AI exit call failed: " + e.message + " — holding";
    state.error = errMsg;
    console.error("[AI Exit Error]", e.message);
  }
}

// ── MAIN CYCLE ────────────────────────────────────────────────────────────
async function runCycle() {
  const settings = await storage.getBotSettings();
  const creds    = await storage.getCredentials();

  // BTC price
  try {
    const price = await getBtcPrice();
    if (price > 0) {
      state.btcPrice = price;
      priceHistory.push(price);
      if (priceHistory.length > 200) priceHistory.shift();
      state.priceHistory.push({ time: Date.now(), price });
      if (state.priceHistory.length > 120) state.priceHistory.shift();
    }
  } catch (e: any) { state.error = "BTC fetch failed: " + e.message; }

  // Markets
  try {
    const markets = await getBtc15mMarkets(creds?.environment ?? "production");
    if (markets.length > 0) {
      const valid = [...markets]
        .filter(m => m.ticker.startsWith("KXBTC15M") && m.status === "open" && new Date(m.close_time).getTime() > Date.now())
        .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());
      state.currentMarket = valid[0] ?? markets[0];
    }
  } catch (e: any) { state.error = "Market fetch failed: " + e.message; }

  // Balance
  if (creds) {
    try {
      state.balance = await getBalance(creds.apiKeyId, creds.privateKeyPem, creds.environment);
      state.openPositions = await getOpenPositions(creds.apiKeyId, creds.privateKeyPem, creds.environment);
      state.error = null;
    } catch (e: any) { state.error = "Auth failed: " + e.message; }
  }

  state.lastRun = new Date();

  // V2: performance context for frontend and AI
  const performanceContext = memory.getPerformanceContext(30);
  state.performanceContext = performanceContext;

  if (settings.enabled && creds && state.currentMarket) {
    if (state.activeSwingTrade) {
      await checkExit(settings, creds, state.activeSwingTrade, state.currentMarket);
    }

    const marketTicker = state.currentMarket.ticker;
    if (currentMarketTicker !== marketTicker) {
      if (cooldownSkipsRemaining > 0) cooldownSkipsRemaining--;
      marketTradeCount.delete(currentMarketTicker ?? "");
      currentMarketTicker = marketTicker;
      consecutiveSkips = 0; // New market = fresh chance to call AI (prevents "freeze" after 3 SKIPs)
    }
    if (cooldownSkipsRemaining === 0) {
      const cooldown = memory.checkCooldown();
      if (cooldown > 0) cooldownSkipsRemaining = cooldown;
    }

    if (!state.activeSwingTrade && priceHistory.length >= 5 && cooldownSkipsRemaining === 0) {
      const msToClose = new Date(state.currentMarket.close_time).getTime() - Date.now();
      const secondsToClose = Math.round(msToClose / 1000);
      if (msToClose >= 90_000) {
        if (state.balance >= settings.targetBalance) {
          await storage.updateBotSettings({ enabled: false });
          broadcast("info", { message: `Target $${settings.targetBalance} reached — bot paused` });
        } else {
          if (secondsToClose < 600) consecutiveSkips = 0;
          if (consecutiveSkips >= 3) {
            console.log("[AI] Skipping this cycle — 3 consecutive skips, waiting for next market");
            broadcast("info", { message: "AI skipping — 3 consecutive skips" });
          } else {
            await tryAIEntry(settings, creds, state.currentMarket, performanceContext);
          }
        }
      }
    }
  }

  broadcast("state", {
    btcPrice: state.btcPrice,
    balance: state.balance,
    openPositions: state.openPositions,
    currentMarket: state.currentMarket,
    error: state.error,
    lastRun: state.lastRun,
    priceHistory: state.priceHistory,
    activeSwingTrade: state.activeSwingTrade,
    lastExitReason: state.lastExitReason,
    lastAIDecision: state.lastAIDecision,
    aiCallCount: state.aiCallCount,
    aiCostEstimate: state.aiCostEstimate,
    performanceContext: state.performanceContext,
  });
}

// V2: allow up to 3 trades per market window
function shouldTrade(marketTicker: string, action: string): boolean {
  if (action === "skip" || action === "HOLD" || action === "EXIT" || action === "SKIP") return true;
  if ((marketTradeCount.get(marketTicker) ?? 0) >= 3) return false;
  return true;
}

// ── AI ENTRY (V2: performance context, one per market, position sizing, memory log) ──
async function tryAIEntry(
  settings: any,
  creds: any,
  market: KalshiMarket,
  performanceContext: memory.PerformanceContext
) {
  const perplexityKey = settings.perplexityApiKey;
  if (!perplexityKey) {
    state.error = "No Perplexity API key set — add it in Settings";
    return;
  }

  if (state.balance < 2) return;

  let decision: AIDecision;
  try {
    const recentTrades = await storage.getTrades(10);
    const prompt = buildEntryPrompt(
      market,
      state.btcPrice,
      priceHistory,
      state.balance,
      recentTrades,
      performanceContext
    );
    decision = await askPerplexityEntry(prompt, perplexityKey);
    state.lastAIDecision = decision;
    broadcast("ai_decision", decision);
    console.log(`[AI Entry] ${decision.action} (${decision.confidence}%, regime=${decision.regime}) — ${decision.reasoning}`);
  } catch (e: any) {
    state.error = "AI call failed: " + e.message;
    return;
  }

  if (decision.action === "skip") {
    consecutiveSkips++;
    console.log(`[AI] Skipping — no edge (consecutive skips: ${consecutiveSkips})`);
    return;
  }

  consecutiveSkips = 0;

  if (!shouldTrade(market.ticker, decision.action)) {
    console.log(`[AI] Blocked: already traded this market (one entry per market)`);
    return;
  }

  const side: "yes" | "no" = decision.action === "buy_yes" ? "yes" : "no";
  const priceInCents = Math.max(
    1,
    Math.min(
      99,
      side === "yes"
        ? market.yes_ask > 0 ? market.yes_ask : market.yes_bid > 0 ? market.yes_bid + 1 : 50
        : market.no_ask > 0 ? market.no_ask : market.no_bid > 0 ? market.no_bid + 1 : 50
    )
  );

  // V2 position sizing: base 5%, high conviction 8%, after 3 consecutive losses 2%
  const consecutiveLosses = memory.getConsecutiveLosses();
  const riskPct =
    consecutiveLosses >= 3 ? 2 : (decision.conviction ?? decision.confidence / 100) > 0.8 ? 8 : 5;
  const baseAmount = state.balance * (riskPct / 100);
  const scaledAmount = Math.min(baseAmount, state.balance * (settings.riskPercent / 100) * (decision.size_multiplier ?? 1));
  const count = Math.max(1, Math.floor(scaledAmount / (priceInCents / 100)));
  const actualCost = count * (priceInCents / 100);

  let strikePrice: number | null = null;
  if (market.title) {
    const m = market.title.match(/\$([\d,]+)/);
    if (m) strikePrice = parseInt(m[1].replace(/,/g, ""), 10);
  }
  if (!strikePrice) strikePrice = Math.round(state.btcPrice / 1000) * 1000;
  const msToClose = new Date(market.close_time).getTime() - Date.now();
  const marketContext: memory.MarketContext = {
    ticker: market.ticker,
    btc_spot: state.btcPrice,
    price_to_beat: strikePrice,
    delta_from_strike: state.btcPrice - strikePrice,
    seconds_to_close: Math.round(msToClose / 1000),
  };

  try {
    const order = await placeOrder(creds.apiKeyId, creds.privateKeyPem, market.ticker, side, "buy", count, priceInCents, creds.environment);
    marketTradeCount.set(market.ticker, (marketTradeCount.get(market.ticker) ?? 0) + 1);

    memory.logDecision(
      {
        action: decision.action === "buy_yes" ? "BUY_YES" : "BUY_NO",
        side: side.toUpperCase(),
        contracts: count,
        limit_price: priceInCents,
        conviction: decision.conviction ?? decision.confidence / 100,
        model_probability_yes: decision.model_probability_yes,
        edge: decision.edge,
        regime: decision.regime,
        reasoning: decision.reasoning,
      },
      marketContext
    );

    const trade = await storage.createTrade({
      orderId: order.order_id,
      ticker: market.ticker,
      side,
      action: "buy",
      count,
      pricePerContract: priceInCents,
      totalCost: actualCost,
      status: "open",
      signalReason: `[AI V2 ${decision.confidence}% ${decision.regime ?? ""}] ${decision.reasoning}`,
      btcPriceAtTrade: state.btcPrice,
      marketTitle: market.title,
      settingsVersion: settings.settingsVersion,
    });

    // Confirm fill: if order_id is NOT in resting orders, it was filled immediately
    try {
      const restingOrders = await getOpenOrders(creds.apiKeyId, creds.privateKeyPem, creds.environment);
      const isResting = restingOrders.some((o: any) => o.order_id === order.order_id);
      if (!isResting) {
        await storage.updateTrade(trade.id, { status: "filled" });
      }
    } catch (e: any) {
      console.error("[AI] Failed to confirm order fill status:", e.message);
    }

    state.activeSwingTrade = {
      tradeId: trade.id,
      orderId: order.order_id,
      ticker: market.ticker,
      side,
      count,
      entryPriceInCents: priceInCents,
      btcPriceAtEntry: state.btcPrice,
      openedAt: Date.now(),
      aiReasoning: decision.reasoning,
      holdToSettlement: decision.hold_to_settlement,
      regime: decision.regime,
    };

    broadcast("trade", {
      message: `AI entry: ${side.toUpperCase()} ${count}x @ ${priceInCents}¢ (hold_to_settlement=${decision.hold_to_settlement}) | ${decision.reasoning}`,
      trade,
    });
    console.log(`[AI] Entered ${side} ${count}x @ ${priceInCents}¢ (hold_to_settlement=${decision.hold_to_settlement}, regime=${decision.regime})`);
  } catch (e: any) {
    state.error = "Order failed: " + e.message;
  }
}

export async function startEngine() {
  if (intervalHandle) return;
  state.running = true;
  state.activeSwingTrade = null;
  await runCycle();
  const settings = await storage.getBotSettings();
  const pollMs = (settings.pollInterval ?? 15) * 1000;
  intervalHandle = setInterval(runCycle, pollMs);
  console.log(`[AI Engine] Started — polling every ${settings.pollInterval ?? 15}s`);
}

export function stopEngine() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  state.running = false;
  state.activeSwingTrade = null;
}

export async function restartEngine() { stopEngine(); await startEngine(); }
