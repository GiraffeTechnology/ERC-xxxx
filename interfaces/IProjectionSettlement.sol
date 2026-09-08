// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IProjectionSettlement is IERC165 {
    enum GapStatus { NONE, OPEN, ADMITTED, CANCELLED, SUPERSEDED }

    struct Settlement {
        uint256 tokenId;
        address initiator;
        address expectedHolder;
        bytes32 snapshotHash;
        uint64 openedAt;
        uint64 deadline;
        GapStatus status;
    }

    event SettlementStarted(bytes32 indexed settlementId, uint256 indexed tokenId, address indexed initiator, address expectedHolder, bytes32 snapshotHash, uint64 deadline);
    event SettlementFinalized(bytes32 indexed settlementId, uint256 indexed tokenId, bytes32 indexed recordCommitment, uint64 version, uint64 effectiveAt);
    event SettlementCancelled(bytes32 indexed settlementId, uint256 indexed tokenId, bytes32 indexed reasonHash);
    event SettlementSuperseded(bytes32 indexed supersededId, bytes32 indexed replacementId, uint256 indexed tokenId);

    function settlement(bytes32 settlementId)
        external view returns (Settlement memory record);

    function openGapOf(uint256 tokenId)
        external view returns (bytes32 settlementId);

    function settlementPeriod()
        external view returns (uint64 maximumInterval);

    function verificationProfile()
        external view returns (bytes32 identifier);

    function isSettlementAuthority(uint256 tokenId, address account)
        external view returns (bool authorized);

    function beginSettlement(uint256 tokenId, bytes32 settlementId, address expectedHolder, bytes32 snapshotHash, uint64 deadline) external;

    function finalizeSettlement(bytes32 settlementId, bytes32 recordCommitment, bytes32 registryReference, uint64 effectiveAt, bytes calldata proofData) external;

    function cancelSettlement(bytes32 settlementId, bytes32 reasonHash) external;
}
