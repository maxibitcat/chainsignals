import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchStrategy, fetchStrategyEquity } from "../api";
import type { StrategyDetails, StrategyEquityResponse } from "../api";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

const STRATEGY_COLOR = "#2563eb"; // same as chart
const BENCHMARK_COLOR = "#64748b"; // same as chart

function LineSample({
  dashed,
  color,
  width = 28,
}: {
  dashed?: boolean;
  color: string;
  width?: number;
}) {
  return (
    <svg width={width} height={12} style={{ display: "block" }}>
    <line
    x1="2"
    y1="6"
    x2={width - 2}
    y2="6"
    stroke={color}
    strokeWidth="2"
    strokeDasharray={dashed ? "6 4" : undefined}
    strokeLinecap="round"
    />
    </svg>
  );
}


function CustomLegend({
  benchmarkName,
  showBenchmark,
}: {
  benchmarkName: string;
  showBenchmark: boolean;
}) {
  return (
    <div
    style={{
      display: "flex",
      justifyContent: "center",
      gap: 18,
      alignItems: "center",
      width: "100%",
    }}
    >
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <LineSample color={STRATEGY_COLOR} />
      <span style={{ fontSize: 12, fontWeight: 700 }}>Strategy</span>
    </div>

    {showBenchmark ? (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <LineSample dashed color={BENCHMARK_COLOR} />
        <span style={{ fontSize: 12, fontWeight: 700 }}>{benchmarkName}</span>
      </div>
    ) : null}
    </div>
  );
}

function CoinGeckoIcon({ size = 14 }: { size?: number }) {
  // Inline SVG from the CoinGecko bundle (CG-Symbol.svg), scaled down.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1000 1011"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block" }}
      aria-hidden="true"
      focusable="false"
    >
    <g clipPath="url(#cg_clip)">
      <path
      d="M999.995 501.717C1001.24 779.849 778.389 1006.32 502.273 1007.58C226.118 1008.84 1.25532 784.39 0.00523352 506.257C-1.24485 228.125 221.611 1.65138 497.765 0.392348C773.882 -0.828534 998.745 223.585 999.995 501.717Z"
      fill="#FFE866"
      />
      <path
      d="M753.577 323.781C717.287 313.213 679.709 298.181 641.6 283.034C639.403 273.42 630.955 261.44 613.833 246.751C588.945 225.004 542.2 225.576 501.818 235.191C457.232 224.623 413.176 220.845 370.901 231.07C25.1964 327.024 221.194 561.014 94.2539 796.301C112.323 834.873 311.615 1020.19 588.68 999.616C588.68 999.616 492.348 766.466 709.749 654.526C886.086 563.761 1013.48 395.203 753.539 323.743L753.577 323.781Z"
      fill="#4BCC00"
      />
      <path
      d="M494.507 233.779C525.458 246.149 636.279 285.529 685.181 300.307C629.864 220.766 556.806 223.642 494.507 233.779Z"
      fill="#35AF00"
      />
      <path
      d="M525.759 379.88C525.759 433.675 482.461 477.246 429.086 477.246C375.711 477.246 332.413 433.675 332.413 379.88C332.413 326.085 375.711 282.553 429.086 282.553C482.461 282.553 525.759 326.123 525.759 379.88Z"
      fill="white"
      />
      <path
      d="M874.561 520.005C796.261 575.593 707.126 617.752 580.792 617.752C521.66 617.752 509.651 554.457 470.558 585.475C450.367 601.499 379.226 637.324 322.745 634.615C265.772 631.868 174.819 598.523 149.249 477.16C139.135 598.523 133.983 687.953 88.7148 790.431C199.838 953.745 393.589 1035 588.672 999.659C567.723 852.276 695.61 707.945 767.66 634.081C794.935 606.115 847.211 560.447 874.561 520.005Z"
      fill="#4BCC00"
      />
      <ellipse cx="469.83" cy="379.214" rx="56.7287" ry="79.4202" fill="#0D1217" />
      <path d="M469.833 379.205L401.759 333.822V424.588L469.833 379.205Z" fill="white" />
    </g>
    <defs>
      <clipPath id="cg_clip">
        <rect width="1000" height="1010.61" fill="white" transform="translate(0 0.38739)" />
      </clipPath>
    </defs>
    </svg>
  );
}

export type StrategyViewerLayout = "stacked" | "twoColumn";

export type StrategyViewerProps = {
  strategyId: number;
  layout?: StrategyViewerLayout;
  showControls?: boolean;
  initialWindow?: string;
  initialBenchmark?: string; // "NONE" or asset symbol
  onClose?: () => void;
  headerRight?: React.ReactNode;
  className?: string;
};

const DEFAULT_WINDOWS = ["1W", "1M", "3M", "6M", "1Y", "ALL"] as const;
const DEFAULT_BENCHMARKS = ["NONE", "BTC", "ETH", "SOL", "XRP", "KAS", "GOLD", "SILVER", "SPX", "USD"] as const;

const formatTs = (ts: number) =>
new Date(ts * 1000).toLocaleString(undefined, {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

type PositionLeg = {
  asset: string;
  direction: "LONG" | "SHORT";
  leverage: number;
  percent: number;
};

type CurrentPosition = {
  asOfTs: number;
  positions: PositionLeg[];
};



function sortPositionsForDisplay<T extends { asset: string; direction?: string }>(positions: T[]) {
  const groupRank = (p: T) => {
    if (p.asset === "USD") return 2;
    if (p.direction === "SHORT") return 1;
    return 0;
  };

  return positions
    .slice()
    .sort((a, b) => {
      const ga = groupRank(a);
      const gb = groupRank(b);
      if (ga !== gb) return ga - gb;
      return a.asset.localeCompare(b.asset);
    });
}


export const StrategyViewer: React.FC<StrategyViewerProps> = ({
  strategyId,
  layout = "twoColumn",
  showControls = true,
  initialWindow = "3M",
  initialBenchmark = "BTC",
  onClose,
  headerRight,
  className,
}) => {
  const [details, setDetails] = useState<StrategyDetails | null>(null);
  const [equity, setEquity] = useState<StrategyEquityResponse | null>(null);
  const [window, setWindow] = useState<string>(initialWindow);
  const [benchmark, setBenchmark] = useState<string>(initialBenchmark);
  // Fetch strategy details and equity independently so an equity failure doesn't
  // wipe the positions UI.
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [loadingEquity, setLoadingEquity] = useState(false);
  const [detailsErr, setDetailsErr] = useState<string | null>(null);
  const [equityErr, setEquityErr] = useState<string | null>(null);

  useEffect(() => {
    setWindow(initialWindow);
    setBenchmark(initialBenchmark);
  }, [strategyId, initialWindow, initialBenchmark]);

  // Load details
  useEffect(() => {
    let cancelled = false;
    async function loadDetails() {
      setLoadingDetails(true);
      setDetailsErr(null);
      try {
        const d = await fetchStrategy(strategyId);
        if (cancelled) return;
        setDetails(d);
      } catch (e: any) {
        if (cancelled) return;
        console.error(e);
        setDetails(null);
        setDetailsErr(e?.message || "Failed to load strategy details");
      } finally {
        if (!cancelled) setLoadingDetails(false);
      }
    }
    if (strategyId) loadDetails();
    return () => {
      cancelled = true;
    };
  }, [strategyId]);

  // Load equity
  useEffect(() => {
    let cancelled = false;
    async function loadEquity() {
      setLoadingEquity(true);
      setEquityErr(null);
      try {
        const benchParam = benchmark === "NONE" ? undefined : benchmark;
        const e = await fetchStrategyEquity(strategyId, window, benchParam);
        if (cancelled) return;
        setEquity(e);
      } catch (e: any) {
        if (cancelled) return;
        console.error(e);
        setEquity(null);
        setEquityErr(e?.message || "Failed to load equity");
      } finally {
        if (!cancelled) setLoadingEquity(false);
      }
    }
    if (strategyId) loadEquity();
    return () => {
      cancelled = true;
    };
  }, [strategyId, window, benchmark]);

  const lastSignalSnapshot = useMemo(() => {
      if (!details?.positionsHistory?.length) return null;
      return details.positionsHistory[details.positionsHistory.length - 1];
    }, [details]);

  
  const currentPosition: (CurrentPosition & { source?: "signal" | "hourly" }) | null = useMemo(() => {
    const raw = (details as any)?.currentPosition as any;
    if (!raw || !Array.isArray(raw.positions) || raw.positions.length === 0) return null;

    const asOfTs =
      typeof raw.asOfTs === "number"
        ? raw.asOfTs
        : typeof raw.timestamp === "number"
        ? raw.timestamp
        : undefined;

    if (!asOfTs) return null;

    return {
      asOfTs,
      positions: raw.positions,
      source: raw.source,
    };
  }, [details]);


  const chartData = useMemo(() => {
    if (!equity) return [];

    const benchByTs = new Map<number, number>();
    if (equity.benchmark?.points) {
      for (const p of equity.benchmark.points) {
        // backend provides rebased benchmark; we'll rebase again after filtering so the
        // first visible hourly point is exactly 1.00x on the chart.
        benchByTs.set(p.timestamp, p.priceRebased);
      }
    }

    const hourly = equity.points
      //.filter((p) => p.timestamp % 3600 === 0) // keep only exact-hour timestamps
      .map((p) => ({
        ts: p.timestamp, // keep numeric seconds
        strategy: p.valueIndexRebased,
        benchmark: benchByTs.get(p.timestamp),
      }));

    if (hourly.length === 0) return hourly;

    // Rebase to the first visible (hourly) point so the chart starts at 1.00x exactly.
    const baseStrat = hourly[0].strategy || 1;
    const baseBench = hourly[0].benchmark;

    return hourly.map((d) => ({
      ...d,
      strategy: baseStrat ? d.strategy / baseStrat : d.strategy,
      benchmark:
        d.benchmark != null && baseBench != null && baseBench !== 0
          ? d.benchmark / baseBench
          : d.benchmark,
    }));
  }, [equity]);

  const currentSnapshot = useMemo(() => {
    if (!details?.positionsHistory?.length) return null;
    return details.positionsHistory[details.positionsHistory.length - 1];
  }, [details]);

  const yDomain = useMemo<[number, number]>(() => {
    if (!chartData.length) return [0.99, 1.01];

    const vals: number[] = [];
    for (const d of chartData as any[]) {
      if (typeof d.strategy === "number") vals.push(d.strategy);
      if (typeof d.benchmark === "number") vals.push(d.benchmark);
    }
    if (!vals.length) return [0.99, 1.01];

    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);

    // Always include 1.00x in the visible domain
    const min = Math.min(rawMin, 1);
    const max = Math.max(rawMax, 1);

    // Add padding so extremes don't "touch" axes
    const range = Math.max(max - min, 0.001);
    const pad = Math.max(range * 0.08, 0.01); // tweak 0.08/0.01 if you want more/less padding

    return [min - pad, max + pad];
  }, [chartData]);

  const yTicks = useMemo(() => {
    const [min, max] = yDomain;
    const range = max - min;
    if (!Number.isFinite(range) || range <= 0) return [1];

    // target ~5 ticks total
    const approxStep = range / 4;

    // "Nice" step rounding (0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, ...)
    const pow10 = Math.pow(10, Math.floor(Math.log10(approxStep)));
    const n = approxStep / pow10;
    const niceN = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    const step = niceN * pow10;

    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;

    const ticks: number[] = [];
    for (let t = start; t <= end + step / 2; t += step) {
      // round to avoid floating artifacts
      ticks.push(Math.round(t * 1000000) / 1000000);
    }

    // Ensure 1.00 is included
    if (!ticks.some((t) => Math.abs(t - 1) < step * 0.001)) ticks.push(1);

    // Keep within domain and sort
    const uniq = Array.from(new Set(ticks))
    .filter((t) => t >= min - 1e-9 && t <= max + 1e-9)
    .sort((a, b) => a - b);

    return uniq;
  }, [yDomain]);


  const Chart = (
    <div className="card" style={{ minHeight: 360 }}>
    <div className="card-header">
    <div>
    <div className="card-title">
    {details?.strategyName ?? `Strategy #${strategyId}`}{" "}
    <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>#{strategyId}</span>
    {details?.isLiquidated && (
      <span className="badge" style={{ marginLeft: 8 }}>
      Liquidated
      </span>
    )}
    </div>
    {details && (
      <div className="card-subtitle">
        Trader{" "}
        <Link
          to={`/trader/${details.trader}`}
          style={{ fontFamily: "monospace" }}
          title="View all strategies for this trader"
        >
          {details.trader.slice(0, 6)}…{details.trader.slice(-4)}
        </Link>
      </div>
    )}
    </div>

    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
    {showControls && (
      <>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>Window</span>
      <select className="select" value={window} onChange={(e) => setWindow(e.target.value)}>
      {DEFAULT_WINDOWS.map((tf) => (
        <option key={tf} value={tf}>
        {tf}
        </option>
      ))}
      </select>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>Benchmark</span>
      <select
      className="select"
      value={benchmark}
      onChange={(e) => setBenchmark(e.target.value)}
      >
      {DEFAULT_BENCHMARKS.map((b) => (
        <option key={b} value={b}>
        {b}
        </option>
      ))}
      </select>
      </div>
      </>
    )}

    {headerRight}

    {onClose && (
      <button className="btn" onClick={onClose}>
      Close
      </button>
    )}
    </div>
    </div>

    {loadingEquity ? (
      <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Loading equity…</div>
    ) : equityErr ? (
      <div style={{ fontSize: "0.8rem", color: "var(--warning)" }}>{equityErr}</div>
    ) : !equity || chartData.length === 0 ? (
      <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>No performance data yet.</div>
    ) : (
      <>
      <div style={{ height: 300 }}>
      <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData}>
      <XAxis
      dataKey="ts"
      tickFormatter={(ts) => {
        const n = Number(ts);
        if (!Number.isFinite(n)) return "";
        // show month/day (still local timezone)
        return new Date(n * 1000).toLocaleDateString(undefined, {
          month: "2-digit",
          day: "2-digit",
        });
      }}
      minTickGap={20}
      />
      <YAxis
      tickFormatter={(v) => Number(v).toFixed(2) + "x"}
      domain={yDomain}
      ticks={yTicks}
      />
      <Tooltip
      labelFormatter={(ts) => {
        const n = Number(ts);
        return Number.isFinite(n) ? formatTs(n) : String(ts);
      }}
      formatter={(val: any, name: any) => [
        val != null ? Number(val).toFixed(3) + "x" : "",
         String(name),
      ]}
      labelStyle={{
        color: "#000000",     // <-- date color (black)
        fontWeight: 600,
      }}
      itemStyle={{
        color: "#000000",     // <-- series values color
      }}
      />
      <Legend
        verticalAlign="bottom"
        align="center"
        content={() => (
          <CustomLegend
          benchmarkName={equity?.benchmark?.symbol ?? "Benchmark"}
          showBenchmark={Boolean(equity?.benchmark?.points?.length)}
          />
        )}
      />

            <Line
      type="linear"
      dataKey="strategy"
      name="Strategy"
      legendType="line"
      stroke={STRATEGY_COLOR}
      strokeWidth={2}
      dot={{ r: 2 }}
      activeDot={{ r: 4 }}
      />
      {equity.benchmark?.points?.length ? (
        <Line
        type="linear"
        dataKey="benchmark"
        name={equity.benchmark?.symbol ?? "Benchmark"}
        legendType="line"
        stroke={BENCHMARK_COLOR}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        dot={{ r: 2 }}
        activeDot={{ r: 4 }}
        />
      ) : null}

      </LineChart>
      </ResponsiveContainer>
      </div>

      <div
        style={{
          marginTop: "0.5rem",
          fontSize: "0.75rem",
          color: "var(--muted)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        {/* left side intentionally empty (reserved for future footer info) */}
        <div />

        {/* right-aligned attribution */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: 0.9 }}>
          <CoinGeckoIcon size={14} />
          <span>price data by coingecko</span>
        </div>
      </div>


      </>
    )}
    </div>
  );

  const Positions = (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Positions</div>
        </div>
      </div>

      {loadingDetails ? (
        <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Loading positions…</div>
      ) : detailsErr ? (
        <div style={{ fontSize: "0.8rem", color: "var(--warning)" }}>{detailsErr}</div>
      ) : !details || details.positionsHistory.length === 0 ? (
        <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>No positions yet.</div>
      ) : (
        <>
          <div className="timeline-entry current" style={{ marginBottom: "0.5rem" }}>
            <div className="timeline-entry-header">
              <span>Current</span>
              <span>
              {currentPosition
                ? currentPosition.source === "signal"
                ? `${formatTs(currentPosition.asOfTs)} (latest signal)`
                : `${formatTs(currentPosition.asOfTs)} (as of last hourly update)`
                : lastSignalSnapshot
                ? `${formatTs(lastSignalSnapshot.timestamp)} (latest signal snapshot)`
                : "—"}
              </span>
            </div>
            {(() => {
              const m = (currentPosition?.source === "signal" ? (lastSignalSnapshot as any)?.message : (lastSignalSnapshot as any)?.message) as any;
            })()}

            <div className="timeline-positions">
              {sortPositionsForDisplay(currentPosition?.positions ?? lastSignalSnapshot?.positions ?? []).map((p: any, idx: number) => (
                <span
                  key={idx}
                  className={
                    "position-pill " +
                    (p.asset === "USD"
                      ? "position-pill-cash"
                      : p.direction === "SHORT"
                      ? "position-pill-short"
                      : "position-pill-long")
                  }
                >
                  {p.asset} {p.asset === "USD" ? "CASH" : p.direction === "SHORT" ? "S" : "L"}{" "}
                  {p.asset === "USD" ? "" : "x" + (p.leverage ?? 1)} · {Number(p.percent).toFixed(1)}%
                </span>
              ))}
            </div>
          </div>

          <div className="timeline">
            {details.positionsHistory
              .slice()
              .reverse()
              .map((snap) => (
                <div key={snap.timestamp} className={"timeline-entry"}>
                  <div className="timeline-entry-header">
                    <span>{formatTs(snap.timestamp)}</span>
                    <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                      {snap.message && String(snap.message).trim().length ? snap.message : "—"}
                    </span>
                  </div>

                  <div className="timeline-positions">
                    {sortPositionsForDisplay(snap.positions).map((p, i2) => (
                      <span
                        key={i2}
                        className={
                          "position-pill " +
                          (p.asset === "USD"
                            ? "position-pill-cash"
                            : p.direction === "SHORT"
                            ? "position-pill-short"
                            : "position-pill-long")
                        }
                      >
                        {p.asset} {p.asset === "USD" ? "CASH" : p.direction === "SHORT" ? "S" : "L"}{" "}
                        {p.asset === "USD" ? "" : "x" + (p.leverage ?? 1)} · {p.percent.toFixed(1)}%
                      </span>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );

  if (layout === "stacked") {
    return (
      <div className={className} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {Chart}
      {Positions}
      </div>
    );
  }

  return (
    <div className={className} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: "0.75rem" }}>
    {Chart}
    {Positions}
    </div>
  );
};

export default StrategyViewer;
