import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import StrategyViewer from "../components/StrategyViewer";

const StrategyPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const strategyId = Number(id);
  const navigate = useNavigate();

  const onBack = () => {
    // If the user came from the leaderboard, browser back is ideal.
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/");
  };

  return (
    <div style={{ width: "100%" }}>
      <div className="card card-narrow" style={{ padding: 0 }}>
        <div
          className="card-header"
          style={{
            padding: "0.75rem 0.75rem 0.5rem 0.75rem",
            marginBottom: 0,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="btn" onClick={onBack}>
              ← Back
            </button>
            <div>
              <div className="card-title">Strategy details</div>
            </div>
          </div>
        </div>

        <div style={{ padding: "0.75rem" }}>
          {Number.isFinite(strategyId) && strategyId > 0 ? (
            <StrategyViewer strategyId={strategyId} layout="stacked" showControls={true} />
          ) : (
            <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Invalid strategy id.</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StrategyPage;
