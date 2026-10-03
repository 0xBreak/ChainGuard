// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ComplianceGuard} from "../ComplianceGuard.sol";
import {ComplianceGuardedERC20} from "./ComplianceGuardedERC20.sol";

/// @notice Demo stand-in for Global Dollar (USDG) with the compliance hook attached.
contract MockUSDG is ComplianceGuardedERC20 {
    uint256 public constant FAUCET_AMOUNT = 10_000e6;

    constructor(address owner_, ComplianceGuard guard_)
        ERC20("Global Dollar (Demo)", "USDG")
        Ownable(owner_)
        ComplianceGuardedERC20(guard_)
    {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Testnet faucet. Screened like any other mint.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
