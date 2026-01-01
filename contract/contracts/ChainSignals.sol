// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ChainSignals {
    enum PositionIntent {
        Long,
        Short
    }

    struct Signal {
        address trader;
        string  strategy;    // max 30 chars
        string  asset;       // max 10 chars
        string  message;     // optional, max 280 chars
        PositionIntent target;
        uint8   leverage;    // 1–5 (x)
        uint16  weight;      // >0, arbitrary units
        uint64  timestamp;   // block timestamp
    }

    uint256 public constant MAX_STRATEGY_LEN = 30;
    uint256 public constant MAX_ASSET_LEN = 10;
    uint256 public constant MAX_MESSAGE_LEN = 280;

    address public owner;
    uint256 public postFee;   // fee in wei of KAS per signal

    Signal[] public signals;
    mapping(address => uint256[]) private traderSignalIds;

    event SignalPosted(
        uint256 indexed id,
        address indexed trader,
        string  strategy,
        string  asset,
        string  message,
        PositionIntent target,
        uint8   leverage,
        uint16  weight,
        uint64  timestamp
    );

    event PostFeeUpdated(uint256 newFee);
    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        postFee = 0; // start with no fee
    }

    /// @notice change the fee (in wei of KAS) required to post a signal
    function setPostFee(uint256 newFee) external onlyOwner {
        postFee = newFee;
        emit PostFeeUpdated(newFee);
    }

    /// allow owner change
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    function postSignal(
        string calldata strategy,
        string calldata asset,
        string calldata message,
        PositionIntent target,
        uint8 leverage,
        uint16 weight
    ) external payable returns (uint256 id) {
        // anti-spam fee
        require(msg.value == postFee, "incorrect fee sent");

        uint256 stratLen = bytes(strategy).length;
        uint256 assetLen = bytes(asset).length;
        uint256 msgLen = bytes(message).length;

        require(stratLen > 0 && stratLen <= MAX_STRATEGY_LEN, "strategy length 1-30");
        require(assetLen > 0 && assetLen <= MAX_ASSET_LEN, "asset length 1-10");
        require(msgLen <= MAX_MESSAGE_LEN, "message too long");
        require(leverage >= 1 && leverage <= 5, "leverage 1-5");
        require(weight <= 100, "weight <= 100");

        uint64 ts = uint64(block.timestamp);

        signals.push(Signal({
            trader: msg.sender,
            strategy: strategy,
            asset: asset,
            message: message,
            target: target,
            leverage: leverage,
            weight: weight,
            timestamp: ts
        }));

        id = signals.length - 1;
        traderSignalIds[msg.sender].push(id);

        // forward fee to owner
        if (postFee > 0) {
            (bool ok, ) = owner.call{value: msg.value}("");
            require(ok, "fee transfer failed");
        }

        emit SignalPosted(
            id,
            msg.sender,
            strategy,
            asset,
            message,
            target,
            leverage,
            weight,
            ts
        );
    }

    function getSignalsCount() external view returns (uint256) {
        return signals.length;
    }

    /// @notice get signals in [from, to) range (0-based, half-open)
    function getSignalsRange(uint256 from, uint256 to)
    external
    view
    returns (Signal[] memory)
    {
        require(to <= signals.length, "range end too large");
        require(from <= to, "bad range");

        uint256 len = to - from;
        Signal[] memory result = new Signal[](len);

        for (uint256 i = 0; i < len; i++) {
            result[i] = signals[from + i];
        }

        return result;
    }

    /// @notice get all signal ids for a trader
    function getTraderSignalIds(address trader)
    external
    view
    returns (uint256[] memory ids)
    {
        uint256 len = traderSignalIds[trader].length;
        ids = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            ids[i] = traderSignalIds[trader][i];
        }
    }

    /// @notice get all signals for a trader (copy)
    function getTraderSignals(address trader) external view returns (Signal[] memory result) {
        uint256[] storage ids = traderSignalIds[trader];
        uint256 len = ids.length;
        result = new Signal[](len);

        for (uint256 i = 0; i < len; i++) {
            result[i] = signals[ids[i]];
        }
    }

    function getSignal(uint256 id) external view returns (Signal memory) {
        return signals[id];
    }
}
