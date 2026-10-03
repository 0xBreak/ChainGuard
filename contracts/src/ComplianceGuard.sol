// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IComplianceRegistry} from "./interfaces/IComplianceRegistry.sol";

/// @title ComplianceGuard
/// @notice Transfer hook shared by any number of tokens. Severity 3 reverts the transfer;
/// severity 1-2 lets it through but emits a warning ("yellow flag") for monitoring.
contract ComplianceGuard {
    uint8 public constant BLOCK_SEVERITY = 3;

    IComplianceRegistry public immutable registry;

    event ComplianceWarning(
        address indexed token,
        address indexed account,
        IComplianceRegistry.Category category,
        uint8 severity,
        address from,
        address to,
        uint256 amount
    );

    error AddressBlocked(address account, IComplianceRegistry.Category category, uint8 severity);

    constructor(IComplianceRegistry registry_) {
        registry = registry_;
    }

    /// @notice Called by a token before moving funds. `msg.sender` is the token.
    function check(address from, address to, uint256 amount) external {
        _inspect(from, from, to, amount);
        _inspect(to, from, to, amount);
    }

    /// @notice Dry run for UIs: would a transfer between these parties go through?
    function preview(address from, address to)
        external
        view
        returns (bool allowed, address worst, IComplianceRegistry.Category category, uint8 severity)
    {
        (IComplianceRegistry.Category cf, uint8 sf) = _risk(from);
        (IComplianceRegistry.Category ct, uint8 st) = _risk(to);
        (worst, category, severity) = sf >= st ? (from, cf, sf) : (to, ct, st);
        if (severity == 0) worst = address(0);
        allowed = severity < BLOCK_SEVERITY;
    }

    function _inspect(address account, address from, address to, uint256 amount) internal {
        (IComplianceRegistry.Category category, uint8 severity) = _risk(account);
        if (severity == 0) return;
        if (severity >= BLOCK_SEVERITY) revert AddressBlocked(account, category, severity);
        emit ComplianceWarning(msg.sender, account, category, severity, from, to, amount);
    }

    function _risk(address account) internal view returns (IComplianceRegistry.Category, uint8) {
        if (account == address(0)) return (IComplianceRegistry.Category.NONE, 0);
        return registry.riskOf(account);
    }
}
