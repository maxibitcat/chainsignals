import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, Contract, formatEther } from "ethers";
import detectEthereumProvider from "@metamask/detect-provider";

declare global {
  interface Window {
    ethereum?: any;
    kasware?: any;

    // EIP-6963 (Multi Injected Provider Discovery)
    addEventListener: any;
    removeEventListener: any;
  }
}

/**
 * EIP-6963 types (minimal).
 * Wallets can announce themselves without relying on window.ethereum being "the one true provider".
 */
type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};
type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: any;
};
type Eip6963AnnounceEvent = CustomEvent<Eip6963ProviderDetail>;

/**
 * Prefer MetaMask via EIP-6963 if available. Fallback to detect-provider.
 * This reduces interference from wallet routers that hijack window.ethereum.
 */
function isMetaMaskInfo(info?: Partial<Eip6963ProviderInfo> | null): boolean {
  if (!info) return false;
  const hay = `${info.name ?? ""} ${info.rdns ?? ""}`.toLowerCase();
  // MetaMask rdns is commonly "io.metamask" (and forks may differ), so match both name + rdns.
  return hay.includes("metamask") || hay.includes("io.metamask");
}

async function getMetaMaskProvider(timeoutMs = 2000, eip6963Providers?: Eip6963ProviderDetail[]): Promise<any | null> {
  // 1) Try EIP-6963 registry first (if we have it)
  if (eip6963Providers?.length) {
    const mm = eip6963Providers.find((p) => isMetaMaskInfo(p.info))?.provider;
    if (mm) return mm;
  }

  // 2) Fallback to MetaMask's detect-provider (mustBeMetaMask filters most routers)
  try {
    const p = await detectEthereumProvider({ mustBeMetaMask: true, timeout: timeoutMs });
    return p ?? null;
  } catch {
    return null;
  }
}


// ---------- Mobile helpers ----------
// On mobile external browsers (Safari/Chrome), there is no injected provider.
// Best UX: deep-link into MetaMask Mobile's in-app browser, where injection works normally.
function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

function isMetaMaskInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  // MetaMask Mobile in-app browser user agent typically includes "MetaMaskMobile"
  return ua.includes("metamaskmobile") || (ua.includes("metamask") && !!(window as any)?.ethereum?.isMetaMask);
}

function buildMetaMaskDappDeepLink(): string {
  // MetaMask deep link expects host + path (no protocol)
  const { host, pathname, search, hash } = window.location;
  const target = `${host}${pathname}${search}${hash}`;
  return `https://metamask.app.link/dapp/${target}`;
}

/** Promise.race timeout wrapper for provider.request */
function requestWithTimeout<T>(p: any, args: any, timeoutMs: number): Promise<T> {
  if (!p?.request) {
    return Promise.reject(new Error("request() not available"));
  }
  return Promise.race([
    p.request(args) as Promise<T>,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}

function decChainIdToHex(dec: number): string {
  return "0x" + dec.toString(16);
}

const CHAIN_ID_DEC = Number(import.meta.env.VITE_CHAIN_ID);
const CHAIN_ID_HEX = decChainIdToHex(CHAIN_ID_DEC);

const CHAIN_NAME = String(import.meta.env.VITE_CHAIN_NAME);
const CHAIN_RPC_URL = String(import.meta.env.VITE_CHAIN_RPC_URL);
const CHAIN_SYMBOL = String(import.meta.env.VITE_CHAIN_SYMBOL);
const CHAIN_EXPLORER_URL = String(import.meta.env.VITE_CHAIN_EXPLORER_URL);

export const CHAIN_SIGNALS_ADDRESS = String(import.meta.env.VITE_CHAIN_SIGNALS_ADDRESS);

const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: CHAIN_NAME,
  rpcUrls: [CHAIN_RPC_URL],
  nativeCurrency: { name: CHAIN_SYMBOL, symbol: CHAIN_SYMBOL, decimals: 18 },
  blockExplorerUrls: [CHAIN_EXPLORER_URL],
};

const CHAIN_SIGNALS_ABI = [
  {
    inputs: [
      { internalType: "string", name: "strategy", type: "string" },
      { internalType: "string", name: "asset", type: "string" },
      { internalType: "string", name: "message", type: "string" },
      { internalType: "uint8", name: "target", type: "uint8" },
      { internalType: "uint8", name: "leverage", type: "uint8" },
      { internalType: "uint16", name: "weight", type: "uint16" },
    ],
    name: "postSignal",
    outputs: [{ internalType: "uint256", name: "id", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

type WalletContextType = {
  address: string | null;
  chainId: string | null; // decimal string
  isCorrectNetwork: boolean;
  provider: BrowserProvider | null;
  balanceNative: string | null;
  nativeSymbol: string;

  refreshBalance: () => Promise<void>;
  connect: () => Promise<void>;
  getChainSignalsContract: () => Promise<Contract | null>;
};

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [balanceNative, setBalanceNative] = useState<string | null>(null);

  // EIP-6963 discovered providers (stable references even if window.ethereum is hijacked/swapped)
  const eip6963ProvidersRef = useRef<Eip6963ProviderDetail[]>([]);

  // Track current underlying provider we are bound to (so we can re-bind if routers swap)
  const boundProviderRef = useRef<any | null>(null);

  // Keep listener functions so we can detach when provider object changes
  const chainChangedHandlerRef = useRef<(() => void) | null>(null);
  const accountsChangedHandlerRef = useRef<((accs: string[]) => void) | null>(null);

  const isCorrectNetwork = useMemo(() => {
    if (!chainId) return false;
    const cid = Number(chainId);
    return Number.isFinite(cid) && cid === CHAIN_ID_DEC;
  }, [chainId]);

  const refreshBalanceInternal = async (prov: BrowserProvider, addr: string) => {
    try {
      const bal = await prov.getBalance(addr);
      const n = Number(formatEther(bal));
      setBalanceNative(Number.isFinite(n) ? n.toFixed(4) : null);
    } catch (e) {
      console.error("[wallet] Failed to fetch balance", e);
      setBalanceNative(null);
    }
  };

  const refreshBalance = async () => {
    if (!provider || !address) return;
    await refreshBalanceInternal(provider, address);
  };

  const detachListeners = (p: any) => {
    try {
      if (p?.removeListener && chainChangedHandlerRef.current) {
        p.removeListener("chainChanged", chainChangedHandlerRef.current);
      }
      if (p?.removeListener && accountsChangedHandlerRef.current) {
        p.removeListener("accountsChanged", accountsChangedHandlerRef.current);
      }
    } catch {
      // ignore
    } finally {
      chainChangedHandlerRef.current = null;
      accountsChangedHandlerRef.current = null;
    }
  };

  const attachListeners = async (p: any) => {
    // If provider object changed, detach old listeners and attach new ones.
    if (boundProviderRef.current && boundProviderRef.current !== p) {
      detachListeners(boundProviderRef.current);
    }
    boundProviderRef.current = p;

    if (!p?.on) return;

    // Define handlers once (but re-attach to new provider if swapped)
    const onChainChanged = async () => {
      try {
        const prov2 = new BrowserProvider(p);
        setProvider(prov2);

        // chainId (fast)
        try {
          const cidHex = await requestWithTimeout<string>(p, { method: "eth_chainId" }, 8000);
          setChainId(parseInt(cidHex, 16).toString());
        } catch {}

        // accounts
        try {
          const accs = await requestWithTimeout<string[]>(p, { method: "eth_accounts" }, 8000);
          const a2 = accs?.[0] ?? null;
          setAddress(a2);
          if (a2) await refreshBalanceInternal(prov2, a2);
          else setBalanceNative(null);
        } catch {}
      } catch (e) {
        console.error("[wallet] chainChanged handler error", e);
      }
    };

    const onAccountsChanged = async (accs: string[]) => {
      try {
        const a2 = accs?.[0] ?? null;
        setAddress(a2);
        if (!a2) {
          setBalanceNative(null);
          return;
        }
        const prov2 = new BrowserProvider(p);
        setProvider(prov2);

        try {
          const cidHex = await requestWithTimeout<string>(p, { method: "eth_chainId" }, 8000);
          setChainId(parseInt(cidHex, 16).toString());
        } catch {}

        await refreshBalanceInternal(prov2, a2);
      } catch (e) {
        console.error("[wallet] accountsChanged handler error", e);
      }
    };

    // Detach any old handlers (if any), then attach
    detachListeners(p);
    chainChangedHandlerRef.current = onChainChanged;
    accountsChangedHandlerRef.current = onAccountsChanged;

    p.on("chainChanged", onChainChanged);
    p.on("accountsChanged", onAccountsChanged);
  };

  const ensureCorrectChain = async (p: any) => {
    const currentHex = await requestWithTimeout<string>(p, { method: "eth_chainId" }, 12000);
    if (String(currentHex).toLowerCase() === String(CHAIN_ID_HEX).toLowerCase()) return;

    try {
      await requestWithTimeout(p, { method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }, 20000);
    } catch (e: any) {
      // 4902 = unknown chain
      if (e?.code === 4902) {
        await requestWithTimeout(p, { method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }, 25000);
        await requestWithTimeout(p, { method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }, 20000);
      } else {
        throw e;
      }
    }
  };

  const rebindFromProvider = async (p: any, opts?: { prompt?: boolean }) => {
    if (!p) return;

    // If provider swapped underneath us, rebuild ethers provider, listeners, and state.
    await attachListeners(p);

    const prov = new BrowserProvider(p);
    setProvider(prov);

    // Read chain id
    try {
      const cidHex = await requestWithTimeout<string>(p, { method: "eth_chainId" }, 12000);
      setChainId(parseInt(cidHex, 16).toString());
    } catch {}

    // Accounts: prompt or not depending on flow
    let accs: string[] = [];
    try {
      accs = await requestWithTimeout<string[]>(
        p,
        { method: opts?.prompt ? "eth_requestAccounts" : "eth_accounts" },
        opts?.prompt ? 30000 : 10000
      );
    } catch (e: any) {
      if (opts?.prompt && e?.code === 4001) return; // user rejected
      // If we're not prompting and it fails, just treat as disconnected.
      accs = [];
    }

    const a = accs?.[0] ?? null;
    setAddress(a);

    if (a) await refreshBalanceInternal(prov, a);
    else setBalanceNative(null);
  };

  /**
   * When wallet routers (Kasware) show a "choose provider" UI, they often swap the injected provider
   * after the user picks MetaMask. If we already bound to the old object, the dapp won't update until refresh.
   *
   * This watcher detects that swap and re-binds automatically (no reload).
   */
  const watchForProviderSwap = async (ms = 15000) => {
    const started = Date.now();
    let lastEth = window.ethereum;

    while (Date.now() - started < ms) {
      // If the provider object reference changes, re-init state.
      if (window.ethereum && window.ethereum !== lastEth) {
        lastEth = window.ethereum;

        const mm = await getMetaMaskProvider(2000, eip6963ProvidersRef.current);
        if (mm) {
          await rebindFromProvider(mm, { prompt: false });
          // If we already have an address, we're good.
          if (address) return;
        }
      }

      // Even if reference doesn't change, some routers keep the same object but start returning accounts
      // after the user chooses MetaMask. So probe eth_accounts.
      const mm2 = await getMetaMaskProvider(2000, eip6963ProvidersRef.current);
      if (mm2) {
        try {
          const accs = await requestWithTimeout<string[]>(mm2, { method: "eth_accounts" }, 4000);
          if (accs?.[0]) {
            await rebindFromProvider(mm2, { prompt: false });
            return;
          }
        } catch {
          // ignore
        }
      }

      await new Promise((r) => setTimeout(r, 350));
    }
  };

  const connect = async () => {
    // Mobile external browsers (Safari/Chrome) don't have injected providers.
    // Deep-link into MetaMask Mobile's in-app browser so the rest of the (desktop) logic stays unchanged.
    if (typeof window !== "undefined" && isMobileBrowser() && !isMetaMaskInAppBrowser()) {
      window.location.href = buildMetaMaskDappDeepLink();
      return;
    }

    const mm = await getMetaMaskProvider(2000, eip6963ProvidersRef.current);

    if (!mm) {
      alert(
        "MetaMask wasn't found as an injected provider. If you have a wallet router (e.g. Kasware) enabled, set MetaMask as the default injected wallet in that extension (if supported), or temporarily disable it, then reload."
      );
      return;
    }

    // 1) Prompt connection (this should wake the correct wallet)
    try {
      await rebindFromProvider(mm, { prompt: true });
    } catch (e: any) {
      if (e?.code === 4001) return; // user rejected
      console.error("[wallet] connect failed", e);
      alert("Could not connect. Please open MetaMask once, unlock it, and try again.");
      return;
    }

    // 2) Best-effort ensure chain (don't hard fail)
    try {
      await ensureCorrectChain(mm);
      // After switching, refresh chainId/balance
      await rebindFromProvider(mm, { prompt: false });
    } catch (e: any) {
      console.warn("[wallet] network not switched/added", e);
    }

    // 3) Critical: if a router just swapped providers (Kasware selection UI), automatically re-bind.
    // This avoids requiring a page refresh to see balance.
    await watchForProviderSwap(15000);
  };

  const getChainSignalsContract = async (): Promise<Contract | null> => {
    // Ensure we have a provider + address; if not, try to connect.
    if (!provider || !address) {
      await connect();
    }
    const mm = await getMetaMaskProvider(2000, eip6963ProvidersRef.current);
    if (!mm) return null;

    const prov = provider ?? new BrowserProvider(mm);
    const signer = await prov.getSigner();
    return new Contract(CHAIN_SIGNALS_ADDRESS, CHAIN_SIGNALS_ABI, signer);
  };

  // EIP-6963: discover wallets (MetaMask included) via announce events.
  useEffect(() => {
    const onAnnounce = (event: Eip6963AnnounceEvent) => {
      const detail = event.detail;
      if (!detail?.info?.uuid || !detail?.provider) return;

      // de-dupe by uuid
      const arr = eip6963ProvidersRef.current;
      if (arr.some((x) => x.info.uuid === detail.info.uuid)) return;
      eip6963ProvidersRef.current = [...arr, detail];
    };

    // Listen first, then request announcements
    window.addEventListener?.("eip6963:announceProvider", onAnnounce as any);
    window.dispatchEvent?.(new Event("eip6963:requestProvider"));

    return () => {
      window.removeEventListener?.("eip6963:announceProvider", onAnnounce as any);
    };
  }, []);

  // Auto-detect existing connection (no prompts). Retries because wallets can be slow right after install/toggle.
  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const tryInit = async () => {
      const mm = await getMetaMaskProvider(2000, eip6963ProvidersRef.current);
      if (!mm || cancelled) return false;

      try {
        await rebindFromProvider(mm, { prompt: false });
        await attachListeners(mm);
        // Even if no accounts, init is "successful" (wallet present). UI will show Connect.
        return true;
      } catch (e) {
        console.warn("[wallet] init attempt failed (will retry)", e);
        return false;
      }
    };

    const initWithRetry = async () => {
      const delays = [0, 500, 1000, 2000, 4000, 8000];
      for (const d of delays) {
        if (cancelled) return;
        if (d) await sleep(d);
        if (cancelled) return;
        const ok = await tryInit();
        if (ok) return;
      }
    };

    initWithRetry();

    const onFocus = () => {
      if (!cancelled) initWithRetry();
    };
    const onVis = () => {
      if (document.visibilityState === "visible" && !cancelled) initWithRetry();
    };

    // ALSO: detect router-driven swaps of window.ethereum even without focus/visibility changes.
    // This is the key to avoiding manual refresh after selecting MetaMask inside Kasware.
    let lastEth = window.ethereum;
    const swapInterval = setInterval(() => {
      if (cancelled) return;
      if (window.ethereum && window.ethereum !== lastEth) {
        lastEth = window.ethereum;
        initWithRetry();
      }
    }, 750);

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      clearInterval(swapInterval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <WalletContext.Provider
      value={{
        address,
        chainId,
        isCorrectNetwork,
        provider,
        balanceNative,
        nativeSymbol: CHAIN_SYMBOL,
        refreshBalance,
        connect,
        getChainSignalsContract,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
};

export const useWallet = (): WalletContextType => {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
};
