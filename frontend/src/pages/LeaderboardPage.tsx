import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchLeaderboard } from "../api";
import type { LeaderboardRow } from "../api";

const TIMEFRAMES = ["1W", "1M", "3M", "6M", "1Y", "ALL"] as const;

function shortAddr(addr: string) {
  if (!addr) return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const LeaderboardPage: React.FC = () => {
  const navigate = useNavigate();
  const [window, setWindow] = useState<(typeof TIMEFRAMES)[number]>("3M");
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchLeaderboard(window)
      .then((r) => setRows(r))
      .catch((e) => {
        console.error(e);
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, [window]);

  return (
    <div className="card card-narrow">
      <div className="card-header">
        <div>
          <div className="card-title">Leaderboard</div>
          <div className="card-subtitle">Top strategies by risk-adjusted performance</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Window</span>
          <select className="select" value={window} onChange={(e) => setWindow(e.target.value as any)}>
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Loading leaderboard…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>No strategies yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Strategy</th>
                <th>Trader</th>
                <th>Days Active</th>
                {/*<th>Signals</th>*/}
                <th>Score</th>
                <th>Total Return</th>
                <th>Volatility</th>
                {/*<th>Max DD</th>*/}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const endTs = (r.lastSegmentEndTs ?? r.lastSignalTs) || r.firstSignalTs;
                const daysActive = Math.max(0, (endTs - r.firstSignalTs) / 86400);
                return (
                  <tr
                    key={r.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => navigate(`/strategy/${r.id}`)}
                    title="Click to open"
                  >
                    <td>{idx + 1}</td>
                    <td>{r.strategyName}</td>
                    <td style={{ fontFamily: "monospace" }}>
                      <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/trader/${r.trader}`);
                      }}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        textDecoration: "underline",
                        color: "var(--text)",
                          fontFamily: "monospace",
                      }}
                      title="Open trader"
                      >
                      {shortAddr(r.trader)}
                      </button>
                    </td>

                    <td>{daysActive.toFixed(1)}</td>
                    {/*<td>{r.numSignals}</td>*/}
                    <td>{r.sharpeAnnual != null ? r.sharpeAnnual.toFixed(2) : "—"}</td>
                    <td>{r.totalReturn != null ? (r.totalReturn * 100).toFixed(1) + "%" : "—"}</td>
                    <td>{r.volAnnual != null ? (r.volAnnual * 100).toFixed(1) + "%" : "—"}</td>
                    {/*<td>{r.maxDrawdown != null ? (r.maxDrawdown * 100).toFixed(1) + "%" : "—"}</td>*/}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default LeaderboardPage;
