// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ComplianceGuard} from "../ComplianceGuard.sol";

/// @notice ERC-20 that screens both counterparties of every transfer, mint and burn through a ComplianceGuard.
/// @dev OpenZeppelin v5 replaced `_beforeTokenTransfer` with `_update`, so the hook lives there.
abstract contract ComplianceGuardedERC20 is ERC20, Ownable {
    ComplianceGuard public guard;

    event GuardUpdated(address guard);

    constructor(ComplianceGuard guard_) {
        guard = guard_;
    }

    function setGuard(ComplianceGuard guard_) external onlyOwner {
        guard = guard_;
        emit GuardUpdated(address(guard_));
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (address(guard) != address(0)) guard.check(from, to, value);
        super._update(from, to, value);
    }
}
