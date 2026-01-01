import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initDb, db } from "./db";
import { syncSignals } from "./syncSignals";
import { backfillHistoricalPrices } from "./prices";
import { SUPPORTED_ASSETS } from "./prices";
import {
    extendAllStrategySegments,
    recomputeAllStrategyStats,
} from "./segments";

dotenv.config();

const VALID_WINDOWS = ["1W", "1M", "3M", "6M", "1Y", "ALL"] as const;
type WindowId = (typeof VALID_WINDOWS)[number];

function normalizeWindowParam(raw: any): WindowId {
    if (!raw) return "1M"; // default
    const s = String(raw).toUpperCase();
    if (VALID_WINDOWS.includes(s as WindowId)) {
        return s as WindowId;
    }
    return "1M";
}

async function main() {
    initDb();

    // 1) sync on-chain signals so strategies exist
    await syncSignals();

    // 2) Backfill prices (hourly + signal-time) up to the current top-of-hour.
    // We intentionally recompute performance on an hourly cadence.
    const nowSec = Math.floor(Date.now() / 1000);
    const nowHour = Math.floor(nowSec / 3600) * 3600;
    try {
        await backfillHistoricalPrices(nowHour);
    } catch (err) {
        console.error("[init] historical backfill failed:", err);
    }

    // 3) build segments from all known prices & signals
    extendAllStrategySegments();

    // 4) compute stats for all strategies / windows
    recomputeAllStrategyStats();

    // periodic tasks

    // We ONLY recompute performance hourly.
    // New signals are still synced every 10s, but they will be reflected in
    // performance/stats after the next hourly backfill + recompute.
    // Performance recomputation:
    // We want to be robust to upstream price sampling delays (e.g. CoinGecko 5-min grid)
    // and occasional fetch failures. So we run a lightweight "attempt" frequently, and
    // always target the last fully closed hour (with a small safety lag). This naturally
    // retries missing hours and catches up after downtime.
    const ONE_MIN_MS = 60 * 1000;
    const SAFETY_LAG_SEC = 90;

    async function runHourlyRecomputeAttempt() {
        try {
            const nowSec = Math.floor(Date.now() / 1000);
            const SAFETY_LAG_SEC = 90;
            const targetHourTs = Math.floor((nowSec - SAFETY_LAG_SEC) / 3600) * 3600;

            // 1) backfill prices up to target hour (may do nothing)
            await backfillHistoricalPrices(targetHourTs);

            // 2) what hour do we actually have in prices?
            const lastPriceRaw = db
            .prepare("SELECT value FROM meta WHERE key = ?")
            .pluck()
            .get("last_price_ts") as string | undefined;

            const lastPriceTs = lastPriceRaw ? parseInt(lastPriceRaw, 10) : 0;
            if (!lastPriceTs) {
                console.log("[tick] no last_price_ts yet; skipping segments/stats");
                return;
            }

            // 3) Decide if there's anything to extend:
            // A strategy needs extension if its segments end before the latest available price hour,
            // OR if it has a signal timestamp <= lastPriceTs that is after its last_segment_end_ts.
            const needsExtension = db
            .prepare(
                `
                SELECT 1
                FROM strategies
                WHERE
                (COALESCE(last_segment_end_ts, 0) < ?)
                OR (
                    COALESCE(last_signal_ts, 0) <= ?
                    AND COALESCE(last_signal_ts, 0) > COALESCE(last_segment_end_ts, 0)
                )
                LIMIT 1
                `
            )
            .get(lastPriceTs, lastPriceTs);

            if (!needsExtension) {
                console.log("[tick] nothing new; skipping segments/stats recompute");
                return;
            }

            // 4) Do the heavy work only when needed
            extendAllStrategySegments();
            recomputeAllStrategyStats();
        } catch (err) {
            console.error("[tick] error:", err);
        }
    }


    // Run once at startup, then retry every minute.
    runHourlyRecomputeAttempt();
    setInterval(runHourlyRecomputeAttempt, ONE_MIN_MS);


    // Fast sync: every 10 seconds, check for new signals and persist them.
    // (No performance recompute here.)
    setInterval(async () => {
        try {
            await syncSignals();
        } catch (err) {
            console.error("[fast sync] error:", err);
        }
    }, 10 * 1000);

    // Express API
    const app = express();
    const port = process.env.PORT || 3001;

    app.use(
        cors({
            origin: [
                "http://localhost:5173",      // local dev frontend
                "http://127.0.0.1:5173",
            ],
            methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allowedHeaders: ["Content-Type", "Authorization"],
            credentials: false,
        })
    );

    app.get("/api/health", (req, res) => {
        res.json({ ok: true });
    });

    // GET /api/leaderboard?window=1W|1M|1Y|ALL
    app.get("/api/leaderboard", (req, res) => {
        const window = normalizeWindowParam(req.query.window);

        const rows = db
        .prepare(
            `
            SELECT
            s.id,
            s.trader_address,
            s.strategy_name,
            s.first_signal_ts,
            s.last_signal_ts,
            s.num_signals,
            s.is_liquidated,
            s.last_value_index,
            s.last_segment_end_ts,
            st.sharpe_annual,
            st.vol_annual,
            st.vol_hourly,
            st.total_return,
            st.max_drawdown
            FROM strategies s
            LEFT JOIN strategy_stats st
            ON st.strategy_id = s.id
            AND st.window = ?
            `
        )
        .all(window) as {
            id: number;
            trader_address: string;
            strategy_name: string;
            first_signal_ts: number;
            last_signal_ts: number;
            num_signals: number;
            is_liquidated: number;
            last_value_index: number;
            last_segment_end_ts: number | null;
            sharpe_annual: number | null;
            vol_annual: number | null;
            vol_hourly: number | null;
            total_return: number | null;
            max_drawdown: number | null;
        }[];

        const enriched = rows.map((r) => ({
            id: r.id,
            trader: r.trader_address,
            strategyName: r.strategy_name,
            firstSignalTs: r.first_signal_ts,
            lastSignalTs: r.last_signal_ts,
            numSignals: r.num_signals,
            isLiquidated: !!r.is_liquidated,
            lastValueIndex: r.last_value_index,
            lastSegmentEndTs: r.last_segment_end_ts,
            sharpeAnnual: r.sharpe_annual,
            volAnnual: r.vol_annual,
            volHourly: r.vol_hourly,
            totalReturn: r.total_return,
            maxDrawdown: r.max_drawdown,
            window,
        }));

        // sort by sharpe desc; if sharpe is missing (too young), sort by total return desc
        enriched.sort((a, b) => {
            const aSharpe = a.sharpeAnnual;
            const bSharpe = b.sharpeAnnual;

            // 1) Both have Sharpe -> sort by Sharpe
            if (aSharpe != null && bSharpe != null) {
                const d = bSharpe - aSharpe;
                if (d !== 0) return d;
                // tie-breaker: total return
                const aRet = a.totalReturn ?? -Infinity;
                const bRet = b.totalReturn ?? -Infinity;
                return bRet - aRet;
            }

            // 2) Only one has Sharpe -> Sharpe comes first
            if (aSharpe != null) return -1;
            if (bSharpe != null) return 1;

            // 3) Neither has Sharpe -> fallback to total return
            const aRet = a.totalReturn ?? -Infinity;
            const bRet = b.totalReturn ?? -Infinity;
            const d = bRet - aRet;
            if (d !== 0) return d;

            // final tie-breaker: stable ordering (optional)
            return a.id - b.id;
        });


        res.json(enriched);
    });

    // GET /api/strategy/:id
    // Returns:
    // - basic strategy metadata
    // - stats for all windows
    // - positionsHistory: snapshots of the portfolio at each signal timestamp
    app.get("/api/strategy/:id", (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ error: "Invalid strategy id" });
        }

        const strat = db
        .prepare(
            `
            SELECT
            id,
            trader_address,
            strategy_name,
            first_signal_ts,
            last_signal_ts,
            num_signals,
            is_liquidated,
            last_value_index,
            last_segment_end_ts
            FROM strategies
            WHERE id = ?
            `
        )
        .get(id) as
        | {
            id: number;
            trader_address: string;
            strategy_name: string;
            first_signal_ts: number;
            last_signal_ts: number;
            num_signals: number;
            is_liquidated: number;
            last_value_index: number;
            last_segment_end_ts: number | null;
        }
        | undefined;

        if (!strat) {
            return res.status(404).json({ error: "Strategy not found" });
        }

        // --- stats by window ---
        const statsRows = db
        .prepare(
            `
            SELECT
            window,
            last_updated_ts,
            sharpe_annual,
            vol_annual,
            vol_hourly,
            total_return,
            max_drawdown
            FROM strategy_stats
            WHERE strategy_id = ?
            `
        )
        .all(id) as {
            window: string;
            last_updated_ts: number;
            sharpe_annual: number | null;
            vol_annual: number | null;
            vol_hourly: number | null;
            total_return: number | null;
            max_drawdown: number | null;
        }[];

        const statsByWindow: Record<
        string,
        {
            lastUpdatedTs: number;
            sharpeAnnual: number | null;
            volAnnual: number | null;
            volHourly: number | null;
            totalReturn: number | null;
            maxDrawdown: number | null;
        }
        > = {};

        for (const r of statsRows) {
            statsByWindow[r.window] = {
                lastUpdatedTs: r.last_updated_ts,
                sharpeAnnual: r.sharpe_annual,
                volAnnual: r.vol_annual,
                volHourly: r.vol_hourly,
                totalReturn: r.total_return,
                maxDrawdown: r.max_drawdown,
            };
        }

        // --- positions history ---
        // Read precomputed snapshots from DB.
        // Snapshots are written:
        //  - accurately during the hourly segment extension (with price-aware drift/rebalance),
        //  - approximately at signal ingestion time (to give immediate UX), then overwritten later.
        type Position = {
            asset: string;
            percent: number;
            direction: "LONG" | "SHORT" | "CASH";
            leverage: number;
        };
        type PositionSnapshot = { timestamp: number; positions: Position[]; message?: string | null };

        const snapshotRows = db
            .prepare(
                `SELECT signal_ts, positions_json, message
                FROM strategy_position_snapshots
                WHERE strategy_id = ?
                ORDER BY signal_ts ASC`
            )
            .all(id) as { signal_ts: number; positions_json: string; message: string | null }[];

        const snapshots: PositionSnapshot[] = [];
        for (const r of snapshotRows) {
            try {
                const positions = JSON.parse(String(r.positions_json || "[]")) as Position[];
                if (Array.isArray(positions) && positions.length) {
                    snapshots.push({ timestamp: Number(r.signal_ts), positions, message: r.message ?? null });
                }
            } catch {
                // ignore malformed rows
            }
        }

        const latestSnap = snapshots.length ? snapshots[snapshots.length - 1] : null;

        let currentPosition: any = null;

        try {
            // The only "canonical" time for performance/holdings is the last computed segment end.
            // (Hourly engine updates this.) If it's 0, holdings are not available yet.
            const lastHourlyTs = Number(strat.last_segment_end_ts) || 0;

            // snapshots were computed above (positionsHistory)
            const latestSnap = snapshots.length ? snapshots[snapshots.length - 1] : null;

            const holdingRows = db
                .prepare(
                    `
                    SELECT asset_symbol, value, direction, leverage, is_usd
                    FROM strategy_holdings
                    WHERE strategy_id = ?
                    `
                )
                .all(id) as any[];

            const holdingsTotal = (holdingRows || []).reduce(
                (acc, r) => acc + (Number(r.value) || 0),
                0
            );

            // Read-only policy: do not drift/replay inside the API.
            // Prefer hourly holdings if they are at least as recent as the latest signal snapshot;
            // otherwise show the latest signal snapshot.
            if (
                holdingRows &&
                holdingRows.length > 0 &&
                holdingsTotal > 0 &&
                Number.isFinite(holdingsTotal) &&
                (!latestSnap || (lastHourlyTs > 0 && lastHourlyTs >= latestSnap.timestamp))
            ) {
                        currentPosition = {
                            source: "holdings",
                            asOfTs: lastHourlyTs || strat.last_segment_end_ts || null,
                            positions: holdingRows
                            .filter((r) => (Number(r.value) || 0) > 0)
                            .map((r) => {
                                const assetRaw = String(r.asset_symbol || "");
                                const assetUpper = assetRaw.toUpperCase();
                                const isUsd = Number(r.is_usd) === 1 || assetUpper === "USD";

                                // holdings.direction in DB uses -1 for short, +1 for long.
                                const dirNum = Number(r.direction) || 0;
                                const direction = isUsd ? "CASH" : dirNum < 0 ? "SHORT" : "LONG";

                                const leverage = isUsd ? 1 : Number(r.leverage) || 1;
                                const percent = ((Number(r.value) || 0) / holdingsTotal) * 100;

                                return {
                                    asset: isUsd ? "USD" : assetUpper,
                                    direction,
                                    leverage,
                                    percent,
                                };
                            }),
                        };
            }
            if (!currentPosition && latestSnap) {
                currentPosition = {
                    source: "signal",
                    asOfTs: latestSnap.timestamp,
                    positions: latestSnap.positions,
                };
            }
        } catch (e) {
            // ignore; currentPosition remains null
        }

        res.json({
            id: strat.id,
            trader: strat.trader_address,
            strategyName: strat.strategy_name,
            firstSignalTs: strat.first_signal_ts,
            lastSignalTs: strat.last_signal_ts,
            numSignals: strat.num_signals,
            isLiquidated: !!strat.is_liquidated,
            lastValueIndex: strat.last_value_index,
            lastSegmentEndTs: strat.last_segment_end_ts,
            stats: statsByWindow,
            currentPosition,
            positionsHistory: snapshots,
        });
    });


    // GET /api/trader/:address
    // Returns all strategies for a given trader + stats per window
    app.get("/api/trader/:address", (req, res) => {
        const traderRaw = String(req.params.address || "");
        if (!traderRaw) {
            return res.status(400).json({ error: "Missing trader address" });
        }

        // Normalize to lowercase – syncSignals should already store lowercase,
        // but this makes it robust.
        const trader = traderRaw.toLowerCase();

        const strategies = db
        .prepare(
            `
            SELECT
            id,
            trader_address,
            strategy_name,
            first_signal_ts,
            last_signal_ts,
            num_signals,
            is_liquidated,
            last_value_index,
            last_segment_end_ts
            FROM strategies
            WHERE lower(trader_address) = ?
            ORDER BY id ASC
            `
        )
        .all(trader) as {
            id: number;
            trader_address: string;
            strategy_name: string;
            first_signal_ts: number;
            last_signal_ts: number;
            num_signals: number;
            is_liquidated: number;
            last_value_index: number;
            last_segment_end_ts: number | null;
        }[];

        if (strategies.length === 0) {
            return res.json({ trader, strategies: [] });
        }

        const ids = strategies.map((s) => s.id);
        const placeholders = ids.map(() => "?").join(",");

        const statsRows = db
        .prepare(
            `
            SELECT
            strategy_id,
            window,
            last_updated_ts,
            sharpe_annual,
            vol_annual,
            vol_hourly,
            total_return,
            max_drawdown
            FROM strategy_stats
            WHERE strategy_id IN (${placeholders})
            `
        )
        .all(...ids) as {
            strategy_id: number;
            window: string;
            last_updated_ts: number;
            sharpe_annual: number | null;
            vol_annual: number | null;
            vol_hourly: number | null;
            total_return: number | null;
            max_drawdown: number | null;
        }[];

        const statsByStrategy: Record<
        number,
        Record<
        string,
        {
            lastUpdatedTs: number;
            sharpeAnnual: number | null;
            volAnnual: number | null;
            volHourly: number | null;
            totalReturn: number | null;
            maxDrawdown: number | null;
        }
        >
        > = {};

        for (const r of statsRows) {
            if (!statsByStrategy[r.strategy_id]) {
                statsByStrategy[r.strategy_id] = {};
            }
            statsByStrategy[r.strategy_id][r.window] = {
                lastUpdatedTs: r.last_updated_ts,
                sharpeAnnual: r.sharpe_annual,
                volAnnual: r.vol_annual,
                volHourly: r.vol_hourly,
                totalReturn: r.total_return,
                maxDrawdown: r.max_drawdown,
            };
        }

        const out = strategies.map((s) => ({
            id: s.id,
            trader: s.trader_address,
            strategyName: s.strategy_name,
            firstSignalTs: s.first_signal_ts,
            lastSignalTs: s.last_signal_ts,
            numSignals: s.num_signals,
            isLiquidated: !!s.is_liquidated,
            lastValueIndex: s.last_value_index,
            lastSegmentEndTs: s.last_segment_end_ts,
            stats: statsByStrategy[s.id] || {},
        }));

        res.json({ trader, strategies: out });
    });

    // GET /api/strategy/:id/equity
    // Query params:
    //   window    = "ALL" | "<n>D" | "<n>W" | "<n>M" | "<n>Y"  (e.g. 1W, 2M, 6M, 1Y)
    //   benchmark = <asset name>
    //
    // Returns:
    //   - basic strategy metadata
    //   - window & sampling info
    //   - points: strategy equity curve over the window (with rebased value)
    //   - benchmark: optional benchmark curve over the same timestamps
    app.get("/api/strategy/:id/equity", (req, res) => {
        // Cap the number of equity points returned to keep payload size and chart rendering fast.
        // We always keep the first and last point.
        const MAX_EQUITY_POINTS = 100;

        function thinKeepEnds<T>(arr: T[], maxPoints: number): T[] {
            const n = arr.length;
            if (n <= maxPoints) return arr;
            if (maxPoints <= 1) return [arr[0]];
            if (maxPoints === 2) return [arr[0], arr[n - 1]];

            const step = Math.ceil((n - 1) / (maxPoints - 1));
            const out: T[] = [];
            for (let i = 0; i < n; i += step) out.push(arr[i]);

            const last = arr[n - 1];
            if (out[out.length - 1] !== last) out.push(last);

            // If we ended up with one extra point due to the forced last-point push,
            // drop one interior point (keep first/last).
            if (out.length > maxPoints) {
                out.splice(out.length - 2, 1);
            }
            return out;
        }

        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ error: "Invalid strategy id" });
        }

        const strat = db
        .prepare(
            `
            SELECT
            id,
            trader_address,
            strategy_name,
            first_signal_ts,
            last_signal_ts,
            last_value_index,
            last_segment_end_ts
            FROM strategies
            WHERE id = ?
            `
        )
        .get(id) as
        | {
            id: number;
            trader_address: string;
            strategy_name: string;
            first_signal_ts: number;
            last_signal_ts: number;
            last_value_index: number;
            last_segment_end_ts: number | null;
        }
        | undefined;

        if (!strat) {
            return res.status(404).json({ error: "Strategy not found" });
        }

        const segments = db
        .prepare(
            `
            SELECT
            start_ts,
            end_ts,
            value_index_end
            FROM strategy_segments
            WHERE strategy_id = ?
            ORDER BY end_ts ASC
            `
        )
        .all(id) as {
            start_ts: number;
            end_ts: number;
            value_index_end: number;
        }[];

        if (segments.length === 0) {
            return res.json({
                id: strat.id,
                trader: strat.trader_address,
                strategyName: strat.strategy_name,
                firstSignalTs: strat.first_signal_ts,
                lastSignalTs: strat.last_signal_ts,
                lastValueIndex: strat.last_value_index,
                window: "ALL",
                sampling: null,
                points: [],
                benchmark: null,
            });
        }

        // ---- window + benchmark params ----

        const windowParam =
        typeof req.query.window === "string" ? req.query.window : "ALL";
        const benchmarkParam =
        typeof req.query.benchmark === "string"
        ? req.query.benchmark.toUpperCase()
        : undefined;

        const parseWindowToSeconds = (w: string | undefined): number | null => {
            if (!w) return null;
            const upper = w.toUpperCase();
            if (upper === "ALL") return null;
            const m = /^(\d+)([DWMY])$/.exec(upper.trim());
            if (!m) return null;
            const value = Number(m[1]);
            const unit = m[2];
            if (!Number.isFinite(value) || value <= 0) return null;
            const DAY = 24 * 60 * 60;
            switch (unit) {
                case "D":
                    return value * DAY;
                case "W":
                    return value * 7 * DAY;
                case "M":
                    return value * 30 * DAY; // approx
                case "Y":
                    return value * 365 * DAY; // approx
                default:
                    return null;
            }
        };

        // Determine fromTs based on window
        const lastSeg = segments[segments.length - 1];
        const lastTs =
        strat.last_segment_end_ts ?? lastSeg.end_ts ?? strat.last_signal_ts;

        const durationSec = parseWindowToSeconds(windowParam);
        let fromTs = 0;
        let windowLabel = "ALL";

        if (durationSec && lastTs) {
            fromTs = Math.max(0, lastTs - durationSec);
            windowLabel = windowParam.toUpperCase();
        }

        let windowSegments = segments;
        if (fromTs > 0) {
            windowSegments = segments.filter((s) => s.end_ts >= fromTs);
            if (windowSegments.length === 0) {
                // fallback to full history if the requested window is empty
                windowSegments = segments;
                windowLabel = "ALL";
            }
        }

        // ---- thin equity points to a fixed upper bound ----

        const sampledSegments = thinKeepEnds(windowSegments, MAX_EQUITY_POINTS);
        const sampling: "hourly" = "hourly";

        if (sampledSegments.length === 0) {
            return res.json({
                id: strat.id,
                trader: strat.trader_address,
                strategyName: strat.strategy_name,
                firstSignalTs: strat.first_signal_ts,
                lastSignalTs: strat.last_signal_ts,
                lastValueIndex: strat.last_value_index,
                window: windowLabel,
                sampling: sampling,
                points: [],
                benchmark: null,
            });
        }

        // Align chart series with stats: include a starting point at the beginning of the first segment
        // in the selected window. This ensures the rebased curve's total return matches the stats window return.
        const firstWindowSeg = sampledSegments[0];

        // Find index of first window segment in the full segments array
        const i0 = segments.findIndex((s) => s.start_ts === firstWindowSeg.start_ts && s.end_ts === firstWindowSeg.end_ts);

        // Stats logic uses equity *at window start* as the base: previous segment's end (or 1.0 for the very beginning)
        const baseValue =
            i0 > 0 && segments[i0 - 1].value_index_end > 0
                ? segments[i0 - 1].value_index_end
                : 1;

        const windowStartTs = i0 === 0 ? Math.max(firstWindowSeg.start_ts, strat.first_signal_ts) : firstWindowSeg.start_ts;

        const points = [
            {
                timestamp: windowStartTs,
                valueIndex: baseValue,
                valueIndexRebased: 1,
            },
            ...sampledSegments.map((seg) => ({
                timestamp: seg.end_ts,
                valueIndex: seg.value_index_end,
                valueIndexRebased:
                    baseValue > 0 ? seg.value_index_end / baseValue : 1,
            })),
        ];

        // ---- optional benchmark over same timestamps ----

        let benchmark: null | {
            symbol: string;
            points: {
                timestamp: number;
                price: number;
                priceRebased: number;
            }[];
        } = null;

        if (benchmarkParam) {
            if (benchmarkParam === "USD") {
                // flat cash benchmark at 1.0
                const benchPoints = points.map((p) => ({
                    timestamp: p.timestamp,
                    price: 1,
                    priceRebased: 1,
                }));
                benchmark = {
                    symbol: "USD",
                    points: benchPoints,
                };
            } else {
                const PRICED_ASSETS = new Set(Object.keys(SUPPORTED_ASSETS));
                if (PRICED_ASSETS.has(benchmarkParam)) {
                    const from = points[0].timestamp;
                    const to = points[points.length - 1].timestamp;

                    const priceRows = db
                    .prepare(
                        `
                        SELECT timestamp, price_usd AS price
                        FROM prices
                        WHERE asset_symbol = ?
                        AND timestamp >= ?
                        AND timestamp <= ?
                        ORDER BY timestamp ASC
                        `
                    )
                    .all(
                        benchmarkParam,
                         from,
                         to
                    ) as { timestamp: number; price: number }[];

                    // Map timestamp -> price for quick lookup
                    const priceMap = new Map<number, number>();
                    for (const row of priceRows) {
                        priceMap.set(row.timestamp, row.price);
                    }

                    let basePrice: number | null = null;
                    const benchPoints: {
                        timestamp: number;
                        price: number;
                        priceRebased: number;
                    }[] = [];

                    // IMPORTANT: use the same timestamps as the strategy points
                    for (const p of points) {
                        // Prices are stored at hourly timestamps; strategy points may include a non-hour initial point.
                        // If there's no exact match, carry forward the last known price (or use the first available price for the first point).
                        let price = priceMap.get(p.timestamp);
                        if (typeof price !== "number" || price <= 0) {
                            if (benchPoints.length === 0 && priceRows.length > 0) {
                                price = priceRows[0].price;
                            } else if (benchPoints.length > 0) {
                                price = benchPoints[benchPoints.length - 1].price;
                            } else {
                                continue;
                            }
                        }
                        if (basePrice === null) basePrice = price;
                        benchPoints.push({
                            timestamp: p.timestamp,
                            price,
                            priceRebased:
                            basePrice && basePrice > 0
                            ? price / basePrice
                            : 1,
                        });
                    }

                    if (benchPoints.length > 0) {
                        benchmark = {
                            symbol: benchmarkParam,
                            points: benchPoints,
                        };
                    }
                }
            }
        }

        // ---- response ----

        res.json({
            id: strat.id,
            trader: strat.trader_address,
            strategyName: strat.strategy_name,
            firstSignalTs: strat.first_signal_ts,
            lastSignalTs: strat.last_signal_ts,
            lastValueIndex: strat.last_value_index,
            window: windowLabel,
            sampling,
            points, // strategy curve (includes valueIndexRebased)
        benchmark,
        });
    });



    app.listen(port, () => {
        console.log(`ChainSignals backend listening on http://localhost:${port}`);
    });
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
