import axios from "axios";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export type LeaderboardRow = {
    id: number;
    trader: string;
    strategyName: string;
    firstSignalTs: number;
    lastSignalTs: number;
    numSignals: number;
    lastSegmentEndTs?: number | null;
    sharpeAnnual: number | null;
    volAnnual: number | null;
    totalReturn: number | null;
    maxDrawdown: number | null;
};

export async function fetchLeaderboard(window: string): Promise<LeaderboardRow[]> {
    const res = await axios.get(`${API_BASE}/api/leaderboard`, {
        params: { window },
    });
    return res.data;
}

export type StrategyPosition = {
    asset: string;
    direction: "LONG" | "SHORT" | "CASH";
    leverage: number;
    percent: number; // 0..100 (target allocation at that snapshot time)
};

export type StrategyPositionsSnapshot = {
    timestamp: number;
    positions: StrategyPosition[];
    message?: string | null;
};

export type StrategyDetails = {
    id: number;
    trader: string;
    strategyName: string;
    firstSignalTs: number;
    lastSignalTs: number;
    numSignals: number;
    isLiquidated: boolean;
    lastValueIndex: number;
    lastSegmentEndTs: number | null;
    stats: Record<
    string,
    {
        lastUpdatedTs: number;
        sharpeAnnual: number | null;
        volAnnual: number | null;
        volHourly: number | null;
        totalReturn: number | null;
        maxDrawdown: number | null;
    }
    >;
    positionsHistory: StrategyPositionsSnapshot[];
};

export async function fetchStrategy(id: number): Promise<StrategyDetails> {
    const res = await axios.get(`${API_BASE}/api/strategy/${id}`);
    return res.data;
}

export type EquityPoint = {
    timestamp: number;
    valueIndex: number;
    valueIndexRebased: number;
};

export type BenchmarkPoint = {
    timestamp: number;
    price: number;
    priceRebased: number;
};

export type StrategyEquityResponse = {
    id: number;
    trader: string;
    strategyName: string;
    firstSignalTs: number;
    lastSignalTs: number;
    lastValueIndex: number;
    window: string;
    sampling: "hourly" | "daily" | null;
    points: EquityPoint[];
    benchmark: {
        symbol: string;
        points: BenchmarkPoint[];
    } | null;
};

export async function fetchStrategyEquity(
    id: number,
    window: string,
    benchmark?: string
): Promise<StrategyEquityResponse> {
    const res = await axios.get(`${API_BASE}/api/strategy/${id}/equity`, {
        params: { window, benchmark },
    });
    return res.data;
}

export type TraderStrategiesResponse = {
    trader: string;
    strategies: {
        id: number;
        trader: string;
        strategyName: string;
        firstSignalTs: number;
        lastSignalTs: number;
        numSignals: number;
        isLiquidated: boolean;
        lastValueIndex: number;
        lastSegmentEndTs: number | null;
        stats: StrategyDetails["stats"];
    }[];
};

export async function fetchTraderStrategies(
    address: string
): Promise<TraderStrategiesResponse> {
    const res = await axios.get(`${API_BASE}/api/trader/${address}`);
    return res.data;
}
