import { useState, useEffect } from "react";

// ── Sample state for preview (CC replaces this with real state.json data) ──
const SAMPLE_STATE = {
  phase: "flop",
  pot: 320,
  myCards: ["Ah", "Kd"],
  communityCards: ["Qs", "Jh", "3c"],
  myStack: 1480,
  isMyTurn: true,
  callAmount: 80,
  minRaise: 160,
  maxRaise: 1480,
  bigBlind: 20,
  players: [
    { name: "You", stack: 1480, bet: 40, isMe: true, seat: 0, cards: ["Ah", "Kd"] },
    { name: "Shark_88", stack: 960, bet: 80, seat: 1 },
    { name: "LuckyFish", stack: 2100, bet: 0, folded: true, seat: 2 },
    { name: "NitNancy", stack: 800, bet: 40, seat: 3 },
    { name: "AggroMax", stack: 1640, bet: 80, seat: 4 },
    { name: "ChillBot", stack: 1020, bet: 0, folded: true, seat: 5 },
  ],
  actions: [
    { phase: "preflop", actor: "NitNancy", action: "call", amount: 20 },
    { phase: "preflop", actor: "AggroMax", action: "raise", amount: 60 },
    { phase: "preflop", actor: "ChillBot", action: "fold" },
    { phase: "preflop", actor: "You", action: "call", amount: 60 },
    { phase: "preflop", actor: "Shark_88", action: "call", amount: 60 },
    { phase: "preflop", actor: "LuckyFish", action: "fold" },
    { phase: "flop", actor: "You", action: "check" },
    { phase: "flop", actor: "Shark_88", action: "bet", amount: 80 },
  ],
};

// ── Card rendering ──
const SUIT_MAP = { h: "♥", d: "♦", c: "♣", s: "♠" };
const SUIT_COLOR = { h: "#ef4444", d: "#3b82f6", c: "#16a34a", s: "#1e293b" };
const RANK_MAP = { T: "10", J: "J", Q: "Q", K: "K", A: "A" };

function Card({ code, faceDown = false, size = "normal" }) {
  if (faceDown) {
    const sz = size === "small" ? { w: 36, h: 50, r: 4 } : { w: 48, h: 68, r: 6 };
    return (
      <div style={{
        width: sz.w, height: sz.h, borderRadius: sz.r,
        background: "linear-gradient(135deg, #1e40af 0%, #3b82f6 50%, #1e40af 100%)",
        border: "2px solid #93c5fd",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
      }}>
        <div style={{
          width: sz.w - 12, height: sz.h - 12, borderRadius: sz.r - 2,
          border: "1px solid #60a5fa",
          background: "repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.05) 3px, rgba(255,255,255,0.05) 6px)",
        }} />
      </div>
    );
  }
  if (!code || code.length < 2) return null;
  const rank = RANK_MAP[code[0]] || code[0];
  const suit = code[1].toLowerCase();
  const suitChar = SUIT_MAP[suit] || suit;
  const color = SUIT_COLOR[suit] || "#1e293b";
  const sz = size === "small" ? { w: 36, h: 50, fs: 13, sfs: 16, r: 4 } : { w: 48, h: 68, fs: 16, sfs: 22, r: 6 };

  return (
    <div style={{
      width: sz.w, height: sz.h, borderRadius: sz.r,
      background: "linear-gradient(160deg, #ffffff 0%, #f1f5f9 100%)",
      border: "1.5px solid #cbd5e1",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
      position: "relative", userSelect: "none",
    }}>
      <span style={{ fontSize: sz.fs, fontWeight: 700, color, lineHeight: 1, letterSpacing: -0.5 }}>{rank}</span>
      <span style={{ fontSize: sz.sfs, lineHeight: 1, color, marginTop: -2 }}>{suitChar}</span>
    </div>
  );
}

// ── Phase badge ──
const PHASE_CONFIG = {
  preflop: { label: "PREFLOP", color: "#f59e0b", bg: "#451a03" },
  flop: { label: "FLOP", color: "#10b981", bg: "#052e16" },
  turn: { label: "TURN", color: "#3b82f6", bg: "#172554" },
  river: { label: "RIVER", color: "#ef4444", bg: "#450a0a" },
  showdown: { label: "SHOWDOWN", color: "#a855f7", bg: "#3b0764" },
  waiting: { label: "WAITING", color: "#64748b", bg: "#1e293b" },
};

function PhaseBadge({ phase }) {
  const cfg = PHASE_CONFIG[phase] || PHASE_CONFIG.waiting;
  return (
    <span style={{
      display: "inline-block", padding: "3px 12px", borderRadius: 20,
      background: cfg.bg, color: cfg.color, fontSize: 11, fontWeight: 700,
      letterSpacing: 1.5, border: `1px solid ${cfg.color}40`,
      textTransform: "uppercase",
    }}>
      {cfg.label}
    </span>
  );
}

// ── Player seat positions around an oval table ──
function getPlayerPositions(count) {
  // positions as percentage of container
  const layouts = {
    2: [{ x: 50, y: 92 }, { x: 50, y: 4 }],
    3: [{ x: 50, y: 92 }, { x: 10, y: 30 }, { x: 90, y: 30 }],
    4: [{ x: 50, y: 92 }, { x: 8, y: 50 }, { x: 50, y: 4 }, { x: 92, y: 50 }],
    5: [{ x: 50, y: 92 }, { x: 8, y: 60 }, { x: 20, y: 10 }, { x: 80, y: 10 }, { x: 92, y: 60 }],
    6: [{ x: 50, y: 92 }, { x: 8, y: 60 }, { x: 15, y: 10 }, { x: 50, y: 4 }, { x: 85, y: 10 }, { x: 92, y: 60 }],
    7: [{ x: 50, y: 92 }, { x: 6, y: 65 }, { x: 8, y: 25 }, { x: 30, y: 4 }, { x: 70, y: 4 }, { x: 92, y: 25 }, { x: 94, y: 65 }],
    8: [{ x: 50, y: 92 }, { x: 6, y: 65 }, { x: 6, y: 30 }, { x: 25, y: 4 }, { x: 50, y: 4 }, { x: 75, y: 4 }, { x: 94, y: 30 }, { x: 94, y: 65 }],
    9: [{ x: 50, y: 92 }, { x: 6, y: 68 }, { x: 4, y: 35 }, { x: 20, y: 6 }, { x: 42, y: 2 }, { x: 58, y: 2 }, { x: 80, y: 6 }, { x: 96, y: 35 }, { x: 94, y: 68 }],
  };
  return layouts[Math.min(Math.max(count, 2), 9)] || layouts[6];
}

// ── Player chip/avatar ──
function PlayerSeat({ player, position, isHero }) {
  const folded = player.folded;
  const opacity = folded ? 0.4 : 1;
  const hasCards = player.cards && player.cards.length > 0;

  return (
    <div style={{
      position: "absolute",
      left: `${position.x}%`, top: `${position.y}%`,
      transform: "translate(-50%, -50%)",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      opacity,
      transition: "opacity 0.3s",
      zIndex: isHero ? 10 : 5,
    }}>
      {/* Cards */}
      {hasCards && (
        <div style={{ display: "flex", gap: 3, marginBottom: 2 }}>
          {player.cards.map((c, i) => <Card key={i} code={c} size="small" />)}
        </div>
      )}
      {/* Name + Stack chip */}
      <div style={{
        background: isHero
          ? "linear-gradient(135deg, #1e40af 0%, #2563eb 100%)"
          : "linear-gradient(135deg, #334155 0%, #475569 100%)",
        borderRadius: 10, padding: "6px 14px",
        border: isHero ? "2px solid #60a5fa" : "1.5px solid #64748b",
        textAlign: "center", minWidth: 80,
        boxShadow: isHero ? "0 0 12px rgba(59,130,246,0.4)" : "0 2px 4px rgba(0,0,0,0.3)",
      }}>
        <div style={{
          fontSize: 12, fontWeight: 700, color: "#fff",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 100,
        }}>
          {isHero ? `★ ${player.name}` : player.name}
        </div>
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>
          ${player.stack?.toLocaleString()}
        </div>
      </div>
      {/* Bet */}
      {player.bet > 0 && !folded && (
        <div style={{
          background: "#fbbf24", color: "#1e293b",
          borderRadius: 12, padding: "2px 8px",
          fontSize: 11, fontWeight: 700,
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}>
          ${player.bet}
        </div>
      )}
      {/* Folded tag */}
      {folded && (
        <div style={{ fontSize: 10, color: "#94a3b8", fontStyle: "italic" }}>FOLD</div>
      )}
    </div>
  );
}

// ── Action log ──
function ActionLog({ actions }) {
  if (!actions || actions.length === 0) return null;
  const recent = actions.slice(-8);
  return (
    <div style={{
      background: "#0f172a", borderRadius: 8, padding: "8px 12px",
      border: "1px solid #1e293b", maxHeight: 140, overflowY: "auto",
    }}>
      <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, marginBottom: 4, letterSpacing: 1 }}>
        ACTION LOG
      </div>
      {recent.map((a, i) => {
        const isRaise = a.action === "raise" || a.action === "bet";
        const isFold = a.action === "fold";
        const color = isRaise ? "#fbbf24" : isFold ? "#64748b" : "#94a3b8";
        return (
          <div key={i} style={{ fontSize: 12, color, lineHeight: 1.6 }}>
            <span style={{ fontWeight: 600 }}>{a.actor}</span>{" "}
            <span style={{ color: isRaise ? "#f59e0b" : isFold ? "#475569" : "#64748b" }}>
              {a.action}{a.amount ? ` $${a.amount}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main table component ──
export default function PokerTable() {
  const state = SAMPLE_STATE; // CC replaces this line with real data
  const {
    phase = "waiting",
    pot = 0,
    myCards = [],
    communityCards = [],
    myStack = 0,
    isMyTurn = false,
    callAmount = 0,
    minRaise = 0,
    maxRaise = 0,
    players = [],
    actions = [],
  } = state;

  // Reorder: hero (isMe) first
  const heroIdx = players.findIndex(p => p.isMe);
  const ordered = heroIdx >= 0
    ? [...players.slice(heroIdx), ...players.slice(0, heroIdx)]
    : players;
  const positions = getPlayerPositions(ordered.length);

  return (
    <div style={{
      background: "#0a0e1a",
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: 16,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      color: "#e2e8f0",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, marginBottom: 16,
      }}>
        <PhaseBadge phase={phase} />
        {isMyTurn && (
          <span style={{
            animation: "pulse 1.5s infinite",
            background: "#dc2626", color: "#fff",
            padding: "3px 12px", borderRadius: 20,
            fontSize: 12, fontWeight: 700, letterSpacing: 1,
          }}>
            YOUR TURN
          </span>
        )}
      </div>

      {/* Table area */}
      <div style={{
        position: "relative",
        width: "100%", maxWidth: 700, aspectRatio: "16/10",
      }}>
        {/* Felt */}
        <div style={{
          position: "absolute", inset: "15% 5%",
          borderRadius: "50%",
          background: "radial-gradient(ellipse at 50% 40%, #166534 0%, #14532d 60%, #052e16 100%)",
          border: "6px solid #854d0e",
          boxShadow: "0 0 0 4px #1c1917, 0 0 40px rgba(0,0,0,0.5), inset 0 0 60px rgba(0,0,0,0.2)",
        }} />

        {/* Pot */}
        <div style={{
          position: "absolute", left: "50%", top: "38%",
          transform: "translate(-50%, -50%)",
          textAlign: "center", zIndex: 8,
        }}>
          <div style={{
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
            borderRadius: 12, padding: "4px 16px",
            border: "1px solid #365314",
          }}>
            <div style={{ fontSize: 10, color: "#86efac", fontWeight: 600, letterSpacing: 1 }}>POT</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#fbbf24" }}>
              ${pot.toLocaleString()}
            </div>
          </div>
        </div>

        {/* Community cards */}
        <div style={{
          position: "absolute", left: "50%", top: "56%",
          transform: "translate(-50%, -50%)",
          display: "flex", gap: 6, zIndex: 8,
        }}>
          {communityCards.map((c, i) => <Card key={i} code={c} />)}
          {/* Empty slots */}
          {Array.from({ length: Math.max(0, 5 - communityCards.length) }).map((_, i) => (
            <div key={`empty-${i}`} style={{
              width: 48, height: 68, borderRadius: 6,
              border: "1.5px dashed #365314",
              opacity: 0.3,
            }} />
          ))}
        </div>

        {/* Player seats */}
        {ordered.map((p, i) => (
          <PlayerSeat
            key={p.name}
            player={p}
            position={positions[i]}
            isHero={p.isMe}
          />
        ))}
      </div>

      {/* Hero hand (large) + Actions */}
      <div style={{
        display: "flex", alignItems: "center", gap: 24, marginTop: 8,
        flexWrap: "wrap", justifyContent: "center",
      }}>
        {/* Hero cards large */}
        {myCards.length > 0 && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
          }}>
            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600, letterSpacing: 1 }}>YOUR HAND</div>
            <div style={{ display: "flex", gap: 6 }}>
              {myCards.map((c, i) => <Card key={i} code={c} />)}
            </div>
          </div>
        )}

        {/* Available actions */}
        {isMyTurn && (
          <div style={{
            background: "#1e293b", borderRadius: 12, padding: "12px 16px",
            border: "1px solid #334155",
          }}>
            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600, letterSpacing: 1, marginBottom: 8 }}>
              ACTIONS
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {callAmount === 0 ? (
                <>
                  <ActionBtn label="Check" hotkey="说 check" color="#10b981" />
                  <ActionBtn label={`Raise $${minRaise}-${maxRaise}`} hotkey="说 raise [金额]" color="#f59e0b" />
                  <ActionBtn label="Fold" hotkey="说 fold" color="#64748b" />
                </>
              ) : (
                <>
                  <ActionBtn label={`Call $${callAmount}`} hotkey="说 call" color="#3b82f6" />
                  <ActionBtn label={`Raise $${minRaise}-${maxRaise}`} hotkey="说 raise [金额]" color="#f59e0b" />
                  <ActionBtn label="Fold" hotkey="说 fold" color="#64748b" />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Action Log */}
      <div style={{ width: "100%", maxWidth: 700, marginTop: 12 }}>
        <ActionLog actions={actions} />
      </div>

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

function ActionBtn({ label, hotkey, color }) {
  return (
    <div style={{
      background: `${color}15`, border: `1.5px solid ${color}60`,
      borderRadius: 8, padding: "6px 12px", textAlign: "center",
      minWidth: 80,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color }}>{label}</div>
      <div style={{ fontSize: 9, color: "#64748b", marginTop: 2 }}>{hotkey}</div>
    </div>
  );
}
