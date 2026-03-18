/**
 * SQLite trade memory for V2: log every AI decision and backfill settlement.
 * Used for performance context injection and cooldown logic.
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.TRADING_MEMORY_DB ?? path.join(process.cwd(), "trading_memory.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    initDb(db);
  }
  return db;
}

function initDb(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_ticker TEXT,
      timestamp TEXT,
      action TEXT,
      side TEXT,
      contracts INTEGER,
      entry_price REAL,
      conviction REAL,
      model_prob REAL,
      edge REAL,
      regime TEXT,
      reasoning TEXT,
      btc_spot REAL,
      price_to_beat REAL,
      delta_from_strike REAL,
      seconds_to_close INTEGER,
      settlement_result TEXT,
      pnl REAL,
      was_correct INTEGER
    )
  `);
}

export interface MarketContext {
  ticker: string;
  btc_spot: number;
  price_to_beat: number;
  delta_from_strike: number;
  seconds_to_close: number;
}

export interface DecisionRecord {
  action: string;
  side?: string;
  contracts?: number;
  limit_price?: number;
  conviction: number;
  model_probability_yes?: number;
  edge?: number;
  regime?: string;
  reasoning: string;
}

export function logDecision(decision: DecisionRecord, marketContext: MarketContext): void {
  const database = getDb();
  const side = decision.side ?? (decision.action === "BUY_YES" ? "YES" : decision.action === "BUY_NO" ? "NO" : null);
  database
    .prepare(
      `INSERT INTO decisions (
        market_ticker, timestamp, action, side, contracts, entry_price,
        conviction, model_prob, edge, regime, reasoning,
        btc_spot, price_to_beat, delta_from_strike, seconds_to_close
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      marketContext.ticker,
      new Date().toISOString(),
      decision.action,
      side,
      decision.contracts ?? null,
      decision.limit_price ?? null,
      decision.conviction,
      decision.model_probability_yes ?? null,
      decision.edge ?? null,
      decision.regime ?? null,
      decision.reasoning,
      marketContext.btc_spot,
      marketContext.price_to_beat,
      marketContext.delta_from_strike,
      marketContext.seconds_to_close
    );
}

export function backfillSettlement(marketTicker: string, result: string, pnl: number): void {
  const database = getDb();
  const wasCorrect = pnl > 0 ? 1 : 0;
  database
    .prepare(
      `UPDATE decisions SET settlement_result = ?, pnl = ?, was_correct = ?
       WHERE market_ticker = ? AND settlement_result IS NULL`
    )
    .run(result, pnl, wasCorrect, marketTicker);
}

export interface PerformanceContext {
  message?: string;
  trades?: number;
  total_trades?: number;
  win_rate?: number;
  total_pnl?: number;
  avg_conviction_wins?: number;
  avg_conviction_losses?: number;
  best_regimes?: [string, number][];
  worst_regimes?: [string, number][];
  yes_win_rate?: number;
  no_win_rate?: number;
  recent_10?: Array<{ action: string; side: string; was_correct: number; pnl: number; regime: string }>;
}

export function getPerformanceContext(lookback = 30): PerformanceContext {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT action, side, conviction, model_prob, edge, regime, was_correct, pnl, seconds_to_close, delta_from_strike
       FROM decisions
       WHERE action NOT IN ('SKIP', 'HOLD') AND was_correct IS NOT NULL
       ORDER BY id DESC LIMIT ?`
    )
    .all(lookback) as Array<{
      action: string;
      side: string | null;
      conviction: number | null;
      model_prob: number | null;
      edge: number | null;
      regime: string | null;
      was_correct: number;
      pnl: number | null;
      seconds_to_close: number | null;
      delta_from_strike: number | null;
    }>;

  if (rows.length < 5) {
    return { message: "Insufficient history. Trade conservatively.", trades: rows.length };
  }

  const wins = rows.filter((r) => r.was_correct === 1);
  const losses = rows.filter((r) => r.was_correct === 0);
  const totalPnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const winRate = wins.length / rows.length;

  const convWins = wins.filter((r) => r.conviction != null).map((r) => r.conviction!);
  const convLosses = losses.filter((r) => r.conviction != null).map((r) => r.conviction!);
  const avgConvWins = convWins.length ? convWins.reduce((a, b) => a + b, 0) / convWins.length : 0;
  const avgConvLosses = convLosses.length ? convLosses.reduce((a, b) => a + b, 0) / convLosses.length : 0;

  const regimeCount: Record<string, { wins: number; losses: number }> = {};
  for (const r of rows) {
    const reg = r.regime ?? "UNKNOWN";
    if (!regimeCount[reg]) regimeCount[reg] = { wins: 0, losses: 0 };
    if (r.was_correct === 1) regimeCount[reg].wins++;
    else regimeCount[reg].losses++;
  }
  const bestRegimes = Object.entries(regimeCount)
    .filter(([, v]) => v.wins > 0)
    .sort((a, b) => b[1].wins - a[1].wins)
    .slice(0, 2)
    .map(([reg, v]) => [reg, v.wins] as [string, number]);
  const worstRegimes = Object.entries(regimeCount)
    .filter(([, v]) => v.losses > 0)
    .sort((a, b) => b[1].losses - a[1].losses)
    .slice(0, 2)
    .map(([reg, v]) => [reg, v.losses] as [string, number]);

  const yesRows = rows.filter((r) => r.side === "YES");
  const noRows = rows.filter((r) => r.side === "NO");
  const yesWins = yesRows.filter((r) => r.was_correct === 1).length;
  const noWins = noRows.filter((r) => r.was_correct === 1).length;

  const recent10 = rows.slice(0, 10).map((r) => ({
    action: r.action,
    side: r.side ?? "",
    was_correct: r.was_correct,
    pnl: r.pnl ?? 0,
    regime: r.regime ?? "",
  }));

  return {
    total_trades: rows.length,
    win_rate: Math.round(winRate * 1000) / 1000,
    total_pnl: Math.round(totalPnl * 100) / 100,
    avg_conviction_wins: Math.round(avgConvWins * 1000) / 1000,
    avg_conviction_losses: Math.round(avgConvLosses * 1000) / 1000,
    best_regimes: bestRegimes,
    worst_regimes: worstRegimes,
    yes_win_rate: yesRows.length ? Math.round((yesWins / yesRows.length) * 1000) / 1000 : undefined,
    no_win_rate: noRows.length ? Math.round((noWins / noRows.length) * 1000) / 1000 : undefined,
    recent_10: recent10,
  };
}

/** Returns number of markets to skip (0 = no cooldown). After 5 consecutive losses, skip 2 markets (30 min). */
export function checkCooldown(): number {
  const database = getDb();
  const recent = database
    .prepare(
      `SELECT was_correct FROM decisions
       WHERE action NOT IN ('SKIP', 'HOLD') AND was_correct IS NOT NULL
       ORDER BY id DESC LIMIT 5`
    )
    .all() as Array<{ was_correct: number }>;

  if (recent.length >= 5 && recent.every((r) => r.was_correct === 0)) {
    return 2;
  }
  return 0;
}

/** Number of most recent resolved trades that were losses (for 2% size cap after 3). */
export function getConsecutiveLosses(): number {
  const database = getDb();
  const recent = database
    .prepare(
      `SELECT was_correct FROM decisions
       WHERE action NOT IN ('SKIP', 'HOLD') AND was_correct IS NOT NULL
       ORDER BY id DESC LIMIT 10`
    )
    .all() as Array<{ was_correct: number }>;

  let count = 0;
  for (const r of recent) {
    if (r.was_correct === 0) count++;
    else break;
  }
  return count;
}
