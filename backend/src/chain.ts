// src/chain.ts
import { createPublicClient, defineChain, http } from "viem";
import "dotenv/config";

const CHAIN_ID_RAW = process.env.CHAIN_ID;
const CHAIN_NAME = process.env.CHAIN_NAME || "CustomChain";
const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL || "";
const CHAIN_SIGNALS_ADDRESS = process.env.CHAIN_SIGNALS_ADDRESS || "";

const CHAIN_ID = CHAIN_ID_RAW ? Number(CHAIN_ID_RAW) : 0;

if (!CHAIN_ID || !CHAIN_RPC_URL || !CHAIN_SIGNALS_ADDRESS) {
    throw new Error(
        "Missing chain configuration. Please set CHAIN_ID, CHAIN_RPC_URL and CHAIN_SIGNALS_ADDRESS in your .env"
    );
}

export const activeChain = defineChain({
    id: CHAIN_ID,
    name: CHAIN_NAME,
    nativeCurrency: {
        name: "Native",
        symbol: "NAT",
        decimals: 18,
    },
    rpcUrls: {
        default: {
            http: [CHAIN_RPC_URL],
        },
    },
});

export const chainSignalsAddress = CHAIN_SIGNALS_ADDRESS as `0x${string}`;

export const publicClient = createPublicClient({
    chain: activeChain,
    transport: http(CHAIN_RPC_URL),
});

// Backwards compatibility: if other files import { client } it will still work
export const client = publicClient;

// ABI for ChainSignals contract
export const chainSignalsAbi = [
    {
        type: "event",
        name: "SignalPosted",
        inputs: [
            { name: "id", type: "uint256", indexed: true },
            { name: "trader", type: "address", indexed: true },
            { name: "strategy", type: "string", indexed: false },
            { name: "asset", type: "string", indexed: false },
            { name: "message", type: "string", indexed: false },
            { name: "target", type: "uint8", indexed: false },
            { name: "leverage", type: "uint8", indexed: false },
            { name: "weight", type: "uint16", indexed: false },
            { name: "timestamp", type: "uint64", indexed: false },
        ],
    },
{
    type: "function",
    stateMutability: "view",
    name: "getSignalsCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
},
{
    type: "function",
    stateMutability: "view",
    name: "getSignalsRange",
    inputs: [
        { name: "from", type: "uint256" },
        { name: "to", type: "uint256" },
    ],
    outputs: [
        {
            name: "",
            type: "tuple[]",
            components: [
                { name: "trader", type: "address" },
                { name: "strategy", type: "string" },
                { name: "asset", type: "string" },
                { name: "message", type: "string" },
                { name: "target", type: "uint8" },
                { name: "leverage", type: "uint8" },
                { name: "weight", type: "uint16" },
                { name: "timestamp", type: "uint64" },
            ],
        },
    ],
},
] as const;
