// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IComplianceRegistry {
    enum Category {
        NONE,
        SANCTIONED,
        PHISHING,
        RUGPULL,
        MIXER,
        SCAM_REPORTED,
        EXPLOIT
    }

    /// @dev Order matters: mirrored snapshots only move forward (PENDING -> CONFIRMED -> CLEARED, PENDING -> REJECTED).
    enum Status {
        NONE,
        PENDING,
        CONFIRMED,
        REJECTED,
        CLEARED
    }

    struct Flag {
        Category category;
        uint8 severity; // 1 = soft warning, 2 = elevated warning, 3 = hard block
        Status status;
        uint8 confirmVotes;
        uint8 rejectVotes;
        uint8 clearVotes;
        uint32 round; // increments every time the address is flagged again on its source chain
        uint64 sourceChainId; // chain where the flag was raised and is governed
        address reporter;
        uint64 timestamp;
        uint64 resolvedAt;
        uint96 stake;
        bytes32 evidenceHash;
    }

    struct MirrorSnapshot {
        address account;
        uint64 sourceChainId;
        uint32 round;
        Status status;
        Category category;
        uint8 severity;
        address reporter;
        uint64 timestamp;
        bytes32 evidenceHash;
    }

    event AddressFlagged(
        address indexed account,
        address indexed reporter,
        Category category,
        uint8 severity,
        bytes32 evidenceHash,
        string evidenceURI,
        uint256 stake,
        uint32 round
    );
    event FlagVote(address indexed account, address indexed member, uint8 action, uint32 round);
    event FlagConfirmed(address indexed account, address indexed reporter, uint256 payout, uint32 round);
    event FlagRejected(address indexed account, address indexed reporter, uint256 slashed, uint32 round);
    event FlagExpired(address indexed account, address indexed reporter, uint256 refunded, uint32 round);
    event AppealFiled(address indexed account, string reason, uint32 round);
    event AddressCleared(address indexed account, uint32 round);
    event FlagMirrored(
        address indexed account,
        uint64 indexed sourceChainId,
        Status status,
        Category category,
        uint8 severity,
        bytes32 evidenceHash,
        uint32 round
    );
    event Withdrawal(address indexed to, uint256 amount);
    event RewardPoolFunded(address indexed from, uint256 amount);
    event RelayerUpdated(address relayer);

    error InvalidCategory();
    error InvalidSeverity();
    error InvalidAccount();
    error InsufficientStake(uint256 required);
    error FlagActive(address account);
    error NoPendingFlag(address account);
    error NoConfirmedFlag(address account);
    error NotCommittee();
    error NotRelayer();
    error AlreadyVoted();
    error ForeignFlag(uint64 sourceChainId);
    error NotExpired(uint64 expiresAt);
    error StaleMirror();
    error MirrorConflict(address account);
    error NothingToWithdraw();
    error TransferFailed();

    function riskOf(address account) external view returns (Category category, uint8 severity);
    function isFlagged(address account) external view returns (bool);
    function getFlagDetails(address account) external view returns (Flag memory);
}
