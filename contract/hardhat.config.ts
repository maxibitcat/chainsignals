import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import dotenv from "dotenv";

dotenv.config();

const deployerPk = process.env.DEPLOYER_PK ?? "";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],

  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },

  networks: {
    // Kasplex
    kasplexMainnet: {
      type: "http",
      url: process.env.KASPLEX_MAINNET_RPC!,      // no hardcoded fallback
      chainId: Number(process.env.KASPLEX_MAINNET_CHAIN_ID ?? "202555"),
                            accounts: deployerPk ? [deployerPk] : [],
    },
    kasplexTestnet: {
      type: "http",
      url: process.env.KASPLEX_TESTNET_RPC!,
      chainId: Number(process.env.KASPLEX_TESTNET_CHAIN_ID ?? "202556"), // example
                            accounts: deployerPk ? [deployerPk] : [],
    },

    // Igra
    igraTestnet: {
      type: "http",
      url: process.env.IGRA_TESTNET_RPC!,
      chainId: Number(process.env.IGRA_TESTNET_CHAIN_ID!), // fill with the correct ID
                            accounts: deployerPk ? [deployerPk] : [],
    },
  },
});
