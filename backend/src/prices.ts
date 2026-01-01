import dotenv from "dotenv";
import { db } from "./db";

dotenv.config();

const CG_API_KEY = process.env.COINGECKO_API_KEY || "";

// Supported assets and their CoinGecko IDs
export const SUPPORTED_ASSETS: { [symbol: string]: string } = {
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    XRP: "ripple",
    KAS: "kaspa",

    // New supported assets (displayed as GOLD/SILVER/SPX in the UI)
    GOLD: "pax-gold",
    SILVER: "kinesis-silver",
    SPX: "backed-cspx-core-s-p-500",
};

// lazy prep
let prepared = false;
let insertPriceStmt: any;
let getMetaStmt: any;
let setMetaStmt: any;

// for per-asset signal timestamps in a time range
let getSignalTimesForAssetInRangeStmt: any;
// for strategy creation timestamps in a time range (used to seed benchmark points)
let getStrategyStartTimesInRangeStmt: any;

function prepareStatements() {
    if (prepared) return;
    prepared = true;

    insertPriceStmt = db.prepare(`
    INSERT OR IGNORE INTO prices (asset_symbol, timestamp, price_usd)
    VALUES (?, ?, ?)
    `);

    getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
    setMetaStmt = db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
    );

    // all signal timestamps for an asset in a given time range
    getSignalTimesForAssetInRangeStmt = db.prepare(`
    SELECT DISTINCT timestamp AS ts
    FROM signals
    WHERE asset_symbol = ?
    AND timestamp BETWEEN ? AND ?
    ORDER BY ts ASC
    `);

    // all strategy first_signal_ts in a given time range
    getStrategyStartTimesInRangeStmt = db.prepare(`
    SELECT DISTINCT first_signal_ts AS ts
    FROM strategies
    WHERE first_signal_ts BETWEEN ? AND ?
    ORDER BY ts ASC
    `);
}


type PricePoint = { ts: number; price: number };

/**
 * Pick a canonical hourly price for a given hour boundary.
 * We store prices on an hourly grid (timestamp == hour boundary), even if the
 * upstream API samples are offset (e.g. every 5 minutes).
 *
 * We prefer the last sample at-or-before the boundary within a tolerance window
 * to avoid forward-looking bias. If none exists, we fall back to the closest
 * sample (either side) within tolerance.
 */
function pickHourlyPrice(
    points: PricePoint[],
    hourSec: number,
    toleranceSec = 10 * 60
): number | null {
    const tol = toleranceSec;

    // Prefer last sample <= hourSec within tolerance
    let bestBefore: PricePoint | null = null;
    for (const p of points) {
        if (p.ts <= hourSec && hourSec - p.ts <= tol) {
            if (!bestBefore || p.ts > bestBefore.ts) bestBefore = p;
        }
    }
    if (bestBefore) return bestBefore.price;

    // Fallback: closest sample in either direction within tolerance
    let best: PricePoint | null = null;
    let bestDist = Infinity;
    for (const p of points) {
        const d = Math.abs(p.ts - hourSec);
        if (d <= tol && d < bestDist) {
            bestDist = d;
            best = p;
        }
    }
    return best ? best.price : null;
}

/**
 * Fetch current USD prices for SUPPORTED_ASSETS from CoinGecko.
 * Uses global fetch (Node 18+).
 */
export async function fetchCurrentPricesUSD(): Promise<Record<string, number>> {
    const ids = Object.values(SUPPORTED_ASSETS).join(",");

    const url =
    `https://api.coingecko.com/api/v3/simple/price` +
    `?ids=${ids}&vs_currencies=usd` +
    (CG_API_KEY ? `&x_cg_demo_api_key=${CG_API_KEY}` : "");

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Price API error: ${res.status} ${res.statusText}`);
    }

    const json: any = await res.json();
    const result: Record<string, number> = {};

    for (const [symbol, id] of Object.entries(SUPPORTED_ASSETS)) {
        const entry = json[id];
        if (entry && typeof entry.usd === "number") {
            result[symbol] = entry.usd;
        }
    }

    return result;
}

/**
 * Record a price snapshot at current time (unix seconds).
 * Used for "live" updates (e.g. hourly, or when new signals arrive).
 */
export async function recordCurrentPrices() {
    prepareStatements();

    const prices = await fetchCurrentPricesUSD();
    const nowSec = Math.floor(Date.now() / 1000);
    // Store on an hourly grid to avoid "random" timestamps (e.g. restarts) showing up
    // in downstream equity curves.
    const tsHour = Math.floor(nowSec / 3600) * 3600;

    const tx = db.transaction(() => {
        for (const [symbol, price] of Object.entries(prices)) {
            insertPriceStmt.run(symbol, tsHour, price);
        }
        setMetaStmt.run("last_price_ts", String(tsHour));
    });

    tx();
    console.log("[prices] recorded prices at", tsHour);
}

/**
 * Backfill historical prices between last_price_ts (or first signal) and now.
 *
 * For each asset:
 *  - call CoinGecko /market_chart/range ONCE
 *  - from the returned points:
 *      * build hourly bucket prices (canonical grid) into `prices`
 *      * fill prices at each signal timestamp using the NEAREST sample
 *
 * No interpolation, no 5-min grid stored.
 */
/**
 * Backfill historical prices between the last recorded price timestamp and `toSec`.
 *
 * - Inserts hourly prices on a canonical hourly grid.
 * - Inserts prices at each signal timestamp by snapping to the nearest sample
 *   returned by CoinGecko (no extra API calls).
 *
 * If you pass `toSecOverride`, the backfill stops exactly at that unix timestamp
 * (seconds). This is useful for hourly recomputation: set `toSecOverride` to the
 * current top-of-hour so your performance grid matches what you show in the UI.
 */
export async function backfillHistoricalPrices(toSecOverride?: number) {
    prepareStatements();

    const nowSec = Math.floor(Date.now() / 1000);

    // 1) find earliest relevant time from strategies
    const row = db
    .prepare(`SELECT MIN(first_signal_ts) AS min_ts FROM strategies`)
    .get() as { min_ts: number | null };

    if (!row || row.min_ts == null) {
        console.log("[backfill] No strategies yet, skipping historical backfill.");
        return;
    }

    const earliestSignalTs = row.min_ts;

    // We build segments on hourly boundaries. To correctly capture the hour that contains
    // the first signal (e.g. 16:50 -> hour 16:00), we must backfill starting at the
    // containing hour boundary, not the exact signal timestamp.
    const earliestHourTs = Math.floor(earliestSignalTs / 3600) * 3600;

    // 2) find last price timestamp we have recorded (if any)
    const lastPriceRaw = getMetaStmt.pluck().get("last_price_ts") as
    | string
    | undefined;
    let lastPriceTs = lastPriceRaw ? parseInt(lastPriceRaw, 10) : 0;

    if (!Number.isFinite(lastPriceTs) || lastPriceTs <= 0) {
        lastPriceTs = earliestHourTs;
    }

    // Continue from the last recorded price timestamp, but never later than the
    // earliest hour we need to support strategy starts.
    const fromSec = Math.max(earliestHourTs, lastPriceTs);
    const toSec =
        typeof toSecOverride === "number" && Number.isFinite(toSecOverride)
            ? Math.floor(toSecOverride)
            : nowSec;

    if (toSec <= fromSec) {
        console.log("[backfill] Nothing to backfill (from >= to).");
        return;
    }

    console.log(
        `[backfill] Fetching historical prices from ${fromSec} to ${toSec} (sec)`
    );

    // 3) for each asset, call CoinGecko's /market_chart/range ONCE
    // Also collect strategy creation timestamps in this backfill window.
    const startRows = getStrategyStartTimesInRangeStmt.all(fromSec, toSec) as { ts: number }[];
    const strategyStartTimes = startRows.map(r => r.ts);

    for (const [symbol, cgId] of Object.entries(SUPPORTED_ASSETS)) {
        try {
            const url =
            `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart/range` +
            `?vs_currency=usd&from=${Math.max(0, fromSec - 10 * 60)}&to=${toSec + 10 * 60}` +
            (CG_API_KEY ? `&x_cg_demo_api_key=${CG_API_KEY}` : "");

            const res = await fetch(url);
            if (!res.ok) {
                console.error(
                    `[backfill] Failed for ${symbol}: ${res.status} ${res.statusText}`
                );
                continue;
            }

            const json: any = await res.json();
            const prices: [number, number][] = json.prices || [];

            if (!prices.length) {
                console.log(`[backfill] No price data for ${symbol} in range.`);
                continue;
            }

            // Convert API points to seconds + keep sorted
            const points = prices
            .map(([ms, price]) => ({
                ts: Math.floor(ms / 1000),
                                   price,
            }))
            .sort((a, b) => a.ts - b.ts);

            // A) Build hourly prices on a canonical hourly grid.
//
// CoinGecko often returns samples on a ~5-minute grid, so we cannot rely on
// receiving a point exactly at each hour boundary. Instead, for each hour
// boundary, we pick a nearby sample (within tolerance) and store it at the
// exact boundary timestamp.
//
// This guarantees downstream performance is computed on a clean hourly grid
// and prevents the system from getting stuck retrying forever for an "exact"
// hour timestamp that will never arrive.
const hourlyMap = new Map<number, number>(); // tsHour -> price

const fromHour = Math.floor(fromSec / 3600) * 3600;
const toHour = Math.floor(toSec / 3600) * 3600;

for (let tsHour = fromHour; tsHour <= toHour; tsHour += 3600) {
    const px = pickHourlyPrice(points, tsHour, 10 * 60);
    if (px != null) {
        hourlyMap.set(tsHour, px);
    }
}

// Insert hourly canonical prices into DB
const txHourly = db.transaction(() => {
    for (const [tsHour, px] of hourlyMap.entries()) {
        // only store within the requested backfill window
        if (tsHour < fromSec || tsHour > toSec) continue;
        insertPriceStmt.run(symbol, tsHour, px);
    }
});
txHourly();

console.log(
    `[backfill] Filled ${hourlyMap.size} hourly prices for ${symbol} (snapped to hour boundaries).`
);



// B) Use SAME API data to fill signal-time prices (nearest sample)
//    We fill prices at:
//    - every signal timestamp for this asset, AND
//    - every strategy creation timestamp (first_signal_ts) in the window,
//      so benchmarks can be plotted reliably even when an asset wasn't traded by the strategy.
            const sigRows = getSignalTimesForAssetInRangeStmt.all(
                symbol,
                fromSec,
                toSec
            ) as { ts: number }[];

            const wantedTimes = Array.from(
                new Set<number>([
                    ...sigRows.map((r) => r.ts),
                    ...strategyStartTimes,
                ])
            ).sort((a, b) => a - b);

            if (wantedTimes.length === 0) {
                console.log(
                    `[backfill] No signal/strategy-start timestamps for ${symbol} in this range, skipping signal-time prices.`
                );
            } else {
                let k = 0;
                const n = points.length;

                const txSig = db.transaction(() => {
                    for (const tSig of wantedTimes) {
                        // advance k so that points[k].ts <= tSig < points[k+1].ts
                        while (k < n - 1 && points[k + 1].ts <= tSig) {
                            k++;
                        }

                        // Choose nearest sample around tSig (prefer last <= tSig)
                        let bestPrice: number | null = null;

                        if (n === 0) {
                            bestPrice = null;
                        } else if (k === n - 1) {
                            // tSig is beyond last sample: use last sample
                            bestPrice = points[n - 1].price;
                        } else {
                            const a = points[k];
                            const b = points[k + 1];

                            if (a.ts === tSig) {
                                bestPrice = a.price;
                            } else if (a.ts < tSig && tSig < b.ts) {
                                // prefer last <= tSig
                                bestPrice = a.price;
                            } else if (b.ts === tSig) {
                                bestPrice = b.price;
                            } else {
                                // fallback: choose whichever is closer
                                const da = Math.abs(tSig - a.ts);
                                const dbb = Math.abs(b.ts - tSig);
                                bestPrice = da <= dbb ? a.price : b.price;
                            }
                        }

                        if (bestPrice != null) {
                            insertPriceStmt.run(symbol, tSig, bestPrice);
                        }
                    }
                });

                txSig();
                console.log(
                    `[backfill] Filled ${wantedTimes.length} signal-time prices for ${symbol} (signals + strategy starts) using nearest API samples.`
                );
            }
        } catch (err) {
            console.error(`[backfill] Error fetching ${symbol}:`, err);
        }
    }

    // IMPORTANT:
    // We store the backfill boundary in meta, not the wall-clock "now".
    // This keeps hourly recomputation deterministic.
    // IMPORTANT:
    // Only advance meta.last_price_ts to what we actually have in the prices table.
    // This prevents "skipping" hours when an API call fails or when CoinGecko does
    // not provide a sample exactly at the requested boundary.
    const maxRow = db
        .prepare(`SELECT MAX(timestamp) AS m FROM prices`)
        .get() as { m: number | null };

    const maxTs = maxRow?.m ?? null;
    if (maxTs == null) {
        console.warn("[backfill] No prices in DB; leaving last_price_ts unchanged.");
        console.log("[backfill] Done.");
        return;
    }

    const actualLast = Math.min(Number(maxTs), Number(toSec));

    const prevRaw = getMetaStmt.pluck().get("last_price_ts") as string | undefined;
    const prev = prevRaw ? parseInt(prevRaw, 10) : 0;

    if (Number.isFinite(actualLast) && actualLast > prev) {
        setMetaStmt.run("last_price_ts", String(actualLast));
        console.log("[backfill] Advanced last_price_ts to", actualLast);
    } else {
        console.log("[backfill] last_price_ts unchanged at", prev, "(actualLast =", actualLast, ")");
    }

    console.log("[backfill] Done.");
}
