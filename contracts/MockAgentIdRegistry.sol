// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockAgentIdRegistry
/// @notice TEST-ONLY mock of the SPACE ID Agent ID registry (ERC-721) for BSC Testnet.
/// @dev The official Agent ID contract (0x60b9262456de011f7d15a54cdd8c48baaa8b022f)
///      does NOT exist on BSC Testnet (eth_getCode returns 0x). This mock implements
///      ONLY `balanceOf(address)` with the exact ERC-721 signature, so the EstafAgen
///      contract can be tested on testnet with the same gating logic as mainnet.
///      `setBalance` is test-only: it lets test wallets pretend to hold an Agent ID.
///      NEVER deploy this mock to mainnet and NEVER submit its address as part of
///      the hackathon submission. Testnet votes/delegations made through this mock
///      prove the mechanism, not Sybil resistance.
contract MockAgentIdRegistry {
    mapping(address => uint256) private _balances;

    /// @notice Returns the number of Agent IDs held by `account`.
    /// @dev Exact ERC-721 `balanceOf` signature, matching the official registry.
    /// @param account The address to check.
    /// @return The mocked Agent ID balance (0 = not a holder).
    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    /// @notice TEST-ONLY: set the mocked Agent ID balance of `account`.
    /// @dev Exists only so tests and testnet wallets can simulate holding an
    ///      Agent ID. This function MUST NOT exist in any mainnet contract.
    /// @param account The address whose mocked balance is set.
    /// @param amount The mocked balance (1 = holder, 0 = not a holder).
    function setBalance(address account, uint256 amount) external {
        _balances[account] = amount;
    }
}
