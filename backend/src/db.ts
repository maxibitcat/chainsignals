import Database from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config();

const dbPath = process.env.DATABASE_PATH || "./data/chainsignals.sqlite";

export const db = new Database(dbPath);

export function initDb() {
    db.exec("PRAGMA foreign_keys = ON;");

    // meta table for misc state
    db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    `);

    // on-chain signals
    db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
        id                  INTEGER PRIMARY KEY, -- on-chain index
        tx_hash             TEXT NOT NULL,
        trader_address      TEXT NOT NULL,
        strategy_name       TEXT NOT NULL,       -- <=10 chars
        asset_symbol        TEXT NOT NULL,       -- <=5 chars, uppercase
        direction           INTEGER NOT NULL,    -- 0=Long,1=Short (contract enum)
        leverage            INTEGER NOT NULL,    -- 1–5
        weight_raw          INTEGER NOT NULL,    -- user-defined integer (interpreted as target % 0..100, capped)
        timestamp           INTEGER NOT NULL     -- unix seconds (block timestamp)
    );
    `);

    // strategies, aggregated per (trader, strategy_name)
    db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        trader_address        TEXT NOT NULL,
        strategy_name         TEXT NOT NULL,

        first_signal_ts       INTEGER NOT NULL,
        last_signal_ts        INTEGER NOT NULL,
        num_signals           INTEGER NOT NULL DEFAULT 0,

        -- P&L tracking
        last_value_index      REAL    NOT NULL DEFAULT 1.0,  -- latest equity value
        last_segment_end_ts   INTEGER,                       -- end_ts of last segment

        is_liquidated         INTEGER NOT NULL DEFAULT 0,    -- reserved for future

        UNIQUE(trader_address, strategy_name)
    );
    `);

    // price time series (hourly + signal timestamps)
    db.exec(`
    CREATE TABLE IF NOT EXISTS prices (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_symbol  TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,       -- unix seconds
        price_usd     REAL NOT NULL,
        UNIQUE(asset_symbol, timestamp)
    );
    `);

    // segments = intervals between consecutive price timestamps, per strategy
    // exposures are constant over each segment
    db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_segments (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id       INTEGER NOT NULL,
        start_ts          INTEGER NOT NULL,
        end_ts            INTEGER NOT NULL,
        duration_sec      INTEGER NOT NULL,
        raw_return        REAL NOT NULL,      -- actual interval return
        hourly_equiv_ret  REAL NOT NULL,      -- scaled to per-hour for Sharpe denom
        value_index_end   REAL NOT NULL,      -- equity at end of segment

        FOREIGN KEY(strategy_id) REFERENCES strategies(id) ON DELETE CASCADE,
                                                  UNIQUE(strategy_id, start_ts, end_ts)
    );
    `);

    // Persist current portfolio holdings per strategy at last_segment_end_ts.
    // This is required to extend equity without implicitly rebalancing every bar.
    // Values are in "equity units" (sum across assets = last_value_index).
    db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_holdings (
        strategy_id    INTEGER NOT NULL,
        asset_symbol   TEXT    NOT NULL,
        value          REAL    NOT NULL,
        direction      INTEGER NOT NULL,  -- -1 short, +1 long, 0 cash
        leverage       INTEGER NOT NULL,  -- 1..5 (ignored for USD)
        is_usd         INTEGER NOT NULL,  -- 1 if USD/cash

        FOREIGN KEY(strategy_id) REFERENCES strategies(id) ON DELETE CASCADE,
        UNIQUE(strategy_id, asset_symbol)
    );
    `);

    
    // Persist portfolio snapshots at each signal timestamp, so the API can return positionsHistory
    // without replaying all signals/prices on every request.
    // positions_json is a JSON array of { asset, percent, direction, leverage } objects.
    db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_position_snapshots (
        strategy_id     INTEGER NOT NULL,
        signal_ts       INTEGER NOT NULL,
        positions_json  TEXT    NOT NULL,

        FOREIGN KEY(strategy_id) REFERENCES strategies(id) ON DELETE CASCADE,
        UNIQUE(strategy_id, signal_ts)
    );
    `);

    // precomputed stats per strategy, per time window
    db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_stats (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id     INTEGER NOT NULL,
        window          TEXT    NOT NULL,    -- '1W','1M','3M','6M','1Y','ALL'

    last_updated_ts INTEGER NOT NULL,

    sharpe_annual   REAL,
    vol_annual      REAL,
    vol_hourly      REAL,
    total_return    REAL,
    max_drawdown    REAL,

    FOREIGN KEY(strategy_id) REFERENCES strategies(id) ON DELETE CASCADE,
                                               UNIQUE(strategy_id, window)
    );
    `);

    const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
    const setMeta = db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
    );

    if (!getMeta.pluck().get("last_signal_id_synced")) {
        setMeta.run("last_signal_id_synced", "-1");
    }
    if (!getMeta.pluck().get("last_price_ts")) {
        setMeta.run("last_price_ts", "0");
    }

    // --- schema migrations (idempotent) ---
    // Add new optional message field for signals / snapshots if not present.
    try { db.exec("ALTER TABLE signals ADD COLUMN message TEXT"); } catch {}
    try { db.exec("ALTER TABLE strategy_position_snapshots ADD COLUMN message TEXT"); } catch {}

}
