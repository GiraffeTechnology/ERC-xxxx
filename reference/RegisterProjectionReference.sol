// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

// Reference proof profile - trust assumptions and non-goals.
//
// This file demonstrates the projection invariants. It is not a production
// light client. An implementer copying it inherits the following limits,
// which the specification assigns to the verification profile:
//
// 1. Validator equivocation is not detected. lastRemoteHeight is tracked per
//    token and usedProofs keys on (checkpoint, leaf), so a quorum that signs
//    two different state roots at the same remote height can admit entries
//    for different tokens from different forks without the contract noticing.
// 2. The validator set is immutable. isFinalityValidator, validatorSetHash
//    and finalityThreshold are fixed at construction, so a compromised
//    validator key remains valid for the life of the contract. The only
//    recovery path is cancellation after the settlement deadline.
// 3. siblings and signatures are unbounded. Oversized input costs the
//    submitter gas only; the strictly increasing signer rule caps the number
//    of accepted signatures at the validator set size.
// 4. The settlement authority is a single immutable registrar address. It is
//    the party that can advance the projection, and equally the party that can
//    withhold it by holding a gap open. A production profile SHOULD scope this
//    to the party responsible for the remote register and SHOULD bound
//    supersession. It is deliberately NOT derived from ownerOf: the projection
//    records the register's holder, and a registrar that cannot open a gap
//    cannot record its own changes.
//
// Where the remote register is itself a ledger with consensus, production
// profiles SHOULD use its native light client and validator-set transition
// rules. Many registers are not: a share registrar or a title office has no
// consensus and no state root. There the validator set below is not a
// consensus at all but an attestation quorum - an oracle - and the proof
// establishes what that quorum committed to, not that the register said it.
// Profiles MUST disclose the verifier, the attesting party and any upgrade
// authority as part of the security boundary.

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721 is IERC165 {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external returns (bytes4);
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

    function currentEntry(uint256 tokenId) external view returns (RegisterEntry memory entry);
    function entryAt(uint256 tokenId, uint64 version) external view returns (RegisterEntry memory entry);
    function entryAsOf(uint256 tokenId, uint64 instant) external view returns (RegisterEntry memory entry);
    function holderAsOf(uint256 tokenId, uint64 instant) external view returns (address holder);
    function isFinalAsOf(uint256 tokenId, uint64 instant) external view returns (bool settled);
    function entryCount(uint256 tokenId) external view returns (uint64 count);
    function registerId() external view returns (bytes32 identifier);
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

    function settlement(bytes32 settlementId) external view returns (Settlement memory record);
    function openGapOf(uint256 tokenId) external view returns (bytes32 settlementId);
    function settlementPeriod() external view returns (uint64 maximumInterval);
    function verificationProfile() external view returns (bytes32 identifier);
    function isSettlementAuthority(uint256 tokenId, address account) external view returns (bool authorized);
    function beginSettlement(uint256 tokenId, bytes32 settlementId, address expectedHolder, bytes32 snapshotHash, uint64 deadline) external;
    function finalizeSettlement(bytes32 settlementId, bytes32 recordCommitment, bytes32 registryReference, uint64 effectiveAt, bytes calldata proofData) external;
    function cancelSettlement(bytes32 settlementId, bytes32 reasonHash) external;
}

contract RegisterProjectionReference is IERC721, IRegisterProjection, IProjectionSettlement {
    error Unauthorized();
    error InvalidAddress();
    error TokenNotFound();
    error InvalidEntry();
    error EffectiveAtNotIncreasing();
    error CommitmentReused();
    error NoEntryAsOf();
    error InvalidSettlement();
    error SettlementExists();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error DeadlineTooFar();
    error InvalidProof();
    error ProofAlreadyUsed();
    error StaleRemoteHeight();
    error UnsafeRecipient();
    error EffectiveAtTooFar();

    bytes4 private constant _ERC165_ID = 0x01ffc9a7;
    bytes4 private constant _ERC721_ID = 0x80ac58cd;
    bytes4 private constant _ERC721_RECEIVED = 0x150b7a02;
    uint256 private constant _HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    bytes32 public constant REMOTE_FINALITY_TYPEHASH = keccak256(
        "RemoteFinality(bytes32 remoteRegisterId,uint64 remoteHeight,bytes32 remoteBlockHash,bytes32 remoteStateRoot,bytes32 validatorSetHash)"
    );
    bytes32 public constant REMOTE_ENTRY_LEAF_TYPEHASH = keccak256(
        "RemoteEntry(uint256 localChainId,address localContract,uint256 tokenId,bytes32 settlementId,address holder,bytes32 snapshotHash,bytes32 previousCommitment,bytes32 recordCommitment,bytes32 registryReference,uint64 version,uint64 effectiveAt)"
    );

    uint64 public constant MAX_SETTLEMENT_PERIOD = 30 days;

    // An effective time far ahead of the present permanently ends the projection
    // for a token, because effectiveAt strictly increases and no later entry
    // could exceed it. The reference profile bounds it; a profile MAY differ.
    uint64 public constant MAX_EFFECTIVE_AHEAD = 30 days;

    // Merkle domain separation. Without distinct tags an internal node and a
    // leaf share a preimage shape, which is the classic second-preimage case.
    bytes1 private constant _LEAF_TAG = 0x00;
    bytes1 private constant _NODE_TAG = 0x01;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant _EIP712_NAME_HASH = keccak256("AsynchronousRegisterProjection");
    bytes32 private constant _EIP712_VERSION_HASH = keccak256("1");

    // Identifies the proof rules this contract accepts, so that a party can tell
    // whether it knows how to check them. It changes when those rules change.
    bytes32 public constant VERIFICATION_PROFILE =
        keccak256("erc-xxxx/reference-profile/fixed-validator-set+eip712+tagged-keccak-merkle/v2");

    address public immutable administrator;
    // The settlement authority. Deliberately distinct from ownerOf: see the
    // header note. A profile defines the policy; this reference uses one
    // immutable address for the whole contract.
    address public immutable registrar;
    bytes32 public immutable remoteRegisterId;
    bytes32 public immutable validatorSetHash;
    uint8 public immutable finalityThreshold;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    mapping(address => bool) public isFinalityValidator;
    mapping(uint256 => uint64) public lastRemoteHeight;
    mapping(bytes32 => bool) public usedProofs;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approvals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    mapping(uint256 => RegisterEntry[]) private _entries;
    mapping(uint256 => mapping(bytes32 => bool)) private _commitmentUsed;
    mapping(bytes32 => Settlement) private _settlements;
    mapping(uint256 => bytes32) private _openGap;

    constructor(bytes32 remoteRegisterId_, address registrar_, address[] memory validators_, uint8 threshold_) {
        if (remoteRegisterId_ == bytes32(0) || threshold_ == 0 || threshold_ > validators_.length) {
            revert InvalidProof();
        }
        if (registrar_ == address(0)) revert InvalidAddress();
        administrator = msg.sender;
        registrar = registrar_;
        remoteRegisterId = remoteRegisterId_;
        finalityThreshold = threshold_;
        address previous;
        for (uint256 i; i < validators_.length; ++i) {
            address validator = validators_[i];
            if (validator == address(0) || validator <= previous) revert InvalidProof();
            isFinalityValidator[validator] = true;
            previous = validator;
        }
        validatorSetHash = keccak256(abi.encode(validators_, threshold_));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // EIP-712 domain, rebuilt if the chain id changes under the contract.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH, _EIP712_NAME_HASH, _EIP712_VERSION_HASH, block.chainid, address(this)
            )
        );
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == _ERC165_ID
            || interfaceId == _ERC721_ID
            || interfaceId == type(IRegisterProjection).interfaceId
            || interfaceId == type(IProjectionSettlement).interfaceId;
    }

    function mint(
        address to,
        uint256 tokenId,
        bytes32 recordCommitment,
        bytes32 registryReference,
        uint64 effectiveAt
    ) external {
        if (msg.sender != administrator) revert Unauthorized();
        if (to == address(0)) revert InvalidAddress();
        if (_owners[tokenId] != address(0) || recordCommitment == bytes32(0)) revert InvalidEntry();
        if (effectiveAt > block.timestamp + MAX_EFFECTIVE_AHEAD) revert EffectiveAtTooFar();

        _owners[tokenId] = to;
        _balances[to] += 1;
        _commitmentUsed[tokenId][recordCommitment] = true;
        _entries[tokenId].push(
            RegisterEntry(recordCommitment, bytes32(0), registryReference, to, 1, effectiveAt, 0)
        );
        emit Transfer(address(0), to, tokenId);
        emit RegisterInitialized(tokenId, recordCommitment, to, 1, effectiveAt);
    }

    // --- ERC-721. Trading is never blocked by an open gap. ---

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert InvalidAddress();
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _owners[tokenId];
        if (owner == address(0)) revert TokenNotFound();
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) revert Unauthorized();
        _approvals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert InvalidAddress();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _approvals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (!_isAuthorized(msg.sender, tokenId)) revert Unauthorized();
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 result) {
                if (result != _ERC721_RECEIVED) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    // --- Projection ---

    function entryCount(uint256 tokenId) external view returns (uint64) {
        ownerOf(tokenId);
        return uint64(_entries[tokenId].length);
    }

    function currentEntry(uint256 tokenId) external view returns (RegisterEntry memory) {
        ownerOf(tokenId);
        return _entries[tokenId][_entries[tokenId].length - 1];
    }

    function entryAt(uint256 tokenId, uint64 version) external view returns (RegisterEntry memory) {
        ownerOf(tokenId);
        if (version == 0 || version > _entries[tokenId].length) revert InvalidEntry();
        return _entries[tokenId][version - 1];
    }

    function entryAsOf(uint256 tokenId, uint64 instant) public view returns (RegisterEntry memory) {
        ownerOf(tokenId);
        RegisterEntry[] storage list = _entries[tokenId];
        if (instant < list[0].effectiveAt) revert NoEntryAsOf();
        uint256 low;
        uint256 high = list.length - 1;
        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            if (list[mid].effectiveAt <= instant) low = mid;
            else high = mid - 1;
        }
        return list[low];
    }

    function holderAsOf(uint256 tokenId, uint64 instant) external view returns (address) {
        return entryAsOf(tokenId, instant).holder;
    }

    // An instant is final exactly when a later entry already exists, because
    // effectiveAt strictly increases: no entry admitted afterwards can ever
    // carry an effective time low enough to cover it.
    function isFinalAsOf(uint256 tokenId, uint64 instant) public view returns (bool) {
        ownerOf(tokenId);
        RegisterEntry[] storage list = _entries[tokenId];
        return instant >= list[0].effectiveAt && instant < list[list.length - 1].effectiveAt;
    }

    function registerId() external view returns (bytes32) {
        return remoteRegisterId;
    }

    // --- Settlement ---

    function settlementPeriod() external pure returns (uint64) {
        return MAX_SETTLEMENT_PERIOD;
    }

    function verificationProfile() external pure returns (bytes32) {
        return VERIFICATION_PROFILE;
    }

    function settlement(bytes32 id) external view returns (Settlement memory record) {
        record = _settlements[id];
        if (record.status == GapStatus.NONE) revert InvalidSettlement();
    }

    function openGapOf(uint256 tokenId) external view returns (bytes32) {
        ownerOf(tokenId);
        return _openGap[tokenId];
    }

    // Who may open a gap on this token. A third party can read it, which is the
    // point: a projection whose authority is unknown tells an unrelated venue
    // very little about who can move the answer.
    function isSettlementAuthority(uint256 tokenId, address account) public view returns (bool) {
        ownerOf(tokenId);
        return account == registrar;
    }

    function beginSettlement(
        uint256 tokenId,
        bytes32 id,
        address expectedHolder,
        bytes32 snapshot,
        uint64 deadline
    ) external {
        if (!isSettlementAuthority(tokenId, msg.sender)) revert Unauthorized();
        if (id == bytes32(0) || snapshot == bytes32(0)) revert InvalidSettlement();
        if (_settlements[id].status != GapStatus.NONE) revert SettlementExists();
        // An expectedHolder equal to the confirmed holder is deliberately allowed:
        // it admits a confirming entry, which is what makes earlier instants final
        // on a token whose holder is not changing.
        if (expectedHolder == address(0)) revert InvalidAddress();
        if (deadline <= block.timestamp) revert DeadlinePassed();
        if (uint256(deadline) - block.timestamp > MAX_SETTLEMENT_PERIOD) revert DeadlineTooFar();

        bytes32 open = _openGap[tokenId];
        if (open != bytes32(0)) {
            _settlements[open].status = GapStatus.SUPERSEDED;
            emit SettlementSuperseded(open, id, tokenId);
        }
        _settlements[id] = Settlement(
            tokenId, msg.sender, expectedHolder, snapshot, uint64(block.timestamp), deadline, GapStatus.OPEN
        );
        _openGap[tokenId] = id;
        emit SettlementStarted(id, tokenId, msg.sender, expectedHolder, snapshot, deadline);
    }

    function finalizeSettlement(
        bytes32 id,
        bytes32 recordCommitment,
        bytes32 registryReference,
        uint64 effectiveAt,
        bytes calldata proofData
    ) external {
        Settlement storage item = _settlements[id];
        if (item.status != GapStatus.OPEN) revert InvalidSettlement();
        if (block.timestamp > item.deadline) revert DeadlinePassed();
        if (recordCommitment == bytes32(0)) revert InvalidEntry();

        RegisterEntry[] storage list = _entries[item.tokenId];
        RegisterEntry storage previous = list[list.length - 1];
        if (effectiveAt <= previous.effectiveAt) revert EffectiveAtNotIncreasing();
        if (effectiveAt > block.timestamp + MAX_EFFECTIVE_AHEAD) revert EffectiveAtTooFar();
        if (_commitmentUsed[item.tokenId][recordCommitment]) revert CommitmentReused();

        uint64 nextVersion = uint64(list.length) + 1;
        (
            uint64 height,
            bytes32 blockHash,
            bytes32 root,
            uint256 leafIndex,
            bytes32[] memory siblings,
            bytes[] memory signatures
        ) = abi.decode(proofData, (uint64, bytes32, bytes32, uint256, bytes32[], bytes[]));
        if (height <= lastRemoteHeight[item.tokenId]) revert StaleRemoteHeight();

        bytes32 leafStruct = keccak256(
            abi.encode(
                REMOTE_ENTRY_LEAF_TYPEHASH,
                block.chainid,
                address(this),
                item.tokenId,
                id,
                item.expectedHolder,
                item.snapshotHash,
                previous.recordCommitment,
                recordCommitment,
                registryReference,
                nextVersion,
                effectiveAt
            )
        );
        bytes32 leaf = keccak256(abi.encodePacked(_LEAF_TAG, leafStruct));
        if (!_verifyMembership(leaf, leafIndex, siblings, root)) revert InvalidProof();
        bytes32 finality = keccak256(
            abi.encodePacked(
                hex"1901",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        REMOTE_FINALITY_TYPEHASH, remoteRegisterId, height, blockHash, root, validatorSetHash
                    )
                )
            )
        );
        _verifyFinality(finality, signatures);
        bytes32 proofId = keccak256(abi.encode(finality, leaf));
        if (usedProofs[proofId]) revert ProofAlreadyUsed();

        usedProofs[proofId] = true;
        lastRemoteHeight[item.tokenId] = height;
        previous.supersededAt = effectiveAt;
        _commitmentUsed[item.tokenId][recordCommitment] = true;
        list.push(
            RegisterEntry(
                recordCommitment,
                previous.recordCommitment,
                registryReference,
                item.expectedHolder,
                nextVersion,
                effectiveAt,
                0
            )
        );
        item.status = GapStatus.ADMITTED;
        delete _openGap[item.tokenId];

        emit RegisterSuperseded(
            item.tokenId, nextVersion, recordCommitment, previous.recordCommitment, item.expectedHolder, effectiveAt
        );
        emit SettlementFinalized(id, item.tokenId, recordCommitment, nextVersion, effectiveAt);
    }

    function cancelSettlement(bytes32 id, bytes32 reason) external {
        Settlement storage item = _settlements[id];
        if (item.status != GapStatus.OPEN) revert InvalidSettlement();
        if (msg.sender != item.initiator) revert Unauthorized();
        // The window up to the deadline belongs to the proof. Cancelling earlier
        // would let the initiator strand a record the remote register already
        // finalized, leaving the projection permanently unresolvable for that gap.
        if (block.timestamp <= item.deadline) revert DeadlineNotPassed();
        item.status = GapStatus.CANCELLED;
        delete _openGap[item.tokenId];
        emit SettlementCancelled(id, item.tokenId, reason);
    }

    // --- internals ---

    function _isAuthorized(address caller, uint256 tokenId) private view returns (bool) {
        address owner = ownerOf(tokenId);
        return caller == owner || caller == _approvals[tokenId] || _operatorApprovals[owner][caller];
    }

    function _transfer(address from, address to, uint256 tokenId) private {
        if (to == address(0)) revert InvalidAddress();
        if (ownerOf(tokenId) != from) revert Unauthorized();
        delete _approvals[tokenId];
        _owners[tokenId] = to;
        _balances[from] -= 1;
        _balances[to] += 1;
        emit Transfer(from, to, tokenId);
    }

    function _verifyMembership(bytes32 leaf, uint256 index, bytes32[] memory siblings, bytes32 root)
        private pure returns (bool)
    {
        bytes32 value = leaf;
        for (uint256 i; i < siblings.length; ++i) {
            value = index & 1 == 0
                ? keccak256(abi.encodePacked(_NODE_TAG, value, siblings[i]))
                : keccak256(abi.encodePacked(_NODE_TAG, siblings[i], value));
            index >>= 1;
        }
        // Index bits beyond the path length must be zero, otherwise several
        // (index, siblings) pairs verify against the same root.
        return index == 0 && value == root;
    }

    function _verifyFinality(bytes32 digest, bytes[] memory signatures) private view {
        if (signatures.length < finalityThreshold) revert InvalidProof();
        address previous;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = _recover(digest, signatures[i]);
            if (!isFinalityValidator[signer] || signer <= previous) revert InvalidProof();
            previous = signer;
        }
    }

    function _recover(bytes32 digest, bytes memory signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidProof();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > _HALF_ORDER) revert InvalidProof();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidProof();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidProof();
    }
}
