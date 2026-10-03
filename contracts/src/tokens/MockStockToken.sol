// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ComplianceGuard} from "../ComplianceGuard.sol";
import {ComplianceGuardedERC20} from "./ComplianceGuardedERC20.sol";

/// @notice Demo tokenized equity (Stock Token style) with the compliance hook attached.
contract MockStockToken is ComplianceGuardedERC20 {
    uint256 public constant FAUCET_AMOUNT = 25e18;

    constructor(address owner_, ComplianceGuard guard_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        Ownable(owner_)
        ComplianceGuardedERC20(guard_)
    {}

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
