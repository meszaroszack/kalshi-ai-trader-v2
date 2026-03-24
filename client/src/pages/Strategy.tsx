// client/src/pages/Strategy.tsx
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal, Cpu, Zap, Target, AlertTriangle, TrendingUp,
  ShieldCheck, Activity, ArrowRight, Layers, Crosshair,
  Percent, Clock, Ban, LineChart
} from "lucide-react";
import { Link } from "wouter";

const GlassCard = ({ children, className = "", glowColor = "transparent" }: {
  children: React.ReactNode;
  className?: string;
  glowColor?: string;
}) => (
  <div
    className={`relative overflow-hidden rounded-2xl border border-white/10 bg-[#161B22]/60 backdrop-blur-xl ${className}`}
    style={{ boxShadow: `0 0 40px -15px ${glowColor}` }}
  >
    {children}
  </div>
);

const SectionHeading = ({ icon: Icon, title, subtitle }: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
}) => (
  <div className="mb-8">
    <div className="flex items-center gap-3 mb-2">
      <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
        <Icon className="w-6 h-6 text-blue-400" />
      </div>
      <h2 className="text-2xl font-bold tracking-tight text-white">{title}</h2>
    </div>
    <p className="text-gray-400 max-w-2xl">{subtitle}</p>
  </div>
);

export default function Strategy() {
  const [activeStep, setActiveStep] = useState(0);
  const [entryPrice, setEntryPrice] = useState(44);
  const [isStrikeMoving, setIsStrikeMoving] = useState(false);
  const [logs, setLogs] = useState([
    { time: "08:15:00", msg: "New market window opened. Snapshot price: $87,356.14", type: "info" },
    { time: "08:18:05", msg: "Observation phase complete. Transitioning to active scanning.", type: "ai" },
  ]);

  useEffect(() => {
    const messages = [
      "BTC +$60 from open. Last 15 ticks confirm direction. Scanning YES contracts...",
      "Strategy 1: Contract at 38¢. Delta is solid. Initiating buy sequence.",
      "Strategy 2: YES contracts at 5¢. BTC ticking upward. Deploying $1.00 hard cap.",
      "Profit taking: Contract up 35%+ from entry. Executing market sell.",
      "Warning: <90 seconds remaining. Halting all new entries.",
      "Risk Control: Balance checked. No active swing trades open.",
      "Thesis broken: BTC crossed back through opening price. Executing emergency exit.",
    ];
    const interval = setInterval(() => {
      setLogs((prev) => [
        ...prev.slice(-10),
        {
          time: new Date().toLocaleTimeString("en-GB"),
          msg: messages[Math.floor(Math.random() * messages.length)],
          type: Math.random() > 0.5 ? "ai" : "info",
        },
      ]);
    }, 4500);
    return () => clearInterval(interval);
  }, []);

  const steps = [
    { label: "Minutes 0–3", title: "Observation Phase", desc: "Watch only, no trades. Collecting baseline data and establishing the initial trend away from the snapshot price." },
    { label: "Minutes 3–10", title: "Primary Money-Making", desc: "Main entry window. Entering contracts priced 28¢–72¢ when BTC moves >$60 from open with 15-tick confirmation." },
    { label: "Minutes 10–13.5", title: "Late Entries", desc: "Only entering if delta is extreme ($120+) and the trend is absolutely undeniable. Hold to settlement if needed." },
    { label: "Final 90 Seconds", title: "Management Only", desc: "Zero new entries. Managing existing positions only. Exit if contract <75¢; hold to $1.00 if >80¢." },
  ];

  const profitTarget = Math.round(entryPrice * 1.35);
  const stopLoss = Math.round(entryPrice * 0.60);

  return (
    <div className="min-h-screen bg-[#0D1117] text-gray-200 font-sans selection:bg-emerald-500/30">
      {/* Background blobs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-500/10 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-6 py-12">

        {/* Back nav — matches existing page header style */}
        <div className="mb-8">
          <Link href="/">
            <a className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors">
              <ArrowRight className="w-4 h-4 rotate-180" />
              Back to Dashboard
            </a>
          </Link>
        </div>

        {/* Hero */}
        <header className="flex flex-col md:flex-row items-center justify-between mb-16 gap-8">
          <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 mb-4">
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-xs font-mono text-emerald-400 uppercase tracking-widest">AI Status: Live Market Processing</span>
            </div>
            <h1 className="text-5xl md:text-6xl font-black text-white mb-4 tracking-tight">
              The Brain in the{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
                Machine
              </span>
            </h1>
            <p className="text-xl text-gray-400 max-w-lg">
              Mastering Kalshi's 15-Minute BTC Prediction Markets with Dual-Thread Automated Precision.
            </p>
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="w-full md:w-auto">
            <GlassCard className="p-6 border-blue-500/20">
              <div className="flex items-center gap-4 mb-4">
                <Cpu className="w-8 h-8 text-blue-400" />
                <div>
                  <div className="text-xs font-mono text-gray-500">MARKET SNAPSHOT ENGINE</div>
                  <div className="text-white font-bold">15-MIN CYCLE ACTIVE</div>
                </div>
              </div>
              <div className="p-3 bg-white/5 rounded-lg border border-white/10 mt-4">
                <div className="text-[10px] text-gray-500 font-mono uppercase mb-1">The Core Insight</div>
                <div className="text-sm text-gray-300">
                  <span className="text-emerald-400 font-bold">You never have to wait for settlement.</span>
                  <br />
                  Buy YES at 40¢. If BTC moves up hard, sell at 65¢ minutes later. Pocket $0.25/contract instantly.
                </div>
              </div>
            </GlassCard>
          </motion.div>
        </header>

        {/* Strategy 1 */}
        <section className="mb-24">
          <SectionHeading
            icon={TrendingUp}
            title="Strategy 1: Mid-Range Scalping"
            subtitle="The Bread & Butter. Entering between 28¢ and 72¢. We don't pick the final winner — just the next 2 minutes of direction."
          />
          <div className="grid md:grid-cols-2 gap-8">
            {/* Timeline */}
            <GlassCard className="p-8">
              <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
                <Clock className="w-5 h-5 text-emerald-400" />
                15-Minute Market Lifecycle
              </h3>
              <div className="relative">
                <div className="absolute left-[15px] top-0 bottom-0 w-px bg-white/10" />
                <div className="space-y-6">
                  {steps.map((step, idx) => (
                    <motion.div
                      key={idx}
                      className="relative pl-10 cursor-pointer"
                      onMouseEnter={() => setActiveStep(idx)}
                    >
                      <div className={`absolute left-0 w-8 h-8 rounded-full border-2 flex items-center justify-center transition-all duration-300 ${activeStep === idx ? "bg-emerald-400 border-emerald-400 scale-110 shadow-[0_0_15px_rgba(52,211,153,0.5)]" : "bg-[#161B22] border-white/10"}`}>
                        {activeStep > idx
                          ? <ShieldCheck className="w-4 h-4 text-white" />
                          : <span className="text-xs font-mono">{idx + 1}</span>}
                      </div>
                      <div className={`transition-opacity duration-300 ${activeStep === idx ? "opacity-100" : "opacity-40"}`}>
                        <div className="text-xs font-mono text-emerald-400 mb-1">{step.label}</div>
                        <div className="text-white font-bold text-lg mb-1">{step.title}</div>
                        <p className="text-sm text-gray-400 leading-relaxed">{step.desc}</p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
              <AnimatePresence>
                {activeStep === 3 && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mt-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3"
                  >
                    <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
                    <div>
                      <span className="text-xs font-bold text-red-400 uppercase">Red Zone Rule</span>
                      <p className="text-xs text-red-300/60 mt-1">If contract is &lt;75¢, EXIT. If &gt;80¢ with &lt;2 mins, HOLD to $1.00.</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </GlassCard>

            {/* Exit Calculator */}
            <GlassCard className="p-8">
              <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
                <Target className="w-5 h-5 text-blue-400" />
                Momentum Exit Calculator
              </h3>
              <div className="space-y-8">
                <div>
                  <div className="flex justify-between mb-4">
                    <label className="text-sm text-gray-400">Entry Price (per contract)</label>
                    <span className="text-2xl font-mono text-white tracking-tighter">{entryPrice}¢</span>
                  </div>
                  <input
                    type="range" min="28" max="72" value={entryPrice}
                    onChange={(e) => setEntryPrice(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-400"
                  />
                  <div className="flex justify-between mt-2 text-[10px] text-gray-500 font-mono">
                    <span>28¢ Min</span><span>72¢ Max</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                    <div className="text-[10px] font-mono text-emerald-500 uppercase mb-1">Target (+35%)</div>
                    <div className="text-3xl font-mono text-white">{profitTarget}¢</div>
                    <div className="text-xs text-emerald-400 mt-2">Sell immediately</div>
                  </div>
                  <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/10">
                    <div className="text-[10px] font-mono text-red-500 uppercase mb-1">Stop Loss (−40%)</div>
                    <div className="text-3xl font-mono text-white">{stopLoss}¢</div>
                    <div className="text-xs text-red-400 mt-2">If 3+ mins remain</div>
                  </div>
                </div>
                <div className="p-6 rounded-2xl bg-gradient-to-br from-blue-500/10 to-transparent border border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="w-4 h-4 text-blue-400" />
                    <span className="text-sm text-blue-400 font-bold">The "20% Rule"</span>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    If up <span className="text-white font-semibold">20%+</span> and more than 2 minutes remain:{" "}
                    <span className="text-emerald-400">Sell, lock it in, reset for the next market.</span>
                  </p>
                </div>
              </div>
            </GlassCard>
          </div>
        </section>

        {/* Strategy 2 */}
        <section className="mb-24">
          <SectionHeading
            icon={Crosshair}
            title="Strategy 2: Penny Contract Hunting"
            subtitle="The Lottery Ticket. Contracts priced 1¢–8¢. We don't need it to win settlement — just need BTC to nudge toward it to trigger a 200–500% orderbook explosion."
          />
          <div className="grid md:grid-cols-3 gap-8">
            <GlassCard className="md:col-span-2 p-8" glowColor="rgba(59,130,246,0.2)">
              <div className="flex items-center justify-between mb-8">
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <LineChart className="w-5 h-5 text-blue-400" />
                  Volatility Explosion Simulator
                </h3>
                <button
                  onClick={() => setIsStrikeMoving(!isStrikeMoving)}
                  className={`px-4 py-2 rounded-full font-mono text-xs transition-all ${isStrikeMoving ? "bg-blue-500 text-white shadow-[0_0_15px_rgba(59,130,246,0.5)]" : "bg-white/5 text-gray-400 hover:bg-white/10"}`}
                >
                  {isStrikeMoving ? "RESET SIM" : "SIMULATE BTC TICK UP"}
                </button>
              </div>
              <div className="flex flex-col md:flex-row items-center justify-around gap-8">
                <div className="text-center">
                  <div className="text-xs text-gray-500 font-mono mb-2 uppercase tracking-widest">Entry at</div>
                  <div className="text-4xl font-mono text-white">5¢</div>
                  <div className="text-[10px] text-gray-500 mt-1">20 Contracts = $1.00</div>
                </div>
                <motion.div animate={isStrikeMoving ? { x: [0, 10, 0] } : {}} transition={{ repeat: Infinity, duration: 1 }}>
                  <ArrowRight className={`w-8 h-8 transition-colors ${isStrikeMoving ? "text-emerald-400" : "text-gray-700"}`} />
                </motion.div>
                <div className="text-center">
                  <div className="text-xs text-gray-500 font-mono mb-2 uppercase tracking-widest">Target Exit</div>
                  <motion.div
                    animate={isStrikeMoving ? { scale: 1.2, color: "#34d399" } : { scale: 1, color: "#FFFFFF" }}
                    className="text-4xl font-mono font-bold"
                  >
                    {isStrikeMoving ? "15¢" : "--¢"}
                  </motion.div>
                  <AnimatePresence>
                    {isStrikeMoving && (
                      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="text-sm font-bold text-emerald-400 mt-2">
                        Sell 20 at 15¢ = $3.00<br />(200% Gain)
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
              <div className="mt-12 p-4 rounded-xl bg-white/5 border border-white/10 flex flex-col sm:flex-row gap-4 justify-between items-center text-sm text-gray-400">
                {["BTC < $350 from open", "Last 5 ticks show momentum", "Active bid exists"].map((t) => (
                  <div key={t} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                    <span>{t}</span>
                  </div>
                ))}
              </div>
            </GlassCard>

            <GlassCard className="p-8 border-emerald-500/20">
              <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                Absolute Hard Cap
              </h3>
              <div className="flex flex-col items-center justify-center py-4">
                <div className="relative w-40 h-40">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle cx="80" cy="80" r="70" stroke="currentColor" strokeWidth="8" fill="transparent" className="text-white/5" />
                    <motion.circle cx="80" cy="80" r="70" stroke="currentColor" strokeWidth="8" fill="transparent"
                      strokeDasharray="440"
                      initial={{ strokeDashoffset: 440 }}
                      animate={{ strokeDashoffset: 440 - 44 }}
                      className="text-emerald-400"
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-3xl font-mono text-white">$1.00</span>
                    <span className="text-[10px] text-gray-500 font-mono uppercase">Max Spend</span>
                  </div>
                </div>
                <div className="mt-6 text-xs text-center text-gray-400 leading-relaxed space-y-2">
                  <p>At 3¢: buy 33 contracts ($0.99)</p>
                  <p>At 5¢: buy 20 contracts ($1.00)</p>
                  <p>At 7¢: buy 14 contracts ($0.98)</p>
                </div>
              </div>
            </GlassCard>
          </div>
        </section>

        {/* Comparison Table */}
        <section className="mb-24">
          <SectionHeading
            icon={Layers}
            title="Dual-Thread Synergy"
            subtitle="The bot runs both eyes simultaneously. They never stack since both require no active position to be open."
          />
          <GlassCard className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white/5 text-[10px] font-mono text-gray-500 uppercase tracking-[0.2em]">
                  <th className="p-6 border-b border-white/10">Parameter</th>
                  <th className="p-6 border-b border-white/10 text-blue-400">Mid-Range Scalp</th>
                  <th className="p-6 border-b border-white/10 text-emerald-400">Penny Hunt</th>
                </tr>
              </thead>
              <tbody className="text-sm font-medium">
                {[
                  ["Entry Price", "28¢ – 72¢", "1¢ – 8¢"],
                  ["Max Spend", "5–8% of balance", "$1.00 hard cap always"],
                  ["Profit Target", "20–35% gain on contract", "200%+ (3x entry)"],
                  ["Typical Hold Time", "2–6 minutes", "1–3 minutes or expire"],
                  ["Stop Loss", "-40% with 3+ min left", "None — expires worthless"],
                  ["Frequency", "2–4 trades per hour", "Whenever conditions appear"],
                  ["Budget Source", "Main account %", "Separate $1 lottery budget"],
                ].map(([param, scalp, penny], i) => (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors last:border-0">
                    <td className="p-6 text-gray-400">{param}</td>
                    <td className="p-6 text-white">{scalp}</td>
                    <td className="p-6 text-white">{penny}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>
        </section>

        {/* Risk Rules */}
        <section className="mb-24">
          <SectionHeading
            icon={Ban}
            title="Non-Negotiable Risk Rules"
            subtitle="The algorithmic safeguards that protect the bankroll from wipeouts."
          />
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { title: "Price Ceilings", desc: "Never buy above 80¢ (no upside) or below 1¢ (no liquidity)." },
              { title: "Time Lockout", desc: "Never enter any trade with under 90 seconds left on the clock." },
              { title: "Trend Alignment", desc: "Never fight direction. If BTC is above open for 8 mins, never buy NO." },
              { title: "Position Limit", desc: "Never open a second position while one is already active." },
              { title: "Drawdown Buffer", desc: "After 3 consecutive losses, sizing drops to 2% of balance." },
              { title: "Circuit Breaker", desc: "After 5 losses, halt trading for 2 full market windows (~30 min)." },
              { title: "Minimum Balance", desc: "Bot automatically halts all trading if account drops below $2.00." },
              { title: "Thesis Broken", desc: "If BTC crosses back through opening price for 2 ticks, EXIT immediately." },
            ].map((rule, idx) => (
              <div key={idx} className="p-5 rounded-xl border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 transition-colors">
                <h4 className="text-sm font-bold text-red-400 mb-2">{rule.title}</h4>
                <p className="text-xs text-gray-400 leading-relaxed">{rule.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Live Logic Feed */}
        <section>
          <GlassCard className="p-0 border-white/10">
            <div className="bg-white/5 px-6 py-3 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                  <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/50" />
                </div>
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">
                  Logic Stream :: Production_Env_v2
                </span>
              </div>
              <Terminal className="w-4 h-4 text-gray-500" />
            </div>
            <div className="p-6 h-64 overflow-y-auto font-mono text-xs space-y-2 scrollbar-thin scrollbar-thumb-white/10">
              {logs.map((log, i) => (
                <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} key={i} className="flex gap-4">
                  <span className="text-gray-600 shrink-0">[{log.time}]</span>
                  <span className={log.type === "ai" ? "text-blue-400 shrink-0" : "text-emerald-500 shrink-0"}>
                    {log.type === "ai" ? ">>> AI_EXEC:" : "INF:"}
                  </span>
                  <span className="text-gray-300">{log.msg}</span>
                </motion.div>
              ))}
              <div className="flex gap-4 animate-pulse">
                <span className="text-gray-600">[{new Date().toLocaleTimeString("en-GB")}]</span>
                <span className="text-white">_</span>
              </div>
            </div>
          </GlassCard>
        </section>

        <footer className="mt-20 pt-10 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3 text-white/40 text-sm">
            <Percent className="w-4 h-4" />
            Production Strategy Validated
          </div>
          <div className="flex gap-8 text-xs font-mono text-gray-500">
            <span>KALSHI API DOCS</span>
            <span>RISK DISCLOSURE</span>
            <span>v3.0.0-PROD</span>
          </div>
        </footer>
      </div>
    </div>
  );
}