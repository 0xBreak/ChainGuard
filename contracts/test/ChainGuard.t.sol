// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {IComplianceRegistry as IReg} from "../src/interfaces/IComplianceRegistry.sol";
import {ComplianceGuard} from "../src/ComplianceGuard.sol";
import {MockUSDG} from "../src/tokens/MockUSDG.sol";
import {MockStockToken} from "../src/tokens/MockStockToken.sol";

contract ChainGuardTest is Test {
    ComplianceRegistry reg;
    ComplianceGuard guard;
    MockUSDG usdg;
    MockStockToken tsla;

    address owner = makeAddr("owner");
    address m1 = makeAddr("m1");
    address m2 = makeAddr("m2");
    address m3 = makeAddr("m3");
    address relayer = makeAddr("relayer");
    address reporter = makeAddr("reporter");
    address alice = makeAddr("alice");
    address bad = makeAddr("bad");

    uint256 constant STAKE = 0.01 ether;
    uint64 constant TTL = 3 days;

    function setUp() public {
        address[] memory c = new address[](3);
        (c[0], c[1], c[2]) = (m1, m2, m3);
        reg = new ComplianceRegistry(owner, c, 2, STAKE, 2_000, 5_000, TTL);
        guard = new ComplianceGuard(reg);
        usdg = new MockUSDG(owner, guard);
        tsla = new MockStockToken(owner, guard, "Tesla Stock Token (Demo)", "TSLA");
        vm.prank(owner);
        reg.setRelayer(relayer);

        vm.deal(reporter, 10 ether);
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(reg).call{value: 1 ether}(""); // seed reward pool
        assertTrue(ok);

        vm.prank(alice);
        usdg.faucet();
        vm.prank(bad);
        usdg.faucet();
    }

    function _flag(address who, uint8 sev) internal {
        vm.prank(reporter);
        reg.flagAddress{value: STAKE}(who, IReg.Category.PHISHING, sev, keccak256("evidence"), "ipfs://evidence");
    }

    function _status(address who) internal view returns (IReg.Status) {
        return reg.getFlagDetails(who).status;
    }

    // ---------------------------------------------------------------- staking

    function test_FlagRequiresStake() public {
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IReg.InsufficientStake.selector, STAKE));
        reg.flagAddress{value: STAKE - 1}(bad, IReg.Category.PHISHING, 3, bytes32(0), "");
    }

    function test_FlagValidatesInput() public {
        vm.startPrank(reporter);
        vm.expectRevert(IReg.InvalidSeverity.selector);
        reg.flagAddress{value: STAKE}(bad, IReg.Category.PHISHING, 4, bytes32(0), "");
        vm.expectRevert(IReg.InvalidSeverity.selector);
        reg.flagAddress{value: STAKE}(bad, IReg.Category.PHISHING, 0, bytes32(0), "");
        vm.expectRevert(IReg.InvalidCategory.selector);
        reg.flagAddress{value: STAKE}(bad, IReg.Category.NONE, 3, bytes32(0), "");
        vm.expectRevert(IReg.InvalidAccount.selector);
        reg.flagAddress{value: STAKE}(address(0), IReg.Category.PHISHING, 3, bytes32(0), "");
        vm.stopPrank();
    }

    function test_ExploitCategoryAndOutOfRangeCategory() public {
        vm.prank(m1);
        reg.flagAddress(bad, IReg.Category.EXPLOIT, 3, keccak256("kelp"), "https://rekt.news/kelpdao-rekt");
        assertEq(uint8(reg.getFlagDetails(bad).category), uint8(IReg.Category.EXPLOIT));
        // Raw calldata with category 7 must not decode.
        (bool ok,) = address(reg).call{value: STAKE}(
            abi.encodeWithSelector(reg.flagAddress.selector, alice, uint8(7), uint8(3), bytes32(0), "")
        );
        assertFalse(ok);
    }

    function test_CannotDoubleFlag() public {
        _flag(bad, 3);
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IReg.FlagActive.selector, bad));
        reg.flagAddress{value: STAKE}(bad, IReg.Category.RUGPULL, 2, bytes32(0), "");
    }

    function test_PendingFlagIsOnlySoftWarning() public {
        _flag(bad, 3);
        (IReg.Category cat, uint8 sev) = reg.riskOf(bad);
        assertEq(uint8(cat), uint8(IReg.Category.PHISHING));
        assertEq(sev, 1);
        assertTrue(reg.isFlagged(bad));

        vm.expectEmit(true, true, false, true, address(guard));
        emit ComplianceGuard.ComplianceWarning(address(usdg), bad, IReg.Category.PHISHING, 1, alice, bad, 1e6);
        vm.prank(alice);
        usdg.transfer(bad, 1e6);
    }

    function test_ConfirmBlocksTransfersAndPaysReporter() public {
        _flag(bad, 3);
        vm.prank(m1);
        reg.confirmFlag(bad);
        assertEq(uint8(_status(bad)), uint8(IReg.Status.PENDING));
        vm.prank(m2);
        reg.confirmFlag(bad);
        assertEq(uint8(_status(bad)), uint8(IReg.Status.CONFIRMED));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGuard.AddressBlocked.selector, bad, IReg.Category.PHISHING, 3));
        usdg.transfer(bad, 1e6);

        // Outgoing from the flagged address is blocked too.
        vm.prank(bad);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGuard.AddressBlocked.selector, bad, IReg.Category.PHISHING, 3));
        usdg.transfer(alice, 1e6);

        // Even the faucet mint is screened.
        vm.prank(bad);
        vm.expectRevert();
        tsla.faucet();

        uint256 payout = STAKE + STAKE * 2_000 / 10_000;
        assertEq(reg.claimable(reporter), payout);
        assertEq(reg.totalStaked(), 0);
        uint256 before = reporter.balance;
        vm.prank(reporter);
        reg.withdraw();
        assertEq(reporter.balance, before + payout);
        (, uint32 confirmed,) = reg.reporterStats(reporter);
        assertEq(confirmed, 1);
    }

    function test_SoftSeverityConfirmedStillPasses() public {
        _flag(bad, 2);
        vm.prank(m1);
        reg.confirmFlag(bad);
        vm.prank(m3);
        reg.confirmFlag(bad);
        vm.prank(alice);
        usdg.transfer(bad, 1e6);
        assertEq(usdg.balanceOf(bad), 10_001e6);
    }

    function test_RejectSlashesStake() public {
        _flag(bad, 3);
        uint256 poolBefore = reg.rewardPool();
        vm.prank(m1);
        reg.rejectFlag(bad);
        vm.prank(m2);
        reg.rejectFlag(bad);

        assertEq(uint8(_status(bad)), uint8(IReg.Status.REJECTED));
        assertFalse(reg.isFlagged(bad));
        assertEq(reg.claimable(bad), STAKE / 2);
        assertEq(reg.rewardPool(), poolBefore + STAKE / 2);
        assertEq(reg.claimable(reporter), 0);
        assertEq(reg.activeFlags(), 0);

        vm.prank(bad);
        reg.withdraw();
        assertEq(bad.balance, STAKE / 2);
    }

    function test_MemberCannotVoteTwice() public {
        _flag(bad, 3);
        vm.startPrank(m1);
        reg.confirmFlag(bad);
        vm.expectRevert(IReg.AlreadyVoted.selector);
        reg.confirmFlag(bad);
        vm.expectRevert(IReg.AlreadyVoted.selector);
        reg.rejectFlag(bad);
        vm.stopPrank();
        assertEq(reg.hasVoted(bad, 1, m1), 1);
    }

    function test_OnlyCommitteeVotes() public {
        _flag(bad, 3);
        vm.prank(alice);
        vm.expectRevert(IReg.NotCommittee.selector);
        reg.confirmFlag(bad);
    }

    function test_CommitteeFlagCountsAsVote() public {
        vm.prank(m1);
        reg.flagAddress(bad, IReg.Category.SANCTIONED, 3, keccak256("ofac"), "https://ofac.treasury.gov");
        assertEq(reg.getFlagDetails(bad).confirmVotes, 1);
        vm.prank(m2);
        reg.confirmFlag(bad);
        assertEq(uint8(_status(bad)), uint8(IReg.Status.CONFIRMED));
    }

    function test_AppealAndClear() public {
        _flag(bad, 3);
        vm.prank(m1);
        reg.confirmFlag(bad);
        vm.prank(m2);
        reg.confirmFlag(bad);

        vm.prank(bad);
        reg.fileAppeal("compromised key, funds recovered");

        vm.prank(m3);
        reg.unflagAddress(bad);
        vm.prank(m1);
        reg.unflagAddress(bad);
        assertEq(uint8(_status(bad)), uint8(IReg.Status.CLEARED));

        vm.prank(alice);
        usdg.transfer(bad, 1e6);

        // Can be flagged again in a new round.
        _flag(bad, 3);
        assertEq(reg.getFlagDetails(bad).round, 2);
        assertEq(reg.totalFlags(), 2);
        assertEq(reg.flaggedCount(), 1);
    }

    function test_ExpireRefundsStake() public {
        _flag(bad, 3);
        vm.expectRevert(abi.encodeWithSelector(IReg.NotExpired.selector, uint64(block.timestamp) + TTL));
        reg.expireFlag(bad);
        vm.warp(block.timestamp + TTL);
        reg.expireFlag(bad);
        assertEq(reg.claimable(reporter), STAKE);
        assertEq(uint8(_status(bad)), uint8(IReg.Status.CLEARED));
        assertEq(reg.activeFlags(), 0);
    }

    function test_RewardCappedByPool() public {
        address[] memory c = new address[](1);
        c[0] = m1;
        ComplianceRegistry r = new ComplianceRegistry(owner, c, 1, STAKE, 5_000, 5_000, TTL);
        vm.prank(reporter);
        r.flagAddress{value: STAKE}(bad, IReg.Category.MIXER, 3, bytes32(0), "");
        vm.prank(m1);
        r.confirmFlag(bad);
        assertEq(r.claimable(reporter), STAKE); // empty pool, no reward
    }

    // ---------------------------------------------------------------- mirroring

    function _mirror(uint64 src, uint32 round, IReg.Status st) internal {
        vm.prank(relayer);
        reg.mirrorFlag(bad, src, round, st, IReg.Category.SANCTIONED, 3, reporter, uint64(block.timestamp), keccak256("x"));
    }

    function test_MirrorBlocksImmediately() public {
        _mirror(46630, 1, IReg.Status.CONFIRMED);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGuard.AddressBlocked.selector, bad, IReg.Category.SANCTIONED, 3));
        usdg.transfer(bad, 1);
        assertEq(reg.activeFlags(), 1);
        assertEq(reg.mirroredFlags(), 1);
    }

    function test_MirrorOnlyRelayer() public {
        vm.expectRevert(IReg.NotRelayer.selector);
        reg.mirrorFlag(bad, 46630, 1, IReg.Status.CONFIRMED, IReg.Category.SANCTIONED, 3, reporter, 0, 0);
    }

    function test_MirrorRejectsStaleAndLocalChain() public {
        _mirror(46630, 1, IReg.Status.CONFIRMED);
        vm.expectRevert(IReg.StaleMirror.selector);
        _mirror(46630, 1, IReg.Status.PENDING);
        vm.expectRevert(IReg.StaleMirror.selector);
        _mirror(uint64(block.chainid), 5, IReg.Status.CONFIRMED);

        _mirror(46630, 1, IReg.Status.CLEARED);
        assertEq(reg.activeFlags(), 0);
        assertFalse(reg.isFlagged(bad));
    }

    function test_ForeignFlagCannotBeVotedLocally() public {
        _mirror(46630, 1, IReg.Status.PENDING);
        vm.prank(m1);
        vm.expectRevert(abi.encodeWithSelector(IReg.ForeignFlag.selector, uint64(46630)));
        reg.confirmFlag(bad);
        // Nor re-flagged while active.
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IReg.FlagActive.selector, bad));
        reg.flagAddress{value: STAKE}(bad, IReg.Category.PHISHING, 3, bytes32(0), "");
    }

    function test_MirrorCannotOverwriteLiveLocalFlag() public {
        _flag(bad, 3);
        vm.expectRevert(abi.encodeWithSelector(IReg.MirrorConflict.selector, bad));
        _mirror(46630, 1, IReg.Status.CLEARED);
        assertEq(reg.totalStaked(), STAKE);
    }

    function test_LocalRoundNeverReusedAfterMirrorOverwrite() public {
        // Local round 1 rejected, round 2 rejected.
        for (uint256 i; i < 2; ++i) {
            _flag(bad, 3);
            vm.prank(m1);
            reg.rejectFlag(bad);
            vm.prank(m2);
            reg.rejectFlag(bad);
        }
        // A remote, already-cleared round-1 snapshot overwrites the inactive local record.
        _mirror(46630, 1, IReg.Status.CLEARED);
        assertEq(reg.getFlagDetails(bad).round, 1);

        // A fresh local flag must not reuse round 2 (whose votes are already recorded).
        _flag(bad, 3);
        assertEq(reg.getFlagDetails(bad).round, 3);
        vm.prank(m1);
        reg.confirmFlag(bad);
        vm.prank(m2);
        reg.confirmFlag(bad);
        assertEq(uint8(_status(bad)), uint8(IReg.Status.CONFIRMED));
    }

    // ---------------------------------------------------------------- batch import

    function _batch(uint256 n) internal pure returns (address[] memory a, IReg.Category[] memory c, uint8[] memory sv, string[] memory e) {
        a = new address[](n);
        c = new IReg.Category[](n);
        sv = new uint8[](n);
        e = new string[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = address(uint160(0xbad0000 + i));
            c[i] = IReg.Category.PHISHING;
            sv[i] = 3;
            e[i] = "ScamSniffer drainer - https://github.com/scamsniffer/scam-database";
        }
    }

    function test_FlagBatchAndConfirmBatch() public {
        (address[] memory a, IReg.Category[] memory c, uint8[] memory sv, string[] memory e) = _batch(50);
        vm.prank(m1);
        uint256 g = gasleft();
        assertEq(reg.flagBatch(a, c, sv, e), 50);
        emit log_named_uint("flagBatch gas / address", (g - gasleft()) / 50);

        // Re-running skips everything already live.
        vm.prank(m1);
        assertEq(reg.flagBatch(a, c, sv, e), 0);

        // m1 already voted via the flag; m2 brings quorum.
        vm.prank(m1);
        assertEq(reg.confirmBatch(a), 0);
        vm.prank(m2);
        assertEq(reg.confirmBatch(a), 50);
        for (uint256 i; i < 50; ++i) assertEq(uint8(_status(a[i])), uint8(IReg.Status.CONFIRMED));
        assertEq(reg.activeFlags(), 50);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGuard.AddressBlocked.selector, a[7], IReg.Category.PHISHING, 3));
        usdg.transfer(a[7], 1);
    }

    function test_FlagBatchOnlyCommittee() public {
        (address[] memory a, IReg.Category[] memory c, uint8[] memory sv, string[] memory e) = _batch(1);
        vm.prank(reporter);
        vm.expectRevert(IReg.NotCommittee.selector);
        reg.flagBatch(a, c, sv, e);
    }

    function test_MirrorBatchSkipsStaleAndConflicts() public {
        _flag(alice, 3); // live local flag -> conflict
        IReg.MirrorSnapshot[] memory snaps = new IReg.MirrorSnapshot[](3);
        snaps[0] = IReg.MirrorSnapshot(bad, 46630, 1, IReg.Status.CONFIRMED, IReg.Category.EXPLOIT, 3, reporter, 1, bytes32(0));
        snaps[1] = IReg.MirrorSnapshot(bad, 46630, 1, IReg.Status.PENDING, IReg.Category.EXPLOIT, 3, reporter, 1, bytes32(0)); // stale
        snaps[2] = IReg.MirrorSnapshot(alice, 46630, 1, IReg.Status.CONFIRMED, IReg.Category.EXPLOIT, 3, reporter, 1, bytes32(0));
        vm.prank(relayer);
        assertEq(reg.mirrorBatch(snaps), 1);
        assertEq(uint8(_status(bad)), uint8(IReg.Status.CONFIRMED));
        assertEq(uint8(_status(alice)), uint8(IReg.Status.PENDING));

        vm.expectRevert(IReg.NotRelayer.selector);
        reg.mirrorBatch(snaps);
    }

    // ---------------------------------------------------------------- views

    function test_GuardPreview() public {
        (bool allowed, address worst,, uint8 sev) = guard.preview(alice, bad);
        assertTrue(allowed);
        assertEq(worst, address(0));
        assertEq(sev, 0);

        _mirror(46630, 1, IReg.Status.CONFIRMED);
        (allowed, worst,, sev) = guard.preview(alice, bad);
        assertFalse(allowed);
        assertEq(worst, bad);
        assertEq(sev, 3);
    }

    function test_GetFlagsPaging() public {
        _flag(bad, 3);
        _flag(alice, 1);
        (address[] memory a, IReg.Flag[] memory f) = reg.getFlags(0, 10);
        assertEq(a.length, 2);
        assertEq(a[1], alice);
        assertEq(f[0].severity, 3);
        (a,) = reg.getFlags(1, 10);
        assertEq(a.length, 1);
        (a,) = reg.getFlags(5, 10);
        assertEq(a.length, 0);
        (uint256 total, uint256 active, uint256 reporters, uint256 staked,,) = reg.stats();
        assertEq(total, 2);
        assertEq(active, 2);
        assertEq(reporters, 1);
        assertEq(staked, 2 * STAKE);
    }

    function testFuzz_StakeAccountingConserved(uint96 stake, bool confirm) public {
        stake = uint96(bound(stake, STAKE, 5 ether));
        vm.deal(reporter, stake);
        uint256 before = address(reg).balance;
        vm.prank(reporter);
        reg.flagAddress{value: stake}(bad, IReg.Category.RUGPULL, 3, bytes32(0), "");
        vm.prank(m1);
        confirm ? reg.confirmFlag(bad) : reg.rejectFlag(bad);
        vm.prank(m2);
        confirm ? reg.confirmFlag(bad) : reg.rejectFlag(bad);
        // Every wei held is either in the pool, staked, or claimable.
        assertEq(
            address(reg).balance,
            reg.rewardPool() + reg.totalStaked() + reg.claimable(reporter) + reg.claimable(bad)
        );
        assertEq(address(reg).balance, before + stake);
    }
}
