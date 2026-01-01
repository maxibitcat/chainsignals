import { db } from "./db";
import { client, chainSignalsAbi, chainSignalsAddress } from "./chain";

let prepared = false;

let getMetaStmt: any;
let setMetaStmt: any;
let insertSignalStmt: any;
let upsertStrategyStmt: any;
let getStrategyRowStmt: any;
let getLatestSnapshotStmt: any;
let getHoldingsStmt: any;
let upsertSnapshotStmt: any;

function prepareStatements() {
    if (prepared) return;
    prepared = true;

    getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
    setMetaStmt = db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
    );

    insertSignalStmt = db.prepare(`
    INSERT OR IGNORE INTO signals (
        id, tx_hash, trader_address, strategy_name, asset_symbol,
        direction, leverage, weight_raw, message, timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // first_signal_ts stays as first; last_signal_ts updated; num_signals++
    upsertStrategyStmt = db.prepare(`
    INSERT INTO strategies (
        trader_address, strategy_name,
        first_signal_ts, last_signal_ts, num_signals
    )
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(trader_address, strategy_name) DO UPDATE SET
    last_signal_ts = excluded.last_signal_ts,
    num_signals    = strategies.num_signals + 1
    `);


    getStrategyRowStmt = db.prepare(`
        SELECT id, last_segment_end_ts
        FROM strategies
        WHERE trader_address = ? AND strategy_name = ?
    `);

    getLatestSnapshotStmt = db.prepare(`
        SELECT signal_ts, positions_json
        FROM strategy_position_snapshots
        WHERE strategy_id = ?
        ORDER BY signal_ts DESC
        LIMIT 1
    `);

    getHoldingsStmt = db.prepare(`
        SELECT asset_symbol, value, direction, leverage, is_usd
        FROM strategy_holdings
        WHERE strategy_id = ?
    `);

    upsertSnapshotStmt = db.prepare(`
        INSERT INTO strategy_position_snapshots (strategy_id, signal_ts, positions_json, message)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(strategy_id, signal_ts) DO UPDATE SET
          positions_json = excluded.positions_json
    `);
}

type SnapPos = { asset: string; percent: number; direction: "LONG" | "SHORT" | "CASH"; leverage: number };

function clampPctRaw(w: number): number {
    if (!Number.isFinite(w)) return 0;
    const x = Math.max(0, Math.min(100, Math.floor(w)));
    return x / 100;
}

function computeApproxSnapshot(
    basePositions: SnapPos[],
    signal: { asset: string; direction: number; leverage: number; weightRaw: number }
): SnapPos[] {
    const asset = String(signal.asset || "").toUpperCase();
    const targetPct = clampPctRaw(signal.weightRaw);

    const totalPct = basePositions.reduce((a, p) => a + (Number(p.percent) || 0), 0);
    const onlyUsd =
        basePositions.length === 0 ||
        basePositions.every((p) => String(p.asset).toUpperCase() === "USD" || (Number(p.percent) || 0) <= 0);

    if (totalPct <= 0 || onlyUsd) {
        return [
            {
                asset,
                percent: 100,
                direction: asset === "USD" ? "CASH" : signal.direction === 1 ? "SHORT" : "LONG",
                leverage: asset === "USD" ? 1 : Math.max(1, Math.min(5, Math.floor(Number(signal.leverage) || 1))),
            },
        ];
    }

    const base: Record<string, SnapPos> = {};
    for (const p of basePositions) {
        const a = String(p.asset).toUpperCase();
        const pct = Math.max(0, Number(p.percent) || 0);
        if (!a || pct <= 0) continue;
        base[a] = { asset: a, percent: pct, direction: p.direction, leverage: Number(p.leverage) || 1 };
    }

    const current = base[asset]?.percent ?? 0;
    const otherTotal = 100 - current;

    const desired = targetPct * 100;
    const desiredOtherTotal = 100 - desired;

    if (otherTotal > 0) {
        const k = desiredOtherTotal / otherTotal;
        for (const a of Object.keys(base)) {
            if (a === asset) continue;
            base[a].percent *= k;
        }
    } else if (desiredOtherTotal > 0) {
        base["USD"] = { asset: "USD", percent: desiredOtherTotal, direction: "CASH", leverage: 1 };
    }

    if (desired <= 0) {
        delete base[asset];
    } else {
        base[asset] = {
            asset,
            percent: desired,
            direction: asset === "USD" ? "CASH" : signal.direction === 1 ? "SHORT" : "LONG",
            leverage: asset === "USD" ? 1 : Math.max(1, Math.min(5, Math.floor(Number(signal.leverage) || 1))),
        };
    }

    const sum = Object.values(base).reduce((a, p) => a + p.percent, 0);
    if (sum > 0) {
        const k = 100 / sum;
        for (const p of Object.values(base)) p.percent *= k;
    }

    return Object.values(base)
        .filter((p) => p.percent > 0)
        .map((p) => ({ ...p, percent: Math.round(p.percent * 1e6) / 1e6 }))
        .sort((a, b) => b.percent - a.percent);
}

function parsePositionsJson(raw: any): SnapPos[] {
    try {
        const arr = JSON.parse(String(raw || "[]"));
        if (!Array.isArray(arr)) return [];
        return arr
            .map((p: any) => ({
                asset: String(p.asset || "").toUpperCase(),
                percent: Number(p.percent) || 0,
                direction: (p.direction as any) || "LONG",
                leverage: Number(p.leverage) || 1,
            }))
            .filter((p) => p.asset && p.percent > 0);
    } catch {
        return [];
    }
}



/**
 * Sync missing signals. Returns true if any new signal was added.
 */
export async function syncSignals(): Promise<boolean> {
    prepareStatements();

    const lastSyncedRaw = getMetaStmt.pluck().get("last_signal_id_synced");
    let lastSynced = lastSyncedRaw ? parseInt(lastSyncedRaw, 10) : -1;

    const totalCount = (await client.readContract({
        address: chainSignalsAddress,
        abi: chainSignalsAbi,
        functionName: "getSignalsCount",
    })) as bigint;

    const total = Number(totalCount);
    if (total === 0 || lastSynced >= total - 1) {
        //console.log("[syncSignals] up to date:", { total, lastSynced });
        return false;
    }

    console.log(
        `[syncSignals] syncing from id ${lastSynced + 1} to ${total - 1} (total ${total})`
    );

    const batchSize = 200;
    let hasNew = false;

    for (let from = lastSynced + 1; from < total; from += batchSize) {
        const to = Math.min(from + batchSize, total);

        const signals = (await client.readContract({
            address: chainSignalsAddress,
            abi: chainSignalsAbi,
            functionName: "getSignalsRange",
            args: [BigInt(from), BigInt(to)],
        })) as any[];

        const insertTx = db.transaction((chunk: any[], offset: number) => {
            for (let i = 0; i < chunk.length; i++) {
                const idx = offset + i;
                const s = chunk[i];

                const id = idx;
                const trader = (s.trader as string).toLowerCase();
                const strategy = s.strategy as string;
                const asset = s.asset as string;
                const message = (s.message as string) ?? "";
                // Contract enum is Long=0, Short=1 (no Flat).
                // If a contract/client ever emits 2, treat it as Short for robustness.
                const targetRaw = Number(s.target);
                const direction = targetRaw === 1 ? 1 : targetRaw === 2 ? 1 : 0;
                const leverage = Number(s.leverage);
                const weight = Number(s.weight);
                const ts = Number(s.timestamp);
                const txHash = ""; // can be filled later via logs if needed

                insertSignalStmt.run(
                    id,
                    txHash,
                    trader,
                    strategy,
                    asset,
                    direction,
                    leverage,
                    weight,
                    message,
                    ts
                );

                upsertStrategyStmt.run(trader, strategy, ts, ts);


                // Write an approximate snapshot at the signal timestamp so the UI can display positions immediately.
                // This does NOT fetch prices and is later overwritten by the hourly segment engine with accurate snapshots.
                const stratRow = getStrategyRowStmt.get(trader, strategy) as
                    | { id: number; last_segment_end_ts: number | null }
                    | undefined;
                if (stratRow && Number.isFinite(stratRow.id)) {
                    const strategyId = Number(stratRow.id);
                    const holdingsTs = stratRow.last_segment_end_ts ? Number(stratRow.last_segment_end_ts) : 0;

                    const snapRow = getLatestSnapshotStmt.get(strategyId) as
                        | { signal_ts: number; positions_json: string }
                        | undefined;
                    const snapTs = snapRow ? Number(snapRow.signal_ts) : 0;

                    let basePositions: SnapPos[] = [];
                    if (holdingsTs && holdingsTs >= snapTs) {
                        const hRows = getHoldingsStmt.all(strategyId) as {
                            asset_symbol: string;
                            value: number;
                            direction: number;
                            leverage: number;
                            is_usd: number;
                        }[];
                        const total = hRows.reduce((a, r) => a + (Number(r.value) || 0), 0);
                        if (total > 0) {
                            basePositions = hRows
                                .filter((r) => (Number(r.value) || 0) > 0)
                                .map((r) => {
                                    const sym = r.is_usd ? "USD" : String(r.asset_symbol || "").toUpperCase();
                                    const dir =
                                        r.is_usd || r.direction === 0
                                            ? "CASH"
                                            : r.direction === -1
                                            ? "SHORT"
                                            : "LONG";
                                    return {
                                        asset: sym,
                                        percent: ((Number(r.value) || 0) / total) * 100,
                                        direction: dir as any,
                                        leverage: r.is_usd ? 1 : Number(r.leverage) || 1,
                                    };
                                });
                        }
                    } else if (snapRow) {
                        basePositions = parsePositionsJson(snapRow.positions_json);
                    } else {
                        basePositions = [{ asset: "USD", percent: 100, direction: "CASH", leverage: 1 }];
                    }

                    const nextPositions = computeApproxSnapshot(basePositions, {
                        asset,
                        direction,
                        leverage,
                        weightRaw: weight,
                    });

                    upsertSnapshotStmt.run(strategyId, ts, JSON.stringify(nextPositions), message);
                }
            }
        });

        insertTx(signals, from);

        lastSynced = to - 1;
        hasNew = true;
        setMetaStmt.run("last_signal_id_synced", String(lastSynced));

        console.log(
            `[syncSignals] synced signals ${from}..${to - 1}, lastSynced=${lastSynced}`
        );
    }

    console.log("[syncSignals] done");
    return hasNew;
}
