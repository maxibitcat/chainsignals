import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchTraderStrategies } from "../api";
import type { TraderStrategiesResponse } from "../api";

const TIMEFRAMES = ["1W", "1M", "3M", "6M", "1Y", "ALL"] as const;
type Window = (typeof TIMEFRAMES)[number];

function shortAddr(addr: string) {
  if (!addr) return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function calcDaysActive(firstSignalTs: number, lastSignalTs: number, lastSegmentEndTs?: number | null) {
  const endTs = (lastSegmentEndTs ?? lastSignalTs) || firstSignalTs;
  return Math.max(0, (endTs - firstSignalTs) / 86400);
}

const TraderPage: React.FC = () => {
  const navigate = useNavigate();
  const { address } = useParams<{ address: string }>();

  const [window, setWindow] = useState<Window>("3M");
  const [data, setData] = useState<TraderStrategiesResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const trader = useMemo(() => (data?.trader ?? address ?? "").toLowerCase(), [data, address]);

  useEffect(() => {
    const addr = (address ?? "").trim();
    if (!addr) return;

    setLoading(true);
    fetchTraderStrategies(addr)
      .then((r) => setData(r))
      .catch((e) => {
        console.error(e);
        setData({ trader: addr.toLowerCase(), strategies: [] });
      })
      .finally(() => setLoading(false));
  }, [address]);

  const strategies = data?.strategies ?? [];

  return (
    <div className="card card-narrow">
      <div className="card-header">
        <div>
          <div className="card-title">Trader</div>
          <div className="card-subtitle" style={{ fontFamily: "monospace" }}>
            {trader || "—"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Window</span>
          <select className="select" value={window} onChange={(e) => setWindow(e.target.value as Window)}>
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Loading strategies…</div>
      ) : strategies.length === 0 ? (
        <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>No strategies found for this trader.</div>
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
              {strategies.map((s, idx) => {
                const st = s.stats?.[window];
                const daysActive = calcDaysActive(s.firstSignalTs, s.lastSignalTs, s.lastSegmentEndTs);
                return (
                  <tr
                    key={s.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => navigate(`/strategy/${s.id}`)}
                    title="Click to open"
                  >
                    <td>{idx + 1}</td>
                    <td>{s.strategyName}</td>
                    <td style={{ fontFamily: "monospace" }}>{shortAddr(s.trader)}</td>
                    <td>{daysActive.toFixed(1)}</td>
                    {/*<td>{s.numSignals}</td>*/}
                    <td>{st?.sharpeAnnual != null ? st.sharpeAnnual.toFixed(2) : "—"}</td>
                    <td>{st?.totalReturn != null ? (st.totalReturn * 100).toFixed(1) + "%" : "—"}</td>
                    <td>{st?.volAnnual != null ? (st.volAnnual * 100).toFixed(1) + "%" : "—"}</td>
                    {/*<td>{st?.maxDrawdown != null ? (st.maxDrawdown * 100).toFixed(1) + "%" : "—"}</td>*/}
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

export default TraderPage;
