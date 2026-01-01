import React, { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "../web3/WalletContext";

declare global {
  interface Window {
    kasware?: any;
  }
}

const KURVE_L1_BRIDGE_ADDRESS =
  "kaspa:qypr0qj7luv26laqlquan9n2zu7wyen87fkdw3kx3kd69ymyw3tj4tsh467xzf2";

function kasToSompi(amountStr: string): bigint {
  const s = amountStr.trim();
  if (!s) throw new Error("Empty amount");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount format");

  const [whole, fracRaw = ""] = s.split(".");
  const frac = (fracRaw + "00000000").slice(0, 8);
  return BigInt(whole) * 100000000n + BigInt(frac);
}

const WalletControls: React.FC = () => {
  const { address, balanceNative, nativeSymbol, isCorrectNetwork, connect, refreshBalance } = useWallet();

  const isConnectedForUI = !!address && isCorrectNetwork;
  const l2Address = isConnectedForUI ? address : null;

  const [showTopUp, setShowTopUp] = useState(false);
  const [bridgeAmount, setBridgeAmount] = useState<string>("1");
  const [bridging, setBridging] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const walletLabel = useMemo(() => {
    if (!address) return "Connect Wallet";
    if (!isCorrectNetwork) return "Wrong network";
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
    const bal = balanceNative ?? "…";
    return `${short} · ${bal} ${nativeSymbol}`;
  }, [address, isCorrectNetwork, balanceNative, nativeSymbol]);

  const handleWalletClick = async () => {
    // If disconnected or wrong network, trigger connect (which also best-effort switches chain).
    if (!address || !isCorrectNetwork) {
      await connect();
      await refreshBalance().catch(() => {});
      return;
    }

    // Connected: refresh is done by clicking the balance.
    await refreshBalance().catch(() => {});
  };

  const handleBridge = async () => {
    if (!l2Address) return alert("Connect your wallet first.");

    let sompi: bigint;
    try {
      sompi = kasToSompi(bridgeAmount);
    } catch (e: any) {
      return alert(e?.message || "Invalid amount");
    }

    if (sompi < 100000000n) return alert("Minimum bridge amount is 1 KAS.");
    if (!window.kasware) return alert("KasWare wallet is required for bridging.");

    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (sompi > maxSafe) return alert("Amount too large.");

    setBridging(true);
    try {
      await window.kasware.requestAccounts();
      await window.kasware.sendKaspa(KURVE_L1_BRIDGE_ADDRESS, Number(sompi), {
        payload: l2Address,
      });
      setShowTopUp(false);
    } catch (e: any) {
      console.error(e);
      alert(e?.message || "Bridge transaction failed");
    } finally {
      setBridging(false);
    }
  };

  // Close the top-up popover on outside click.
  useEffect(() => {
    if (!showTopUp) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setShowTopUp(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showTopUp]);

  return (
    <div className="wallet-controls" ref={wrapperRef}>
      <button className="btn" onClick={handleWalletClick} title="Click to refresh balance">
        {walletLabel}
      </button>

      {isConnectedForUI && (
        <>
          <button className="btn" onClick={() => setShowTopUp((s) => !s)}>
            Top up
          </button>

          {showTopUp && (
            <div className="wallet-popover" role="dialog" aria-label="Top up via bridge">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Top up</div>
                <input
                  value={bridgeAmount}
                  onChange={(e) => setBridgeAmount(e.target.value)}
                  className="wallet-topup-input"
                  placeholder="1"
                />
                <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>KAS</div>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                <button className="btn btn-primary" onClick={handleBridge} disabled={bridging}>
                  {bridging ? "Bridging…" : "Bridge"}
                </button>
                <button className="btn" onClick={() => setShowTopUp(false)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default WalletControls;
