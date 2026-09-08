// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IRegisterProjection is IERC165 {
    struct RegisterEntry {
        bytes32 recordCommitment;
        bytes32 previousCommitment;
        bytes32 registryReference;
        address holder;
        uint64 version;
        uint64 effectiveAt;
        uint64 supersededAt;
    }

    event RegisterInitialized(
        uint256 indexed tokenId,
        bytes32 indexed recordCommitment,
        address indexed holder,
        uint64 version,
        uint64 effectiveAt
    );

    event RegisterSuperseded(
        uint256 indexed tokenId,
        uint64 indexed version,
        bytes32 indexed recordCommitment,
        bytes32 previousCommitment,
        address holder,
        uint64 effectiveAt
    );

    function currentEntry(uint256 tokenId)
        external view returns (RegisterEntry memory entry);

    function entryAt(uint256 tokenId, uint64 version)
        external view returns (RegisterEntry memory entry);

    function entryAsOf(uint256 tokenId, uint64 instant)
        external view returns (RegisterEntry memory entry);

    function holderAsOf(uint256 tokenId, uint64 instant)
        external view returns (address holder);

    function isFinalAsOf(uint256 tokenId, uint64 instant)
        external view returns (bool settled);

    function entryCount(uint256 tokenId)
        external view returns (uint64 count);

    function registerId() external view returns (bytes32 identifier);
}
