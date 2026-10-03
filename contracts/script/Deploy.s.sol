// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {ComplianceGuard} from "../src/ComplianceGuard.sol";
import {MockUSDG} from "../src/tokens/MockUSDG.sol";
import {MockStockToken} from "../src/tokens/MockStockToken.sol";

/// @notice Deploys the full ChainGuard stack to the current chain and writes deployments/<tag>/<chainId>.json.
/// The start block is added afterwards by scripts/deploy.sh (on Arbitrum chains `block.number` is the L1 block).
/// Env: PRIVATE_KEY, COMMITTEE (comma-separated), RELAYER, optional DEPLOY_TAG, THRESHOLD, MIN_STAKE, REWARD_SEED.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address[] memory committee = vm.envAddress("COMMITTEE", ",");
        address relayer = vm.envAddress("RELAYER");
        uint8 threshold = uint8(vm.envOr("THRESHOLD", uint256(2)));
        uint256 minStake = vm.envOr("MIN_STAKE", uint256(0.001 ether));
        uint256 rewardSeed = vm.envOr("REWARD_SEED", uint256(0.005 ether));

        vm.startBroadcast(pk);
        ComplianceRegistry registry =
            new ComplianceRegistry(deployer, committee, threshold, minStake, 2_000, 5_000, 3 days);
        ComplianceGuard guard = new ComplianceGuard(registry);
        MockUSDG usdg = new MockUSDG(deployer, guard);
        MockStockToken stock = new MockStockToken(deployer, guard, "Tesla Stock Token (Demo)", "TSLA");
        registry.setRelayer(relayer);
        if (rewardSeed > 0) {
            (bool ok,) = address(registry).call{value: rewardSeed}("");
            require(ok, "seed");
        }
        vm.stopBroadcast();

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "registry", address(registry));
        vm.serializeAddress(key, "guard", address(guard));
        vm.serializeAddress(key, "usdg", address(usdg));
        string memory json = vm.serializeAddress(key, "stock", address(stock));
        string memory tag = vm.envOr("DEPLOY_TAG", string("testnet"));
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/", tag, "/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console.log("registry", address(registry));
        console.log("guard   ", address(guard));
        console.log("USDG    ", address(usdg));
        console.log("TSLA    ", address(stock));
        console.log("written ", path);
    }
}
