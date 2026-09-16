// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Vault
/// @notice Simple ETH vault with a fee on withdrawals. Used as a local proving
/// ground for Warden (it hides two classic bugs on purpose).
contract Vault {
    mapping(address => uint256) public balances;
    address public owner;
    uint256 public feeBps = 10; // 0.1%
    uint256 public collectedFees;

    event Deposited(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount, uint256 fee);

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        require(msg.value > 0, "zero");
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 payout = amount - fee;
        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "transfer failed");
        balances[msg.sender] -= amount;
        collectedFees += fee;
        emit Withdrawn(msg.sender, payout, fee);
    }

    /// @notice Withdraw the whole balance in one call (no fee).
    function withdrawAll() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
    }

    function setOwner(address newOwner) external {
        require(newOwner != address(0), "zero owner");
        owner = newOwner;
    }

    function setFee(uint256 bps) external {
        require(msg.sender == owner, "not owner");
        require(bps <= 1_000, "fee too high");
        feeBps = bps;
    }

    function collectFees(address to) external {
        require(msg.sender == owner, "not owner");
        uint256 amount = collectedFees;
        collectedFees = 0;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function totalAssets() external view returns (uint256) {
        return address(this).balance;
    }
}
