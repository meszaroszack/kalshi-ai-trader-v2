import { storage } from "./storage";
import * as memory from "./memory";
import {
  getBtcPrice, getBtc15mMarkets, getBalance, getOpenPositions,
  getSettledPositions, placeOrder, KalshiMarket
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
const tradedMarkets = new Set<string>();
let consecutiveSkips = 0;
let cooldownSkipsRemaining = 0;
let currentMarketTicker: string | null = null;

export function setEmitter(e: EventEmitter) { emitter = e; }
function broadcast(event: string, data: any) {
  if (emitter) emitter.emit("sse", { event, data });
}
export function getState(): AIEngineState { return { ...state }; }

// ── V2 SYSTEM PROMPT: Quant trend-following, one entry per market, 60s TWAP settlement ──
const SYSTEM_PROMPT = `You are a quantitative trading engine. You output ONLY valid JSON. No commentary, no markdown. Do NOT search the web. All data you need is in the context provided.

=== MARKET STRUCTURE ===

You are trading Kalshi KXBTC15M — a binary contract on Bitcoin's 15-minute price direction.

SETTLEMENT MECHANIC:
- A "price to beat" threshold is set at market open.
- At expiration, Kalshi samples the CF Benchmarks BRTI price once per second during the FINAL 60 SECONDS.
- It computes the SIMPLE AVERAGE of those 60 prices.
- If that 60-second average >= price_to_beat: YES wins ($1.00 per contract).
- If that 60-second average < price_to_beat: NO wins ($1.00 per contract).
- This is a TWAP-like settlement, NOT a spot snapshot. Slow grinds matter more than spikes.

=== YOUR ROLE ===

You are an experienced quant trader with intuition. You are NOT a contrarian by default. You follow the trend unless there is overwhelming evidence of reversal.

CRITICAL RULES:
1. If BTC is trending AWAY from the strike, the trending side is almost always correct. BUY THE TREND SIDE.
2. Do NOT buy YES just because it's cheap. A YES contract at $0.10 when BTC is $200 below strike with 5 minutes left is correctly priced, not mispriced.
3. ONE ENTRY PER MARKET. Once you enter, you either HOLD to settlement or EXIT once. No re-entering the same market.
4. Flat is a position. SKIP more than you trade. Target 2-4 trades per hour, not 10.
5. The 60-second averaging window means: if BTC has been on one side of the strike for the last 3+ minutes and isn't showing reversal, that side wins. Trust it.

=== DECISION FRAMEWORK ===

PHASE 1 — OBSERVATION (minutes 0-5, seconds_to_close > 600):
- Do NOT trade. Observe. Output SKIP.
- Exception: if BTC moves >$150 from strike in first 3 minutes, that's a strong signal.

PHASE 2 — SETUP (minutes 5-10, 300 < seconds_to_close <= 600):
- This is where edge forms. If BTC has been consistently on one side, enter.
- Require delta_from_strike > $50 AND trend_strength > 0.5 to enter.
- BUY the side that matches the trend. If BTC is above strike and grinding up: BUY YES.
  If BTC is below strike and grinding down: BUY NO.

PHASE 3 — COMMITMENT (minutes 10-14, 60 < seconds_to_close <= 300):
- If holding: HOLD unless regime completely flips.
- If flat: only enter on very strong setups (delta > $100, strong trend).
- Set hold_to_settlement: true for all entries in this phase.

PHASE 4 — SETTLEMENT WINDOW (seconds_to_close <= 60):
- The averaging has begun. DO NOT ENTER.
- If holding: HOLD to settlement. Do not panic exit.

EXIT CONDITIONS (only these):
- BTC crosses back through the strike AND establishes momentum on the other side (not just a wick).
- Your unrealized loss exceeds 60% of entry cost.
- Nothing else. Do NOT exit a winning position early. Let it ride to $1.00.

=== POSITION SIZING ===
- Base size: 5% of balance, in whole contracts.
- High conviction (>0.8): up to 8% of balance.
- After 3 consecutive losses: 2% of balance.
- After 5 consecutive losses: SKIP all trades for 2 markets (30 min cooldown).
- Minimum trade: 1 contract. Do not trade if balance < $2.

=== OUTPUT FORMAT (valid JSON only) ===
{
  "action": "BUY_YES" | "BUY_NO" | "HOLD" | "EXIT" | "SKIP",
  "contracts": <int | null>,
  "limit_price": <float | null>,
  "hold_to_settlement": <bool>,
  "conviction": <float 0.0 to 1.0>,
  "model_probability_yes": <float 0.0 to 1.0>,
  "edge": <float>,
  "regime": "GRINDING_UP" | "GRINDING_DOWN" | "VOLATILE" | "FLAT_NEAR_STRIKE" | "BREAKOUT",
  "reasoning": "<2 sentences max>"
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

DECISION: Should we EXIT now (sell the position) or HOLD to let it ride?

Consider:
- Is the original thesis still intact given where BTC is vs the strike?
- Is momentum working for us or against us?
- How much time is left — enough for price to move back in our favor if we're losing?
- Is there a clear edge in holding vs locking in this P&L now?
- Remember: bot markets often have a synthetic spike at entry. A small initial loss that reverses is common. But a big loss moving further away usually means the trade was wrong.

Respond with ONLY valid JSON:
{
  "action": "hold" | "exit",
  "reasoning": "<1-2 sentences — why hold or exit right now>",
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

  let strikePrice: number | null = null;
  if (market.title) {
    const dollarMatch = market.title.match(/\$([\d,]+)/);
    if (dollarMatch) strikePrice = parseInt(dollarMatch[1].replace(/,/g, ""), 10);
  }
  if (!strikePrice) strikePrice = Math.round(btcPrice / 1000) * 1000;

  const deltaFromStrike = btcPrice - strikePrice;
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
  price_to_beat (strike): $${strikePrice.toLocaleString()}
  close_time: ${new Date(market.close_time).toISOString()}

CURRENT STATE:
  btc_spot: ${btcPrice}
  delta_from_strike: $${deltaFromStrike.toFixed(0)} (${btcPrice >= strikePrice ? "above" : "below"} strike)
  seconds_to_close: ${secsToClose}
  yes_bid: ${market.yes_bid}¢  yes_ask: ${market.yes_ask}¢
  no_bid: ${market.no_bid}¢  no_ask: ${market.no_ask}¢

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
      currentMarketTicker = marketTicker;
      consecutiveSkips = 0; // New market = fresh chance to call AI (prevents "freeze" after 3 SKIPs)
    }
    if (cooldownSkipsRemaining === 0) {
      const cooldown = memory.checkCooldown();
      if (cooldown > 0) cooldownSkipsRemaining = cooldown;
    }

    if (!state.activeSwingTrade && priceHistory.length >= 5 && cooldownSkipsRemaining === 0) {
      const msToClose = new Date(state.currentMarket.close_time).getTime() - Date.now();
      if (msToClose >= 90_000) {
        if (state.balance >= settings.targetBalance) {
          await storage.updateBotSettings({ enabled: false });
          broadcast("info", { message: `Target $${settings.targetBalance} reached — bot paused` });
        } else {
          // V2: skip AI call when 3+ consecutive SKIPs and flat (save API cost)
          if (consecutiveSkips >= 3) {
            // Don't call AI this cycle
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

// V2: one entry per market — block new BUY if we already traded this ticker
function shouldTrade(marketTicker: string, action: string): boolean {
  if (action === "skip" || action === "HOLD" || action === "EXIT" || action === "SKIP") return true;
  if (tradedMarkets.has(marketTicker)) return false;
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
    tradedMarkets.add(market.ticker);

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
      status: "filled",
      signalReason: `[AI V2 ${decision.confidence}% ${decision.regime ?? ""}] ${decision.reasoning}`,
      btcPriceAtTrade: state.btcPrice,
      marketTitle: market.title,
      settingsVersion: settings.settingsVersion,
    });

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
