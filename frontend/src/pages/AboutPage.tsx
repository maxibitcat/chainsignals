import React from "react";

const AboutPage: React.FC = () => {
  const githubUrl = "https://github.com/maxibitcat/chainsignals";

  return (
    <div className="card card-narrow">
      <div className="card-header">
        <div>
          <div className="card-title">Chainsignals</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.9rem", lineHeight: 1.55 }}>
        <p>
          Do you want to prove your talents with markets, and show to everyone how good you are as a trader?
        </p>

        <p>
          Post your trading signals on-chain, in a transparent, immutable, and easily measurable way.
        </p>

        <p>
          Chainsignals stores all data in a smart contract deployed on Kasplex, a based rollup of Kaspa
          (meaning that signals are also posted to Kaspa L1 and persist on all archival nodes). It requires
          Metamask for sending signals, and a Kaspa wallet for in-app bridging, if necessary.
        </p>
        <p>
          The full code is
          open-source and available{" "}
          <a href={githubUrl} target="_blank" rel="noreferrer">
            here
          </a>
          .
        </p>
      </div>
    </div>
  );
};

export default AboutPage;
