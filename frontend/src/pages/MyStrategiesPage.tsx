import React, { useEffect, useState } from "react";
import { useWallet } from "../web3/WalletContext";
import { fetchTraderStrategies } from "../api";
import type { TraderStrategiesResponse } from "../api";
import StrategyViewer from "../components/StrategyViewer";

const SUPPORTED_ASSETS = ["BTC", "ETH", "SOL", "XRP", "KAS", "GOLD", "SILVER", "SPX", "USD"] as const;

const DIRECTIONS = [
  { label: "Long", value: 0 },
  { label: "Short", value: 1 },
] as const;

const inputStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 4,
  background: "#020617",
  borderRadius: 999,
  border: "1px solid var(--border)",
  padding: "0.3rem 0.7rem",
  color: "var(--text)",
  fontSize: "0.8rem",
};

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.round(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

const MyStrategiesPage: React.FC = () => {
  const {
    address,
    isCorrectNetwork,
    refreshBalance,
    getChainSignalsContract,
  } = useWallet();

  const isConnectedForUI = !!address && isCorrectNetwork;

  const [data, setData] = useState<TraderStrategiesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadFlag, setReloadFlag] = useState(0);

  const [strategy, setStrategy] = useState("");
  const [asset, setAsset] = useState<(typeof SUPPORTED_ASSETS)[number]>("BTC");
  const [direction, setDirection] = useState<number>(0);
  const [leverageText, setLeverageText] = useState<string>("1");
  const [leverageError, setLeverageError] = useState<string>("");
  const [percentText, setPercentText] = useState<string>("30");
  const [percentError, setPercentError] = useState<string>("");
  const [message, setMessage] = useState("");
  const [posting, setPosting] = useState(false);

  const [selectedStrategyId, setSelectedStrategyId] = useState<number | null>(null);

  function parseAllocation(text: string): { ok: boolean; value: number; err?: string } {
    const t = text.trim();
    if (t === "") return { ok: false, value: 0, err: "Required" };
    if (!/^\d+$/.test(t)) return { ok: false, value: 0, err: "Integers only" };
    const n = Number(t);
    if (!Number.isFinite(n)) return { ok: false, value: 0, err: "Invalid number" };
    if (n < 0 || n > 100) return { ok: false, value: 0, err: "Must be between 0 and 100" };
    return { ok: true, value: n };
  }

  function parseLeverage(text: string): { ok: boolean; value: number; err?: string } {
    const t = text.trim();
    if (t === "") return { ok: false, value: 0, err: "Required" };
    if (!/^\d+$/.test(t)) return { ok: false, value: 0, err: "Integers only" };
    const n = Number(t);
    if (!Number.isFinite(n)) return { ok: false, value: 0, err: "Invalid number" };
    if (n < 1 || n > 5) return { ok: false, value: 0, err: "Must be between 1 and 5" };
    return { ok: true, value: n };
  }

  useEffect(() => {
    if (!isConnectedForUI || !address) {
      setData(null);
      return;
    }
    setLoading(true);
    fetchTraderStrategies(address)
      .then(setData)
      .catch((e) => {
        console.error(e);
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [isConnectedForUI, address, reloadFlag]);

  const handleSendSignal = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isConnectedForUI || !address) return alert("Connect your wallet first.");

    const stratTrimmed = strategy.trim();
    if (!stratTrimmed) return alert("Strategy name required");
    if (stratTrimmed.length > 30) return alert("Strategy name must be <= 30 characters");

    const msgTrimmed = message.trim();
    if (msgTrimmed.length > 280) return alert("Message must be <= 280 characters");

    const parsed = parseAllocation(percentText);
    if (!parsed.ok) return alert("Target allocation: " + (parsed.err || "Invalid"));
    const pct = parsed.value; // already 0–100 integer

    const directionToUse = asset === "USD" ? 0 : direction;

    const levParsed = parseLeverage(leverageText);
    if (asset !== "USD") {
      if (!levParsed.ok) return alert("Leverage: " + (levParsed.err || "Invalid"));
    }

    const leverageToUse = asset === "USD" ? 1 : levParsed.value;

    setPosting(true);
    try {
      const contract = await getChainSignalsContract();
      if (!contract) return alert("Contract not available");

      const tx = await contract.postSignal(
        stratTrimmed,
        asset,
        msgTrimmed,
        directionToUse,
        leverageToUse,
        pct,
        { value: 0 }
      );
      await tx.wait();

      refreshBalance().catch(() => {});
      setTimeout(() => setReloadFlag((x) => x + 1), 2500);
    } catch (err: any) {
      console.error(err);
      alert("Failed to post signal: " + (err?.reason || err?.message || "Unknown error"));
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="layout-two-column">
      <div className="layout-main card">
        <div className="card-header">
          <div>
            <div className="card-title">My Strategies</div>
          </div>
        </div>

        {!isConnectedForUI ? (
          <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
            Connect your wallet to see your strategies.
          </div>
        ) : loading ? (
          <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Loading your strategies…</div>
        ) : !data || data.strategies.length === 0 ? (
          <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>No strategies detected yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Strategy</th>
                  <th>Days Active</th>
                  {/*<th>Signals</th>*/}
                  <th>Score (ALL)</th>
                  <th>Total Return (ALL)</th>
                  <th>Volatility (ALL)</th>
                  {/*<th>Max DD (ALL)</th>*/}
                </tr>
              </thead>
              <tbody>
                {data.strategies.map((s) => {
                  const statsAll = s.stats?.["ALL"];
                  const sharpe = statsAll?.sharpeAnnual;
                  const tr = statsAll?.totalReturn;
                  const vol = statsAll?.volAnnual;
                  //const dd = statsAll?.maxDrawdown;
                  const isSelected = selectedStrategyId === s.id;
                  const endTs = (s.lastSegmentEndTs ?? s.lastSignalTs) || s.firstSignalTs;
                  const daysActive = Math.max(0, (endTs - s.firstSignalTs) / 86400);

                  return (
                    <tr
                      key={s.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => setSelectedStrategyId((prev) => (prev === s.id ? null : s.id))}
                      title="Click to view"
                    >
                      <td>{s.id}</td>
                      <td>
                        {s.strategyName}{" "}
                        {isSelected && (
                          <span className="badge" style={{ marginLeft: 6 }}>
                            OPEN
                          </span>
                        )}
                      </td>
                      <td>{daysActive.toFixed(1)}</td>
                      {/*<td>{s.numSignals}</td>*/}
                      <td>{sharpe != null ? sharpe.toFixed(2) : "—"}</td>
                      <td>{tr != null ? (tr * 100).toFixed(1) + "%" : "—"}</td>
                      <td>{vol != null ? (vol * 100).toFixed(1) + "%" : "—"}</td>
                      {/*<td>{dd != null ? (dd * 100).toFixed(1) + "%" : "—"}</td>*/}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {isConnectedForUI && selectedStrategyId != null && (
          <div style={{ marginTop: "0.75rem" }}>
            <StrategyViewer
              strategyId={selectedStrategyId}
              layout="stacked"
              showControls={true}
              onClose={() => setSelectedStrategyId(null)}
            />
          </div>
        )}
      </div>

      <div className="layout-side card">
        <div className="card-header">
          <div>
            <div className="card-title">Send Signal</div>
          </div>
        </div>

        <form
          onSubmit={handleSendSignal}
          style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
        >
          <label style={{ fontSize: "0.8rem" }}>
            Strategy name (max 30 chars)
            <input
              style={inputStyle}
              value={strategy}
              maxLength={30}
              onChange={(e) => setStrategy(e.target.value)}
              placeholder="e.g. MOMENTUM"
              disabled={!isConnectedForUI}
            />
          </label>

          <label style={{ fontSize: "0.8rem" }}>
            Asset
            <select
              className="select"
              style={{ width: "100%", marginTop: 4 }}
              value={asset}
              onChange={(e) => setAsset(e.target.value as any)}
              disabled={!isConnectedForUI}
            >
              {SUPPORTED_ASSETS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: "0.8rem" }}>
            Direction
            <select
              className="select"
              style={{ width: "100%", marginTop: 4 }}
              value={direction}
              onChange={(e) => setDirection(Number(e.target.value))}
              disabled={!isConnectedForUI || asset === "USD"}
            >
              {DIRECTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: "0.8rem" }}>
            Leverage (1–5)
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="select"
              style={{ width: "100%", marginTop: 4 }}
              value={leverageText}
              onChange={(e) => {
                const next = e.target.value;
                if (next === "" || /^\d+$/.test(next)) {
                  setLeverageText(next);
                  setLeverageError("");
                }
              }}
              onBlur={() => {
                const parsed = parseLeverage(leverageText);
                if (!parsed.ok) {
                  setLeverageError(parsed.err || "Invalid");
                } else {
                  setLeverageText(String(parsed.value)); // normalize
                  setLeverageError("");
                }
              }}
              disabled={!isConnectedForUI}
              placeholder="1–5"
            />
            {leverageError && (
              <div style={{ marginTop: 4, fontSize: "0.75rem", color: "var(--muted)" }}>
                ⚠ {leverageError}
              </div>
            )}
          </label>


          <label style={{ fontSize: "0.8rem" }}>
            Target allocation (%)
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="select"
              style={{ width: "100%", marginTop: 4 }}
              value={percentText}
              onChange={(e) => {
                const next = e.target.value;
                // allow empty while editing; otherwise only digits
                if (next === "" || /^\d+$/.test(next)) {
                  setPercentText(next);
                  setPercentError("");
                }
              }}
              onBlur={() => {
                const parsed = parseAllocation(percentText);
                if (!parsed.ok) {
                  setPercentError(parsed.err || "Invalid");
                } else {
                  // normalize (e.g. "007" -> "7")
                  setPercentText(String(parsed.value));
                  setPercentError("");
                }
              }}
              disabled={!isConnectedForUI}
              placeholder="0–100"
            />
            {percentError && (
              <div style={{ marginTop: 4, fontSize: "0.75rem", color: "var(--muted)" }}>
                ⚠ {percentError}
              </div>
            )}
          </label>

          <label style={{ fontSize: "0.8rem" }}>
            Message (optional, max 280 chars)
            <textarea
              className="select"
              style={{
                width: "100%",
                marginTop: 4,
                minHeight: 72,
                resize: "vertical",
                borderRadius: 12,
                padding: "0.55rem 0.7rem",
                lineHeight: 1.35,
              }}

              value={message}
              maxLength={280}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="(Optional) Explain the signal, context, or rationale…"
              disabled={!isConnectedForUI}
            />
          </label>

          {!isConnectedForUI && (
            <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
              Connect your wallet to post signals.
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={posting || !isConnectedForUI}
            style={{ marginTop: "0.5rem" }}
          >
            {posting ? "Posting…" : "Post Signal"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default MyStrategiesPage;
