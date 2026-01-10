import { db } from "./db";
import { SUPPORTED_ASSETS } from "./prices";

type PriceRow = { asset_symbol: string; timestamp: number; price_usd: number };
type StrategyRow = {
    id: number;
    trader_address: string;
    strategy_name: string;
    first_signal_ts: number;
    last_signal_ts: number;
    last_value_index: number;
    last_segment_end_ts: number | null;
};
type SignalRow = {
    asset_symbol: string;
    direction: number; // 0=Long,1=Short (contract enum)
    leverage: number;
    weight_raw: number;
    timestamp: number;
};

type HoldingRow = {
    asset_symbol: string;
    value: number;
    direction: number; // -1 short, +1 long, 0 cash
    leverage: number;
    is_usd: number;
};
type SegmentRow = {
    start_ts: number;
    end_ts: number;
    duration_sec: number;
    raw_return: number;
    hourly_equiv_ret: number;
    value_index_end: number;
};

// time windows for stats
const STAT_WINDOWS = [
    { id: "1W", seconds: 7 * 24 * 3600 },
    { id: "1M", seconds: 30 * 24 * 3600 },
    { id: "3M", seconds: 90 * 24 * 3600 },
    { id: "6M", seconds: 180 * 24 * 3600 },
    { id: "1Y", seconds: 365 * 24 * 3600 },
    { id: "ALL", seconds: Infinity },
    ] as const;

// Sharpe maturity + minimum data requirements
const MIN_SHARPE_OBS = 24;              // at least 24 hourly observations
const SHARPE_MATURITY_HOURS = 24 * 30;  // ~1 month ramp to full weight (720 hours)

function maturityMultiplier(totalHours: number): number {
    if (!Number.isFinite(totalHours) || totalHours <= 0) return 0;

    // Linear ramp from 0 to 1 over SHARPE_MATURITY_HOURS
    const m = totalHours / SHARPE_MATURITY_HOURS;
    return Math.max(0, Math.min(1, m));
}

let prepared = false;

let getAllPriceRowsStmt: any;
let getAllStrategiesStmt: any;
let getSignalsForStrategyStmt: any;
let insertSegmentStmt: any;
let updateStrategyAfterSegmentsStmt: any;
let getSegmentsForStrategyStmt: any;
let upsertStatsStmt: any;

let getHoldingsForStrategyStmt: any;
let upsertPositionSnapshotStmt: any;
let deleteHoldingsForStrategyStmt: any;
let upsertHoldingStmt: any;

function prepareStatements() {
    if (prepared) return;
    prepared = true;

    getAllPriceRowsStmt = db.prepare(
        `SELECT asset_symbol, timestamp, price_usd
        FROM prices
        ORDER BY timestamp ASC`
    );

    getAllStrategiesStmt = db.prepare(
        `SELECT id, trader_address, strategy_name,
        first_signal_ts, last_signal_ts,
        last_value_index, last_segment_end_ts
        FROM strategies`
    );

    getSignalsForStrategyStmt = db.prepare(
        `SELECT asset_symbol, direction, leverage, weight_raw, timestamp
        FROM signals
        WHERE trader_address = ? AND strategy_name = ?
        ORDER BY timestamp ASC`
    );

    insertSegmentStmt = db.prepare(
        `INSERT OR IGNORE INTO strategy_segments (
            strategy_id, start_ts, end_ts, duration_sec,
            raw_return, hourly_equiv_ret, value_index_end
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    updateStrategyAfterSegmentsStmt = db.prepare(
        `UPDATE strategies
        SET last_value_index = ?, last_segment_end_ts = ?
        WHERE id = ?`
    );

    getSegmentsForStrategyStmt = db.prepare(
        `SELECT start_ts, end_ts, duration_sec,
        raw_return, hourly_equiv_ret, value_index_end
        FROM strategy_segments
        WHERE strategy_id = ?
        ORDER BY end_ts ASC`
    );

    upsertStatsStmt = db.prepare(`
    INSERT INTO strategy_stats (
        strategy_id, window, last_updated_ts,
        sharpe_annual, vol_annual, vol_hourly,
        total_return, max_drawdown
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id, window) DO UPDATE SET
    last_updated_ts = excluded.last_updated_ts,
    sharpe_annual   = excluded.sharpe_annual,
    vol_annual      = excluded.vol_annual,
    vol_hourly      = excluded.vol_hourly,
    total_return    = excluded.total_return,
    max_drawdown    = excluded.max_drawdown
    `);

    getHoldingsForStrategyStmt = db.prepare(
        `SELECT asset_symbol, value, direction, leverage, is_usd
         FROM strategy_holdings
         WHERE strategy_id = ?`
    );

    deleteHoldingsForStrategyStmt = db.prepare(
        `DELETE FROM strategy_holdings WHERE strategy_id = ?`
    );

    upsertHoldingStmt = db.prepare(
        `INSERT INTO strategy_holdings (strategy_id, asset_symbol, value, direction, leverage, is_usd)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(strategy_id, asset_symbol) DO UPDATE SET
           value     = excluded.value,
           direction = excluded.direction,
           leverage  = excluded.leverage,
           is_usd    = excluded.is_usd`
    );


    upsertPositionSnapshotStmt = db.prepare(
        `INSERT INTO strategy_position_snapshots (strategy_id, signal_ts, positions_json)
         VALUES (?, ?, ?)
         ON CONFLICT(strategy_id, signal_ts) DO UPDATE SET
           positions_json = excluded.positions_json`
    );
}

function clampPct(weightRaw: number): number {
    if (!Number.isFinite(weightRaw)) return 0;
    const w = Math.max(0, Math.min(100, Math.floor(weightRaw)));
    return w / 100;
}

function isUsdAsset(asset: string): boolean {
    return asset.toUpperCase() === "USD";
}

function isSupportedAsset(asset: string): boolean {
    const sym = asset.toUpperCase();
    return isUsdAsset(sym) || Object.prototype.hasOwnProperty.call(SUPPORTED_ASSETS, sym);
}

type PosMeta = { direction: -1 | 0 | 1; leverage: number; isUsd: boolean };

function sumBuckets(buckets: Record<string, number>): number {
    let s = 0;
    for (const v of Object.values(buckets)) s += v;
    return s;
}

type PriceSeries = { ts: number[]; px: number[] };

function buildPriceSeries(priceRows: PriceRow[]): Record<string, PriceSeries> {
    const out: Record<string, PriceSeries> = {};
    for (const row of priceRows) {
        const sym = row.asset_symbol.toUpperCase();
        if (!out[sym]) out[sym] = { ts: [], px: [] };
        out[sym].ts.push(row.timestamp);
        out[sym].px.push(row.price_usd);
    }
    return out;
}

function priceAtOrBefore(series: PriceSeries | undefined, ts: number): number | null {
    if (!series || series.ts.length === 0) return null;
    // binary search for rightmost index with series.ts[i] <= ts
    let lo = 0;
    let hi = series.ts.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = series.ts[mid];
        if (t <= ts) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best < 0) return null;
    const p = series.px[best];
    return typeof p === "number" && p > 0 ? p : null;
}

/**
 * Rebalance rule (intuitive target % semantics):
 *  - First non-flat signal sets 100% to that asset.
 *  - Otherwise, signal sets THIS asset to targetPct of total equity,
 *    and scales all other holdings proportionally into the remaining (1-targetPct).
 *  - Signals set a target allocation % (0..100, capped).
 *  - weight_raw == 0 means exit that asset (0% allocation).
 *  - No implicit rebalancing between signal timestamps.
 */
function applySignalTargetPct(params: {
    buckets: Record<string, number>;
    meta: Record<string, PosMeta>;
    asset: string;
    direction: number;
    leverage: number;
    weight_raw: number;
}) {
    const { buckets, meta } = params;
    const asset = params.asset.toUpperCase();

    if (!isSupportedAsset(asset)) return; // ignore completely

    const usd = isUsdAsset(asset);

    // Ensure meta for this asset
    // Contract enum: 0=Long, 1=Short. (We treat any non-1 value as Long for safety.)
    const dir: -1 | 0 | 1 = usd ? 0 : params.direction === 1 ? -1 : 1;
    const lev = usd ? 1 : Math.max(1, Math.min(5, Math.floor(params.leverage)));
    meta[asset] = { direction: dir, leverage: lev, isUsd: usd };

    const total = sumBuckets(buckets);

    // First ever position: force 100% into this asset (ignore weight)
    // NOTE: For brand-new strategies we seed buckets with USD=1 to represent "in cash".
    // That should still count as "flat" for the first non-cash signal.
    const hasNonUsdExposure = Object.entries(buckets).some(
        ([sym, v]) => !isUsdAsset(sym) && (Number(v) || 0) > 0
    );

    const isBrandNewSeed =
        Object.keys(buckets).length === 1 &&
        (buckets["USD"] ?? 0) === 1.0 &&
        !hasNonUsdExposure;

    if (total <= 0 || isBrandNewSeed) {
        // Start with unit equity
        buckets[asset] = 1.0;
        // clear anything else
        for (const k of Object.keys(buckets)) {
            if (k !== asset) delete buckets[k];
        }
        // if this is USD, keep as cash
        return;
    }

    const targetPct = clampPct(params.weight_raw);
    const current = buckets[asset] ?? 0;
    const otherTotal = total - current;
    const desired = targetPct * total;
    const desiredOtherTotal = total - desired;

    if (otherTotal > 0) {
        const k = desiredOtherTotal / otherTotal;
        for (const a of Object.keys(buckets)) {
            if (a === asset) continue;
            buckets[a] *= k;
        }
    } else {
        // Only this asset existed; if desired < total, remainder becomes cash
        if (desiredOtherTotal > 0) {
            buckets["USD"] = (buckets["USD"] ?? 0) + desiredOtherTotal;
            meta["USD"] = { direction: 0, leverage: 1, isUsd: true };
        }
    }

    // If target is 0%, we remove the asset bucket entirely (others were already scaled to 100%).
    if (desired <= 0) {
        delete buckets[asset];
        delete meta[asset];
        return;
    }

    buckets[asset] = desired;
}

/**
 * Extend segments for all strategies based on currently known prices.
 * Only computes segments for time ranges after each strategy's last_segment_end_ts.
 */
export function extendAllStrategySegments() {
    prepareStatements();

    console.log("[segments] extending segments for all strategies...");

    const priceRows = getAllPriceRowsStmt.all() as PriceRow[];

    if (priceRows.length < 2) {
        console.log("[segments] Not enough price data yet, skipping.");
        return;
    }

    // Distinct timestamps sorted (we only CREATE segments on hourly boundaries)
    const tsSet = new Set<number>();
    for (const row of priceRows) {
        if (row.timestamp % 3600 === 0) tsSet.add(row.timestamp);
    }
    const allHourlyTimestamps = Array.from(tsSet).sort((a, b) => a - b);

    // Build per-asset price series including intra-hour "signal-time" samples
    // so we can drift/rebalance inside each hourly segment.
    const assetPriceSeries = buildPriceSeries(priceRows);

    const strategies = getAllStrategiesStmt.all() as StrategyRow[];
    if (strategies.length === 0) {
        console.log("[segments] No strategies yet, done.");
        return;
    }

    for (const strat of strategies) {
        extendSegmentsForStrategy(strat, allHourlyTimestamps, assetPriceSeries);
    }

    console.log("[segments] extension complete.");
}

function extendSegmentsForStrategy(
    strat: StrategyRow,
    allTimestamps: number[],
    assetPriceSeries: Record<string, PriceSeries>
) {
    const signals = getSignalsForStrategyStmt.all(
        strat.trader_address,
        strat.strategy_name
    ) as SignalRow[];

    if (signals.length === 0) {
        return;
    }

    const maxTs = allTimestamps[allTimestamps.length - 1];
    if (maxTs <= strat.first_signal_ts) {
        // no price data beyond first signal
        return;
    }

    // Determine where to start new segments
    const lastSegEnd = strat.last_segment_end_ts;
    let startIdx = -1;

    if (lastSegEnd == null) {
        // First time:
        // Start at the hour boundary *containing* the first signal so the first segment
        // ends at the next top-of-hour, producing a holdings snapshot at that first hour.
        // Example: first signal at 11:40 -> first segment should be [11:00, 12:00].
        // (Signals inside the hour are handled by the intra-hour loop.)
        for (let i = 0; i < allTimestamps.length - 1; i++) {
            const t0 = allTimestamps[i];
            const t1 = allTimestamps[i + 1];
            if (t0 <= strat.first_signal_ts && strat.first_signal_ts < t1) {
                startIdx = i;
                break;
            }
        }

        // If the first signal is before our first available hourly timestamp, start at 0.
        if (startIdx === -1 && allTimestamps.length >= 2) {
            startIdx = 0;
        }
    } else {
        // resume: start at last_segment_end_ts if it exists in the timestamp grid
        // (important when last_segment_end_ts is a signal-time boundary; we need a segment starting there)
        for (let i = 0; i < allTimestamps.length - 1; i++) {
            if (allTimestamps[i] >= lastSegEnd) {
                startIdx = i;
                break;
            }
        }
    }

    if (startIdx === -1 || startIdx >= allTimestamps.length - 1) {
        // nothing new to compute
        return;
    }

    // Buy-and-hold simulation state
    // buckets: per-asset capital values (sum = equity)
    // meta: per-asset return parameters (direction/leverage)
    let valueIndex = strat.last_value_index || 1.0;
    const buckets: Record<string, number> = {};
    const meta: Record<string, PosMeta> = {};

    // IMPORTANT (brand-new strategies):
    // When a strategy's first signal happens *inside* an hour (e.g. 11:40), we start
    // the first segment at the containing hour boundary (11:00 -> 12:00). If buckets
    // are left empty at 11:00, the old logic would treat equityStart=0 and skip all
    // intra-hour signal processing, producing flat segments until the *next* hour.
    //
    // To match the intended semantics (in cash before first signal, then rebalance at
    // signal time within the hour), we seed a unit USD cash bucket at the very start
    // of a brand-new strategy run. This keeps equity positive so intra-hour signals
    // are applied and returns accrue correctly within the first hour.
    if (strat.last_segment_end_ts == null) {
        buckets["USD"] = 1.0;
        meta["USD"] = { direction: 0, leverage: 1, isUsd: true };
    }

    // Resume holdings if we have them
    if (strat.last_segment_end_ts != null) {
        const rows = getHoldingsForStrategyStmt.all(strat.id) as HoldingRow[];
        for (const r of rows) {
            buckets[r.asset_symbol.toUpperCase()] = r.value;
            meta[r.asset_symbol.toUpperCase()] = {
                direction: (r.direction as -1 | 0 | 1) ?? 0,
                leverage: r.leverage ?? 1,
                isUsd: !!r.is_usd,
            };
        }
    }

    const recordPositionSnapshot = (signalTs: number) => {
        // Build positions as percentages of current equity (sum of buckets).
        const total = sumBuckets(buckets);
        if (!Number.isFinite(total) || total <= 0) return;

        const positions = Object.entries(buckets)
            .filter(([_, v]) => (Number(v) || 0) > 0)
            .map(([assetRaw, v]) => {
                const asset = assetRaw.toUpperCase();
                if (!isSupportedAsset(asset)) return null;

                const isUsd = isUsdAsset(asset);
                const m = meta[asset] ?? { direction: 0 as -1 | 0 | 1, leverage: 1, isUsd };
                const direction = isUsd ? "CASH" : m.direction < 0 ? "SHORT" : "LONG";
                const leverage = isUsd ? 1 : Number(m.leverage) || 1;
                const percent = (Number(v) / total) * 100;

                return { asset, percent, direction, leverage };
            })
            .filter((p): p is { asset: string; percent: number; direction: string; leverage: number } => !!p);

        if (!positions.length) return;

        upsertPositionSnapshotStmt.run(strat.id, signalTs, JSON.stringify(positions));
    };



    // We'll apply signals in chronological order as we walk timestamps.
    let sigIdx = 0;

    // If resuming, fast-forward sigIdx and also rebuild meta params for assets
    // based on last signals up to last_segment_end_ts (holdings already reflect drift).
    if (lastSegEnd != null) {
        while (sigIdx < signals.length && signals[sigIdx].timestamp <= lastSegEnd) {
            const s = signals[sigIdx];
            // Update meta params (target pct already baked into holdings at last rebalance)
            if (isSupportedAsset(s.asset_symbol)) {
                const asset = s.asset_symbol.toUpperCase();
                const usd = isUsdAsset(asset);

                // Update meta params based on most recent signal. If the target % is 0,
                // the asset would have been removed at the rebalance time, so we drop meta too.
                const pct = clampPct(s.weight_raw);
                if (pct <= 0) {
                    delete meta[asset];
                } else {
                    meta[asset] = {
                        direction: usd ? 0 : s.direction === 1 ? -1 : 1,
                        leverage: usd ? 1 : Math.max(1, Math.min(5, Math.floor(s.leverage))),
                        isUsd: usd,
                    };
                }
            }
            sigIdx++;
        }
    }

    const tx = db.transaction(() => {
        for (let k = startIdx; k < allTimestamps.length - 1; k++) {
            const tStart = allTimestamps[k];
            const tEnd = allTimestamps[k + 1];

            if (tEnd <= tStart) continue;
            if (tEnd <= strat.first_signal_ts) continue;

            const durationSec = tEnd - tStart;
            const durationHours = durationSec / 3600;

            // Apply any signals up to and including tStart (rebalance at signal timestamp)
            // We also persist a positions snapshot at each distinct signal timestamp we apply here
            // (signals exactly on the hour boundary are handled in this pre-loop).
            while (sigIdx < signals.length && signals[sigIdx].timestamp <= tStart) {
                const ts = signals[sigIdx].timestamp;

                // Apply all signals at this timestamp
                while (sigIdx < signals.length && signals[sigIdx].timestamp === ts) {
                    const s = signals[sigIdx];
                    applySignalTargetPct({
                        buckets,
                        meta,
                        asset: s.asset_symbol,
                        direction: s.direction,
                        leverage: s.leverage,
                        weight_raw: s.weight_raw,
                    });
                    sigIdx++;
                }

                recordPositionSnapshot(ts);
            }

            // Helper: drift buckets from t0 -> t1 using prices available at-or-before each timestamp.
            const drift = (t0: number, t1: number) => {
                if (t1 <= t0) return;
                for (const [asset, val] of Object.entries(buckets)) {
                    if (val <= 0) continue;
                    const sym = asset.toUpperCase();
                    if (isUsdAsset(sym)) continue;

                    const series = assetPriceSeries[sym];
                    const p0 = priceAtOrBefore(series, t0);
                    const p1 = priceAtOrBefore(series, t1);
                    if (p0 == null || p1 == null || p0 <= 0) continue;

                    const rAsset = (p1 - p0) / p0;
                    const m = meta[sym] ?? { direction: 1, leverage: 1, isUsd: false };
                    const signed = m.direction * m.leverage * rAsset;
                    const mult = 1 + signed;
                    buckets[sym] = mult <= 0 ? 0 : val * mult;
                }
            };

            const equityStart = sumBuckets(buckets);
            if (equityStart <= 0) {
                // No exposure; keep equity flat at current valueIndex.
                // We still store a segment so window stats have continuity.
                insertSegmentStmt.run(
                    strat.id,
                    tStart,
                    tEnd,
                    durationSec,
                    0,
                    0,
                    valueIndex
                );
                updateStrategyAfterSegmentsStmt.run(valueIndex, tEnd, strat.id);
                continue;
            }

            // Intra-hour handling: drift to each signal timestamp inside (tStart, tEnd], rebalance, then continue.
            let cursorTs = tStart;
            while (sigIdx < signals.length && signals[sigIdx].timestamp <= tEnd) {
                const sigTs = signals[sigIdx].timestamp;
                if (sigTs > cursorTs) {
                    drift(cursorTs, sigTs);
                    cursorTs = sigTs;
                }

                // Apply ALL signals at the same timestamp after drifting once to sigTs.
                while (sigIdx < signals.length && signals[sigIdx].timestamp === sigTs) {
                    const s = signals[sigIdx];
                    applySignalTargetPct({
                        buckets,
                        meta,
                        asset: s.asset_symbol,
                        direction: s.direction,
                        leverage: s.leverage,
                        weight_raw: s.weight_raw,
                    });
                    sigIdx++;
                }

                recordPositionSnapshot(sigTs);
            }

            // Drift remaining part of the hour
            drift(cursorTs, tEnd);

            const equityEnd = sumBuckets(buckets);
            const rawReturn = equityEnd / equityStart - 1;

            valueIndex *= 1 + rawReturn;

            const hourlyEquiv = durationHours > 0 ? rawReturn / durationHours : 0;

            insertSegmentStmt.run(
                strat.id,
                tStart,
                tEnd,
                durationSec,
                rawReturn,
                hourlyEquiv,
                valueIndex
            );

            updateStrategyAfterSegmentsStmt.run(valueIndex, tEnd, strat.id);
        }

        // Persist final holdings snapshot for incremental extension
        deleteHoldingsForStrategyStmt.run(strat.id);
        for (const [asset, value] of Object.entries(buckets)) {
            if (!Number.isFinite(value) || value <= 0) continue;
            const m = meta[asset.toUpperCase()] ?? { direction: isUsdAsset(asset) ? 0 : 1, leverage: 1, isUsd: isUsdAsset(asset) };
            upsertHoldingStmt.run(
                strat.id,
                asset.toUpperCase(),
                value,
                m.direction,
                m.leverage,
                m.isUsd ? 1 : 0
            );
        }
    });

    tx();
}

/**
 * Recompute stats (Sharpe, vol, total return, max drawdown)
 * for ALL strategies and ALL windows, based on current segments.
 *
 *  - Numerator: drift per hour from total log return over window
 *  - Denominator: stddev of hourly_equiv_ret (per hour)
 *  - Max drawdown: from equity normalized at window start
 */
export function recomputeAllStrategyStats() {
    prepareStatements();

    console.log("[stats] recomputing strategy stats for all windows...");

    const strategies = getAllStrategiesStmt.all() as StrategyRow[];
    if (strategies.length === 0) {
        console.log("[stats] No strategies yet, done.");
        return;
    }

    const nowSec = Math.floor(Date.now() / 1000);

    const tx = db.transaction(() => {
        for (const strat of strategies) {
            const segments = getSegmentsForStrategyStmt.all(
                strat.id
            ) as SegmentRow[];

            recomputeStatsForStrategy(strat.id, segments, nowSec);
        }
    });

    tx();

    console.log("[stats] recompute complete.");
}

function recomputeStatsForStrategy(
    strategyId: number,
    segments: SegmentRow[],
    nowSec: number
) {
    if (segments.length === 0) {
        // Still insert stats rows with neutral values if you like,
        // but here we just skip; they won't show up in leaderboards until they have history.
        return;
    }

    const n = segments.length;
    const endTs = segments.map((s) => s.end_ts);
    const startTs = segments.map((s) => s.start_ts);
    const hourlyRets = segments.map((s) => s.hourly_equiv_ret);
    const valueIdx = segments.map((s) => s.value_index_end);

    for (const window of STAT_WINDOWS) {
        const winId = window.id;
        const seconds = window.seconds;

        let cutoffTs = -Infinity;
        if (seconds !== Infinity) {
            cutoffTs = nowSec - seconds;
        }

        // find first index with end_ts >= cutoffTs
        let i0 = 0;
        if (seconds !== Infinity) {
            i0 = segments.findIndex((s) => s.end_ts >= cutoffTs);
            if (i0 === -1) {
                // no segments in this window
                upsertStatsStmt.run(
                    strategyId,
                    winId,
                    nowSec,
                    null, // sharpe
                    null, // vol_annual
                    null, // vol_hourly
                    0.0,  // total_return
                    0.0   // max_drawdown
                );
                continue;
            }
        } else {
            // ALL: start from first segment
            i0 = 0;
        }

        // baseValue is equity at window start
        const baseValue = i0 > 0 ? valueIdx[i0 - 1] : 1.0;
        const finalValue = valueIdx[n - 1];

        if (baseValue <= 0 || finalValue <= 0) {
            upsertStatsStmt.run(
                strategyId,
                winId,
                nowSec,
                null,
                null,
                null,
                0.0,
                0.0
            );
            continue;
        }

        const totalReturn = finalValue / baseValue - 1.0;
        const totalLogReturn = Math.log(finalValue) - Math.log(baseValue);

        // collect window hourly returns & total hours in window
        const windowHourly: number[] = [];
        let totalHours = 0;

        for (let j = i0; j < n; j++) {
            const durSec = segments[j].duration_sec;
            const durHr = durSec / 3600;
            if (durHr <= 0) continue;

            totalHours += durHr;
            windowHourly.push(hourlyRets[j]);
        }

        if (totalHours <= 0 || windowHourly.length < 2) {
            // Not enough info for Sharpe/vol
            const maxDD = computeMaxDrawdown(valueIdx, i0, baseValue);
            upsertStatsStmt.run(
                strategyId,
                winId,
                nowSec,
                null,
                null,
                null,
                totalReturn,
                maxDD
            );
            continue;
        }

        const mu = totalLogReturn / totalHours; // drift per hour

        const nHr = windowHourly.length;
        const meanHr =
        windowHourly.reduce((acc, x) => acc + x, 0) / nHr;
        const variance =
        windowHourly.reduce((acc, x) => acc + (x - meanHr) * (x - meanHr), 0) /
        (nHr - 1);
        const stdHr = Math.sqrt(variance);

        if (!isFinite(stdHr) || stdHr === 0) {
            const maxDD = computeMaxDrawdown(valueIdx, i0, baseValue);
            upsertStatsStmt.run(
                strategyId,
                winId,
                nowSec,
                null,
                null,
                null,
                totalReturn,
                maxDD
            );
            continue;
        }

        let sharpeAnnual: number | null = null;

        if (nHr >= MIN_SHARPE_OBS && Number.isFinite(stdHr) && stdHr > 0) {
            const sharpeHourly = mu / stdHr;
            const sharpeAnnualRaw = sharpeHourly * Math.sqrt(8760);

            if (Number.isFinite(sharpeAnnualRaw)) {
                const m = maturityMultiplier(totalHours);
                sharpeAnnual = sharpeAnnualRaw * m;
            }
        }

        const volHourly = stdHr;
        const volAnnual = stdHr * Math.sqrt(8760);

        const maxDD = computeMaxDrawdown(valueIdx, i0, baseValue);

        upsertStatsStmt.run(
            strategyId,
            winId,
            nowSec,
            sharpeAnnual,
            volAnnual,
            volHourly,
            totalReturn,
            maxDD
        );
    }
}

/**
 * Compute max drawdown over segments[i0..end], using value_index_end
 * normalized so that equity = 1 at window start.
 */
function computeMaxDrawdown(
    valueIdx: number[],
    i0: number,
    baseValue: number
): number {
    let peak = 1.0;
    let maxDD = 0.0;

    // Optional: we can consider equity = 1 at window start before first segment

    for (let j = i0; j < valueIdx.length; j++) {
        const eq = valueIdx[j] / baseValue; // normalized equity
        if (eq > peak) {
            peak = eq;
        }
        const dd = (peak - eq) / peak;
        if (dd > maxDD) {
            maxDD = dd;
        }
    }

    return maxDD;
}
