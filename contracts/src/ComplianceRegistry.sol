// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IComplianceRegistry} from "./interfaces/IComplianceRegistry.sol";

/// @title ComplianceRegistry
/// @notice On-chain threat registry with staked reporting and committee resolution.
/// Reporters stake ETH to flag an address. While a flag is PENDING it only produces a soft
/// warning, so a malicious reporter cannot freeze anyone's funds. Once a committee quorum
/// confirms the flag, its full severity applies and the reporter gets the stake back plus a
/// reward. A rejected flag is slashed: part compensates the wrongly flagged address, the rest
/// funds future rewards.
/// @dev The same registry is deployed on several chains. A trusted relayer mirrors flag
/// snapshots between them; only the source chain can vote on or resolve a flag.
contract ComplianceRegistry is IComplianceRegistry, Ownable {
    uint8 internal constant ACTION_CONFIRM = 1;
    uint8 internal constant ACTION_REJECT = 2;
    uint8 internal constant ACTION_CLEAR = 3;
    uint16 internal constant BPS = 10_000;

    struct ReporterStats {
        uint32 submitted;
        uint32 confirmed;
        uint32 rejected;
    }

    address[] public committee;
    mapping(address => uint8) internal _memberSlot; // index + 1
    uint8 public immutable threshold;

    address public relayer;
    uint256 public minStake;
    uint16 public rewardBps; // reward on confirmation, as a share of the stake, paid from rewardPool
    uint16 public victimBps; // share of a slashed stake paid to the wrongly flagged address
    uint64 public pendingTtl; // after this, an unresolved pending flag can be expired and refunded

    uint256 public rewardPool;
    uint256 public totalStaked;
    uint256 public totalFlags;
    uint256 public activeFlags;
    uint256 public uniqueReporters;
    uint256 public mirroredFlags;

    mapping(address => Flag) internal _flags;
    mapping(address => ReporterStats) public reporterStats;
    mapping(address => uint256) public claimable;
    mapping(address => mapping(uint32 => mapping(uint8 => uint256))) internal _votes; // account => round => action => member bitmap
    mapping(address => uint32) internal _localRound; // monotonic even if a mirror overwrites an inactive local record

    address[] internal _flagged;
    mapping(address => bool) internal _listed;

    modifier onlyCommittee() {
        if (_memberSlot[msg.sender] == 0) revert NotCommittee();
        _;
    }

    constructor(
        address owner_,
        address[] memory committee_,
        uint8 threshold_,
        uint256 minStake_,
        uint16 rewardBps_,
        uint16 victimBps_,
        uint64 pendingTtl_
    ) Ownable(owner_) {
        require(committee_.length > 0 && committee_.length <= 32, "committee size");
        require(threshold_ > 0 && threshold_ <= committee_.length, "threshold");
        require(rewardBps_ <= BPS && victimBps_ <= BPS, "bps");
        for (uint256 i; i < committee_.length; ++i) {
            require(committee_[i] != address(0) && _memberSlot[committee_[i]] == 0, "member");
            committee.push(committee_[i]);
            _memberSlot[committee_[i]] = uint8(i + 1);
        }
        threshold = threshold_;
        minStake = minStake_;
        rewardBps = rewardBps_;
        victimBps = victimBps_;
        pendingTtl = pendingTtl_;
    }

    receive() external payable {
        rewardPool += msg.value;
        emit RewardPoolFunded(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // Reporting
    // ------------------------------------------------------------------

    /// @notice Flag an address. Non-committee reporters must stake at least `minStake`.
    /// A committee member's flag counts as their confirm vote.
    function flagAddress(
        address account,
        Category category,
        uint8 severity,
        bytes32 evidenceHash,
        string calldata evidenceURI
    ) external payable {
        bool isMember = _memberSlot[msg.sender] != 0;
        if (!isMember && msg.value < minStake) revert InsufficientStake(minStake);
        require(msg.value <= type(uint96).max, "stake");
        if (_isActive(_flags[account].status)) revert FlagActive(account);
        _flag(account, category, severity, evidenceHash, evidenceURI, msg.value);
        if (isMember) _vote(account, _flags[account], ACTION_CONFIRM);
    }

    /// @notice Bulk import from threat-intel feeds (OFAC, exploit trackers). Each flag counts as the caller's
    /// confirm vote; addresses that already have a live flag are skipped.
    function flagBatch(
        address[] calldata accounts,
        Category[] calldata categories,
        uint8[] calldata severities,
        string[] calldata evidenceURIs
    ) external onlyCommittee returns (uint256 flagged) {
        uint256 n = accounts.length;
        require(categories.length == n && severities.length == n && evidenceURIs.length == n, "length");
        for (uint256 i; i < n; ++i) {
            if (_isActive(_flags[accounts[i]].status)) continue;
            _flag(accounts[i], categories[i], severities[i], keccak256(bytes(evidenceURIs[i])), evidenceURIs[i], 0);
            _vote(accounts[i], _flags[accounts[i]], ACTION_CONFIRM);
            flagged++;
        }
    }

    function _flag(
        address account,
        Category category,
        uint8 severity,
        bytes32 evidenceHash,
        string calldata evidenceURI,
        uint256 stake
    ) internal {
        if (account == address(0)) revert InvalidAccount();
        if (category == Category.NONE) revert InvalidCategory();
        if (severity == 0 || severity > 3) revert InvalidSeverity();

        uint32 round = ++_localRound[account];
        _flags[account] = Flag({
            category: category,
            severity: severity,
            status: Status.PENDING,
            confirmVotes: 0,
            rejectVotes: 0,
            clearVotes: 0,
            round: round,
            sourceChainId: uint64(block.chainid),
            reporter: msg.sender,
            timestamp: uint64(block.timestamp),
            resolvedAt: 0,
            stake: uint96(stake),
            evidenceHash: evidenceHash
        });

        totalStaked += stake;
        totalFlags++;
        activeFlags++;
        ReporterStats storage rs = reporterStats[msg.sender];
        if (rs.submitted == 0) uniqueReporters++;
        rs.submitted++;
        _list(account);

        emit AddressFlagged(account, msg.sender, category, severity, evidenceHash, evidenceURI, stake, round);
    }

    /// @notice Let a flagged address put its side on record. Resolution is still a committee vote.
    function fileAppeal(string calldata reason) external {
        Flag storage f = _flags[msg.sender];
        if (!_isActive(f.status)) revert NoConfirmedFlag(msg.sender);
        emit AppealFiled(msg.sender, reason, f.round);
    }

    /// @notice Refund a pending flag the committee never resolved.
    function expireFlag(address account) external {
        Flag storage f = _flags[account];
        if (f.status != Status.PENDING) revert NoPendingFlag(account);
        _requireLocal(f);
        uint64 expiresAt = f.timestamp + pendingTtl;
        if (block.timestamp < expiresAt) revert NotExpired(expiresAt);

        uint256 stake = f.stake;
        f.status = Status.CLEARED;
        f.resolvedAt = uint64(block.timestamp);
        f.stake = 0;
        totalStaked -= stake;
        activeFlags--;
        claimable[f.reporter] += stake;
        emit FlagExpired(account, f.reporter, stake, f.round);
    }

    // ------------------------------------------------------------------
    // Committee
    // ------------------------------------------------------------------

    function confirmFlag(address account) external onlyCommittee {
        Flag storage f = _flags[account];
        if (f.status != Status.PENDING) revert NoPendingFlag(account);
        _vote(account, f, ACTION_CONFIRM);
    }

    function rejectFlag(address account) external onlyCommittee {
        Flag storage f = _flags[account];
        if (f.status != Status.PENDING) revert NoPendingFlag(account);
        _vote(account, f, ACTION_REJECT);
    }

    /// @notice Confirm many pending flags at once; skips anything not pending here or already voted on.
    function confirmBatch(address[] calldata accounts) external onlyCommittee returns (uint256 voted) {
        uint256 bit = 1 << (_memberSlot[msg.sender] - 1);
        for (uint256 i; i < accounts.length; ++i) {
            Flag storage f = _flags[accounts[i]];
            if (f.status != Status.PENDING || f.sourceChainId != block.chainid) continue;
            mapping(uint8 => uint256) storage v = _votes[accounts[i]][f.round];
            if ((v[ACTION_CONFIRM] | v[ACTION_REJECT]) & bit != 0) continue;
            _vote(accounts[i], f, ACTION_CONFIRM);
            voted++;
        }
    }

    /// @notice Vote to lift a confirmed flag (successful appeal, delisting, etc).
    function unflagAddress(address account) external onlyCommittee {
        Flag storage f = _flags[account];
        if (f.status != Status.CONFIRMED) revert NoConfirmedFlag(account);
        _vote(account, f, ACTION_CLEAR);
    }

    function _vote(address account, Flag storage f, uint8 action) internal {
        _requireLocal(f);
        uint256 bit = 1 << (_memberSlot[msg.sender] - 1);
        mapping(uint8 => uint256) storage roundVotes = _votes[account][f.round];
        if (action == ACTION_CLEAR) {
            if (roundVotes[ACTION_CLEAR] & bit != 0) revert AlreadyVoted();
        } else if ((roundVotes[ACTION_CONFIRM] | roundVotes[ACTION_REJECT]) & bit != 0) {
            revert AlreadyVoted();
        }
        roundVotes[action] |= bit;
        emit FlagVote(account, msg.sender, action, f.round);

        if (action == ACTION_CONFIRM) {
            if (++f.confirmVotes >= threshold) _confirm(account, f);
        } else if (action == ACTION_REJECT) {
            if (++f.rejectVotes >= threshold) _reject(account, f);
        } else {
            if (++f.clearVotes >= threshold) _clear(account, f);
        }
    }

    function _confirm(address account, Flag storage f) internal {
        uint256 stake = f.stake;
        uint256 reward = stake * rewardBps / BPS;
        if (reward > rewardPool) reward = rewardPool;
        rewardPool -= reward;
        totalStaked -= stake;

        f.status = Status.CONFIRMED;
        f.resolvedAt = uint64(block.timestamp);
        f.stake = 0;
        claimable[f.reporter] += stake + reward;
        reporterStats[f.reporter].confirmed++;
        emit FlagConfirmed(account, f.reporter, stake + reward, f.round);
    }

    function _reject(address account, Flag storage f) internal {
        uint256 stake = f.stake;
        uint256 toVictim = stake * victimBps / BPS;
        totalStaked -= stake;
        rewardPool += stake - toVictim;
        claimable[account] += toVictim;

        f.status = Status.REJECTED;
        f.resolvedAt = uint64(block.timestamp);
        f.stake = 0;
        activeFlags--;
        reporterStats[f.reporter].rejected++;
        emit FlagRejected(account, f.reporter, stake, f.round);
    }

    function _clear(address account, Flag storage f) internal {
        f.status = Status.CLEARED;
        f.resolvedAt = uint64(block.timestamp);
        activeFlags--;
        emit AddressCleared(account, f.round);
    }

    // ------------------------------------------------------------------
    // Cross-chain mirroring
    // ------------------------------------------------------------------

    /// @notice Apply a flag snapshot observed on another chain's registry.
    function mirrorFlag(
        address account,
        uint64 sourceChainId,
        uint32 round,
        Status status,
        Category category,
        uint8 severity,
        address reporter,
        uint64 timestamp,
        bytes32 evidenceHash
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        _mirror(MirrorSnapshot(account, sourceChainId, round, status, category, severity, reporter, timestamp, evidenceHash), true);
    }

    /// @notice Apply many snapshots; stale or conflicting ones are skipped instead of reverting the batch.
    function mirrorBatch(MirrorSnapshot[] calldata snaps) external returns (uint256 applied) {
        if (msg.sender != relayer) revert NotRelayer();
        for (uint256 i; i < snaps.length; ++i) {
            if (_mirror(snaps[i], false)) applied++;
        }
    }

    function _mirror(MirrorSnapshot memory m, bool strict) internal returns (bool) {
        if (m.account == address(0)) revert InvalidAccount();
        if (m.sourceChainId == block.chainid || m.status == Status.NONE) revert StaleMirror();
        if (m.severity == 0 || m.severity > 3) revert InvalidSeverity();
        if (m.category == Category.NONE) revert InvalidCategory();

        Flag storage f = _flags[m.account];
        if (f.sourceChainId == m.sourceChainId) {
            bool newer = m.round > f.round || (m.round == f.round && uint8(m.status) > uint8(f.status));
            if (!newer) {
                if (strict) revert StaleMirror();
                return false;
            }
        } else if (_isActive(f.status)) {
            // Never overwrite a live flag governed elsewhere (it may hold a stake).
            if (strict) revert MirrorConflict(m.account);
            return false;
        }

        bool wasActive = _isActive(f.status);
        bool nowActive = _isActive(m.status);
        if (wasActive && !nowActive) activeFlags--;
        else if (!wasActive && nowActive) activeFlags++;

        _flags[m.account] = Flag({
            category: m.category,
            severity: m.severity,
            status: m.status,
            confirmVotes: 0,
            rejectVotes: 0,
            clearVotes: 0,
            round: m.round,
            sourceChainId: m.sourceChainId,
            reporter: m.reporter,
            timestamp: m.timestamp,
            resolvedAt: m.status == Status.PENDING ? 0 : uint64(block.timestamp),
            stake: 0,
            evidenceHash: m.evidenceHash
        });
        mirroredFlags++;
        _list(m.account);
        emit FlagMirrored(m.account, m.sourceChainId, m.status, m.category, m.severity, m.evidenceHash, m.round);
        return true;
    }

    // ------------------------------------------------------------------
    // Funds
    // ------------------------------------------------------------------

    function withdraw() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        claimable[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawal(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit RelayerUpdated(relayer_);
    }

    function setParams(uint256 minStake_, uint16 rewardBps_, uint16 victimBps_, uint64 pendingTtl_) external onlyOwner {
        require(rewardBps_ <= BPS && victimBps_ <= BPS, "bps");
        minStake = minStake_;
        rewardBps = rewardBps_;
        victimBps = victimBps_;
        pendingTtl = pendingTtl_;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Severity that integrations should enforce. Pending flags are capped at a soft warning.
    function riskOf(address account) public view returns (Category, uint8) {
        Flag storage f = _flags[account];
        if (f.status == Status.CONFIRMED) return (f.category, f.severity);
        if (f.status == Status.PENDING) return (f.category, 1);
        return (Category.NONE, 0);
    }

    function isFlagged(address account) external view returns (bool) {
        return _isActive(_flags[account].status);
    }

    function getFlagDetails(address account) external view returns (Flag memory) {
        return _flags[account];
    }

    function hasVoted(address account, uint32 round, address member) external view returns (uint8 action) {
        uint8 slot = _memberSlot[member];
        if (slot == 0) return 0;
        uint256 bit = 1 << (slot - 1);
        mapping(uint8 => uint256) storage v = _votes[account][round];
        if (v[ACTION_CONFIRM] & bit != 0) return ACTION_CONFIRM;
        if (v[ACTION_REJECT] & bit != 0) return ACTION_REJECT;
        if (v[ACTION_CLEAR] & bit != 0) return ACTION_CLEAR;
        return 0;
    }

    function isCommittee(address account) external view returns (bool) {
        return _memberSlot[account] != 0;
    }

    function getCommittee() external view returns (address[] memory) {
        return committee;
    }

    function flaggedCount() external view returns (uint256) {
        return _flagged.length;
    }

    /// @notice Page through every address that has ever had a flag, newest last.
    function getFlags(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory accounts, Flag[] memory flags)
    {
        uint256 n = _flagged.length;
        if (offset >= n) return (accounts, flags);
        uint256 end = offset + limit > n ? n : offset + limit;
        accounts = new address[](end - offset);
        flags = new Flag[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            accounts[i - offset] = _flagged[i];
            flags[i - offset] = _flags[_flagged[i]];
        }
    }

    function stats()
        external
        view
        returns (
            uint256 totalFlags_,
            uint256 activeFlags_,
            uint256 uniqueReporters_,
            uint256 totalStaked_,
            uint256 rewardPool_,
            uint256 mirroredFlags_
        )
    {
        return (totalFlags, activeFlags, uniqueReporters, totalStaked, rewardPool, mirroredFlags);
    }

    function _isActive(Status s) internal pure returns (bool) {
        return s == Status.PENDING || s == Status.CONFIRMED;
    }

    function _requireLocal(Flag storage f) internal view {
        if (f.sourceChainId != block.chainid) revert ForeignFlag(f.sourceChainId);
    }

    function _list(address account) internal {
        if (!_listed[account]) {
            _listed[account] = true;
            _flagged.push(account);
        }
    }
}
