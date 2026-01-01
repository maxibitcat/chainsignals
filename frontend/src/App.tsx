import React from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import LeaderboardPage from "./pages/LeaderboardPage";
import StrategyPage from "./pages/StrategyPage";
import MyStrategiesPage from "./pages/MyStrategiesPage";
import TraderPage from "./pages/TraderPage";
import AboutPage from "./pages/AboutPage";
import { WalletProvider } from "./web3/WalletContext";
import logo from "./assets/logo.png";
import WalletControls from "./components/WalletControls";


const App: React.FC = () => {
  return (
    <WalletProvider>
    <div className="app-shell">
    <header className="app-header">
      <Link to="/" className="app-logo" title="Go to leaderboard">
        <img className="app-logo-mark" src={logo} alt="CHAINSIGNALS logo" />
        <div>
          <div className="app-logo-text-main">CHAINSIGNALS - beta</div>
          <div className="app-logo-text-sub">On-chain Trading Strategy Tracker</div>
        </div>
      </Link>

      <div className="app-header-right">
        <nav className="app-nav">
          <NavLink to="/me">My Strategies</NavLink>
        </nav>
        <WalletControls />
      </div>
    </header>
    <main className="app-main">
      <Routes>
        <Route path="/" element={<LeaderboardPage />} />
        <Route path="/strategy/:id" element={<StrategyPage />} />
        <Route path="/trader/:address" element={<TraderPage />} />
        <Route path="/me" element={<MyStrategiesPage />} />
        <Route path="/about" element={<AboutPage />} />
      </Routes>
    </main>
    <footer className="app-footer">
      <Link to="/about" title="About">
        1) What
      </Link>
    </footer>
    </div>
    </WalletProvider>
  );
};

export default App;
