const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const hre = require("hardhat");
const { ethers } = hre;

const hardhatRequire = createRequire(require.resolve("hardhat/package.json"));
const solc = hardhatRequire("solc");
const source = path.resolve(__dirname, "../reference/RegisterProjectionReference.sol");

const b32 = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));
const coder = ethers.AbiCoder.defaultAbiCoder();

const LEAF_TYPE = b32(
  "RemoteEntry(uint256 localChainId,address localContract,uint256 tokenId,bytes32 settlementId,address holder,bytes32 snapshotHash,bytes32 previousCommitment,bytes32 recordCommitment,bytes32 registryReference,uint64 version,uint64 effectiveAt)"
);
const FINALITY_TYPE = b32(
  "RemoteFinality(bytes32 remoteRegisterId,uint64 remoteHeight,bytes32 remoteBlockHash,bytes32 remoteStateRoot,bytes32 validatorSetHash)"
);

function compile() {
  const input = {
    language: "Solidity",
    sources: { "a.sol": { content: fs.readFileSync(source, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  assert.equal(errors.length, 0, errors.map((e) => e.formattedMessage).join("\n"));
  const warnings = (output.errors || []).filter((e) => e.severity === "warning");
  assert.equal(warnings.length, 0, warnings.map((e) => e.formattedMessage).join("\n"));
  return output.contracts["a.sol"];
}

function interfaceId(abi) {
  const iface = new ethers.Interface(abi);
  let value = 0n;
  for (const f of iface.fragments) {
    if (f.type === "function" && f.name !== "supportsInterface") value ^= BigInt(f.selector);
  }
  return ethers.toBeHex(value, 4);
}

describe("Asynchronous register projection", function () {
  this.timeout(120000);

  const tokenId = 1n;
  const registerId = b32("remote-register/genesis/v1");
  const c1 = b32("commitment-v1");
  const c2 = b32("commitment-v2");
  const ref1 = b32("reference-v1");
  const ref2 = b32("reference-v2");
  const snapshot = b32("snapshot-1");
  const settlementId = b32("settlement-1");
  const E1 = 1000n;

  let compiled, contract, admin, owner, buyer, outsider, registrar, validators, setHash, deadline;
  let domainSeparator;

  before(() => { compiled = compile(); });

  beforeEach(async () => {
    [admin, owner, buyer, outsider, registrar] = await ethers.getSigners();
    validators = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()]
      .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
    const addresses = validators.map((v) => v.address);
    setHash = ethers.keccak256(coder.encode(["address[]", "uint8"], [addresses, 2]));
    const artifact = compiled.RegisterProjectionReference;
    contract = await new ethers.ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, admin)
      .deploy(registerId, registrar.address, addresses, 2);
    await contract.waitForDeployment();
    await contract.mint(owner.address, tokenId, c1, ref1, E1);
    deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    domainSeparator = await contract.DOMAIN_SEPARATOR();
  });

  async function rejects(promise, name) {
    const selector = contract.interface.getError(name).selector.toLowerCase();
    try { await promise; assert.fail(`expected ${name}`); }
    catch (error) { assert.ok(JSON.stringify(error).toLowerCase().includes(selector.slice(2)), `expected ${name}, got ${error.message}`); }
  }

  const begin = (id = settlementId, holder = buyer.address, snap = snapshot, dl = deadline, signer = registrar) =>
    contract.connect(signer).beginSettlement(tokenId, id, holder, snap, dl);

  async function proof(o = {}) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const v = {
      chainId: o.chainId ?? chainId,
      target: o.target ?? (await contract.getAddress()),
      tokenId: o.tokenId ?? tokenId,
      settlementId: o.settlementId ?? settlementId,
      holder: o.holder ?? buyer.address,
      snapshot: o.snapshot ?? snapshot,
      previous: o.previous ?? c1,
      commitment: o.commitment ?? c2,
      reference: o.reference ?? ref2,
      version: o.version ?? 2n,
      effectiveAt: o.effectiveAt ?? 2000n
    };
    const leafStruct = ethers.keccak256(coder.encode(
      ["bytes32", "uint256", "address", "uint256", "bytes32", "address", "bytes32", "bytes32", "bytes32", "bytes32", "uint64", "uint64"],
      [LEAF_TYPE, v.chainId, v.target, v.tokenId, v.settlementId, v.holder, v.snapshot, v.previous, v.commitment, v.reference, v.version, v.effectiveAt]
    ));
    const leaf = ethers.keccak256(ethers.concat(["0x00", leafStruct]));
    const siblings = o.siblings || [];
    let index = o.index || 0n;
    let root = leaf;
    let walk = index;
    for (const s of siblings) {
      root = (walk & 1n) === 0n
        ? ethers.keccak256(ethers.concat(["0x01", root, s]))
        : ethers.keccak256(ethers.concat(["0x01", s, root]));
      walk >>= 1n;
    }
    root = o.root ?? root;
    const height = o.height ?? 10n;
    const blockHash = o.blockHash ?? b32("remote-block-10");
    const structHash = ethers.keccak256(coder.encode(
      ["bytes32", "bytes32", "uint64", "bytes32", "bytes32", "bytes32"],
      [FINALITY_TYPE, o.digestRegisterId ?? registerId, height, blockHash, root, o.digestSetHash ?? setHash]
    ));
    const digest = ethers.keccak256(ethers.concat(["0x1901", o.domain ?? domainSeparator, structHash]));
    const signers = o.signers || validators.slice(0, 2);
    const signatures = signers.map((w) => ethers.Signature.from(w.signingKey.sign(digest)).serialized);
    return coder.encode(
      ["uint64", "bytes32", "bytes32", "uint256", "bytes32[]", "bytes[]"],
      [height, blockHash, root, index, siblings, signatures]
    );
  }

  const finalize = (data, o = {}) =>
    contract.finalizeSettlement(o.id ?? settlementId, o.commitment ?? c2, o.reference ?? ref2, o.effectiveAt ?? 2000n, data);

  async function advance(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  it("exposes deterministic interface identifiers", async () => {
    const projection = interfaceId(compiled.IRegisterProjection.abi);
    const settlement = interfaceId(compiled.IProjectionSettlement.abi);
    assert.equal(projection, "0x6309e170");
    assert.equal(settlement, "0xf4a7d71b");
    assert.notEqual(projection, settlement);
    assert.equal(await contract.supportsInterface("0x01ffc9a7"), true);
    assert.equal(await contract.supportsInterface("0x80ac58cd"), true);
    assert.equal(await contract.supportsInterface(projection), true);
    assert.equal(await contract.supportsInterface(settlement), true);
    assert.equal(await contract.supportsInterface("0xffffffff"), false);
  });

  it("advertises a stable register and verification profile identity", async () => {
    assert.equal(await contract.registerId(), registerId);
    const profile = await contract.verificationProfile();
    assert.notEqual(profile, ethers.ZeroHash);
    await begin();
    await finalize(await proof());
    assert.equal(await contract.registerId(), registerId);
    assert.equal(await contract.verificationProfile(), profile);
  });

  it("keeps reference runtime bytecode below the EIP-170 limit", () => {
    const size = compiled.RegisterProjectionReference.evm.deployedBytecode.object.length / 2;
    assert.ok(size > 0 && size < 24576, `runtime bytecode is ${size} bytes`);
  });

  it("initializes version 1 and reports the confirmed holder", async () => {
    const entry = await contract.currentEntry(tokenId);
    assert.equal(entry.version, 1n);
    assert.equal(entry.recordCommitment, c1);
    assert.equal(entry.previousCommitment, ethers.ZeroHash);
    assert.equal(entry.holder, owner.address);
    assert.equal(await contract.entryCount(tokenId), 1n);
  });

  it("rejects an entry whose effectiveAt equals the preceding entry", async () => {
    await begin();
    await rejects(finalize(await proof({ effectiveAt: E1 }), { effectiveAt: E1 }), "EffectiveAtNotIncreasing");
  });

  it("rejects a repeated record commitment within a token", async () => {
    await begin();
    await rejects(finalize(await proof({ commitment: c1 }), { commitment: c1 }), "CommitmentReused");
  });

  it("resolves entryAsOf across interval boundaries and reverts before the first entry", async () => {
    await begin();
    await finalize(await proof());
    assert.equal((await contract.entryAsOf(tokenId, E1)).version, 1n);
    assert.equal((await contract.entryAsOf(tokenId, 1999n)).version, 1n);
    assert.equal((await contract.entryAsOf(tokenId, 2000n)).version, 2n);
    assert.equal((await contract.entryAsOf(tokenId, 9999n)).version, 2n);
    await rejects(contract.entryAsOf(tokenId, E1 - 1n), "NoEntryAsOf");
  });

  it("holderAsOf agrees with entryAsOf", async () => {
    await begin();
    await finalize(await proof());
    assert.equal(await contract.holderAsOf(tokenId, 1500n), owner.address);
    assert.equal(await contract.holderAsOf(tokenId, 2500n), buyer.address);
  });

  it("allows ordinary transfers while a gap is open and leaves the projection unchanged", async () => {
    await begin();
    await contract.connect(owner).transferFrom(owner.address, outsider.address, tokenId);
    assert.equal(await contract.ownerOf(tokenId), outsider.address);
    assert.equal((await contract.currentEntry(tokenId)).holder, owner.address);
    assert.equal((await contract.currentEntry(tokenId)).version, 1n);
    assert.notEqual(await contract.openGapOf(tokenId), ethers.ZeroHash);
  });

  it("supersedes an open gap when a later settlement begins", async () => {
    await begin();
    const replacement = b32("settlement-2");
    await contract.connect(registrar).beginSettlement(tokenId, replacement, outsider.address, b32("snapshot-2"), deadline);
    assert.equal((await contract.settlement(settlementId)).status, 4n);
    assert.equal(await contract.openGapOf(tokenId), replacement);
    assert.equal((await contract.currentEntry(tokenId)).version, 1n);
  });

  it("admits a valid proof atomically", async () => {
    await begin();
    const receipt = await (await finalize(await proof())).wait();
    const names = receipt.logs.map((l) => { try { return contract.interface.parseLog(l)?.name; } catch { return undefined; } });
    assert.ok(names.includes("RegisterSuperseded"));
    assert.ok(names.includes("SettlementFinalized"));
    const entry = await contract.currentEntry(tokenId);
    assert.equal(entry.version, 2n);
    assert.equal(entry.holder, buyer.address);
    assert.equal(entry.previousCommitment, c1);
    assert.equal((await contract.entryAt(tokenId, 1)).supersededAt, 2000n);
    assert.equal(await contract.openGapOf(tokenId), ethers.ZeroHash);
  });

  it("rejects mutation of every bound leaf field", async () => {
    const mutations = [
      { chainId: 999n }, { target: outsider.address }, { tokenId: 2n },
      { settlementId: b32("other") }, { holder: outsider.address }, { snapshot: b32("other-snapshot") },
      { previous: b32("other-previous") }, { commitment: b32("other-commitment") },
      { reference: b32("other-reference") },
      { version: 3n }, { effectiveAt: 2500n }
    ];
    for (const [index, mutation] of mutations.entries()) {
      const id = b32(`mutation-${index}`);
      await begin(id);
      await rejects(finalize(await proof({ ...mutation, settlementId: mutation.settlementId ?? id }), { id }), "InvalidProof");
    }
  });

  it("rejects a checkpoint from another register or validator set", async () => {
    await begin();
    await rejects(finalize(await proof({ digestRegisterId: b32("other-register") })), "InvalidProof");
    await rejects(finalize(await proof({ digestSetHash: b32("other-set") })), "InvalidProof");
  });

  it("rejects non-validator, duplicate and insufficient signatures", async () => {
    await begin();
    const stranger = ethers.Wallet.createRandom();
    await rejects(finalize(await proof({ signers: [validators[0], stranger].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())) })), "InvalidProof");
    await rejects(finalize(await proof({ signers: [validators[0], validators[0]] })), "InvalidProof");
    await rejects(finalize(await proof({ signers: [validators[0]] })), "InvalidProof");
  });

  it("rejects a replayed proof and a stale remote height", async () => {
    await begin();
    const data = await proof();
    await finalize(data);
    await contract.connect(registrar).beginSettlement(tokenId, b32("settlement-3"), outsider.address, b32("snapshot-3"), deadline);
    await rejects(
      contract.finalizeSettlement(b32("settlement-3"), b32("commitment-v3"), ref2, 3000n, await proof({ settlementId: b32("settlement-3"), holder: outsider.address, snapshot: b32("snapshot-3"), previous: c2, commitment: b32("commitment-v3"), version: 3n, effectiveAt: 3000n, height: 5n })),
      "StaleRemoteHeight"
    );
  });

  it("accepts an ordered Merkle path", async () => {
    await begin();
    await finalize(await proof({ siblings: [b32("other-leaf")] }));
    assert.equal((await contract.currentEntry(tokenId)).version, 2n);
  });

  it("rejects cancellation before the deadline and accepts it after", async () => {
    await begin();
    await rejects(contract.connect(registrar).cancelSettlement(settlementId, b32("abandon")), "DeadlineNotPassed");
    await advance(7200);
    await contract.connect(registrar).cancelSettlement(settlementId, b32("timeout"));
    assert.equal((await contract.settlement(settlementId)).status, 3n);
    assert.equal((await contract.currentEntry(tokenId)).version, 1n);
    assert.equal(await contract.openGapOf(tokenId), ethers.ZeroHash);
  });

  it("admits a proof within the deadline after a rejected cancellation attempt", async () => {
    await begin();
    await rejects(contract.connect(registrar).cancelSettlement(settlementId, b32("abandon")), "DeadlineNotPassed");
    await finalize(await proof());
    assert.equal((await contract.currentEntry(tokenId)).holder, buyer.address);
    assert.equal((await contract.settlement(settlementId)).status, 2n);
  });

  it("rejects finalization after the deadline and cancellation by others", async () => {
    await begin();
    await rejects(contract.connect(outsider).cancelSettlement(settlementId, b32("x")), "Unauthorized");
    await advance(7200);
    await rejects(finalize(await proof()), "DeadlinePassed");
  });

  it("rejects a deadline beyond the settlement period and a non-future deadline", async () => {
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    await rejects(begin(b32("far"), buyer.address, snapshot, now + 60n * 60n * 24n * 40n), "DeadlineTooFar");
    await rejects(begin(b32("past"), buyer.address, snapshot, now), "DeadlinePassed");
    assert.equal(await contract.settlementPeriod(), 2592000n);
  });

  it("admits a confirming entry naming the current confirmed holder", async () => {
    await begin(b32("confirm"), owner.address);
    await contract.finalizeSettlement(b32("confirm"), c2, ref2, 2000n, await proof({
      settlementId: b32("confirm"), holder: owner.address, snapshot: snapshot
    }));
    const entry = await contract.currentEntry(tokenId);
    assert.equal(entry.version, 2n);
    assert.equal(entry.holder, owner.address);
    // The confirming entry is what makes the preceding interval final.
    assert.equal(await contract.isFinalAsOf(tokenId, 1999n), true);
    assert.equal(await contract.holderAsOf(tokenId, 1999n), owner.address);
  });

  it("reverts settlement queries for unknown identifiers and returns zero for no open gap", async () => {
    await rejects(contract.settlement(b32("unknown")), "InvalidSettlement");
    assert.equal(await contract.openGapOf(tokenId), ethers.ZeroHash);
  });

  it("maintains a strictly increasing append-only projection over repeated admissions", async () => {
    let previous = c1;
    let holder = owner.address;
    for (let i = 0; i < 4; i += 1) {
      const id = b32(`chain-${i}`);
      const next = b32(`chain-commitment-${i}`);
      const to = i % 2 === 0 ? buyer.address : outsider.address;
      await contract.connect(registrar).beginSettlement(tokenId, id, to, b32(`chain-snapshot-${i}`), BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600));
      const version = BigInt(i + 2);
      const effectiveAt = 2000n + BigInt(i) * 1000n;
      await contract.finalizeSettlement(id, next, ref2, effectiveAt, await proof({
        settlementId: id, holder: to, snapshot: b32(`chain-snapshot-${i}`),
        previous, commitment: next, version, effectiveAt, height: 20n + BigInt(i)
      }));
      const entry = await contract.currentEntry(tokenId);
      assert.equal(entry.version, version);
      assert.equal(entry.previousCommitment, previous);
      assert.equal(entry.holder, to);
      previous = next;
      holder = to;
    }
    for (let v = 1; v <= 5; v += 1) {
      const entry = await contract.entryAt(tokenId, v);
      assert.equal(entry.version, BigInt(v));
      if (v > 1) assert.ok(entry.effectiveAt > (await contract.entryAt(tokenId, v - 1)).effectiveAt);
    }
    assert.equal(await contract.holderAsOf(tokenId, 4999n), buyer.address);
  });

  // --- finality ---

  it("reports finality only for instants a later entry already covers", async () => {
    assert.equal(await contract.isFinalAsOf(tokenId, 999n), false, "before the first entry");
    assert.equal(await contract.isFinalAsOf(tokenId, E1), false, "only one entry exists");
    assert.equal(await contract.isFinalAsOf(tokenId, 5000n), false);
    await begin();
    assert.equal(await contract.isFinalAsOf(tokenId, E1), false, "an open gap admits nothing by itself");
    await finalize(await proof());
    assert.equal(await contract.isFinalAsOf(tokenId, 999n), false, "still before the first entry");
    assert.equal(await contract.isFinalAsOf(tokenId, E1), true);
    assert.equal(await contract.isFinalAsOf(tokenId, 1999n), true);
    assert.equal(await contract.isFinalAsOf(tokenId, 2000n), false, "at the latest effectiveAt");
    assert.equal(await contract.isFinalAsOf(tokenId, 9999n), false);
  });

  it("never changes the confirmed holder at an instant that is already final", async () => {
    await begin();
    await finalize(await proof());
    assert.equal(await contract.isFinalAsOf(tokenId, 1500n), true);
    const settled = await contract.holderAsOf(tokenId, 1500n);
    // Authorization follows the ERC-721 owner, which the projection has not moved.
    await contract.connect(registrar).beginSettlement(tokenId, b32("later"), outsider.address, b32("later-snapshot"), deadline);
    await contract.finalizeSettlement(b32("later"), b32("commitment-v3"), ref2, 2500n, await proof({
      settlementId: b32("later"), holder: outsider.address, snapshot: b32("later-snapshot"),
      previous: c2, commitment: b32("commitment-v3"), version: 3n, effectiveAt: 2500n, height: 11n
    }));
    assert.equal(await contract.holderAsOf(tokenId, 1500n), settled);
    // A non-final instant, by contrast, was free to move.
    assert.equal(await contract.holderAsOf(tokenId, 2400n), buyer.address);
    assert.equal(await contract.holderAsOf(tokenId, 2600n), outsider.address);
  });

  it("distinguishes a contested instant from a merely non-final one", async () => {
    // Contested = a gap is open and it opened at or before the instant.
    // Non-final = no later entry exists yet. The present moment is almost
    // always the second, which is why perishable rights cannot be gated on it.
    const contestedAt = async (instant) => {
      const gap = await contract.openGapOf(tokenId);
      if (gap === ethers.ZeroHash) return false;
      return (await contract.settlement(gap)).openedAt <= instant;
    };
    const now = () => ethers.provider.getBlock("latest").then((b) => BigInt(b.timestamp));

    assert.equal(await contract.isFinalAsOf(tokenId, await now()), false, "the present is not final");
    assert.equal(await contestedAt(await now()), false, "but nothing is contested yet");

    await begin();
    const opened = (await contract.settlement(settlementId)).openedAt;
    assert.equal(await contestedAt(opened), true);
    assert.equal(await contestedAt(opened - 1n), false, "the contest does not reach before the gap opened");

    await advance(4000);
    await contract.connect(registrar).cancelSettlement(settlementId, b32("abandoned"));
    assert.equal(await contestedAt(await now()), false, "cancelling ends the contest");
    assert.equal(await contract.isFinalAsOf(tokenId, await now()), false, "but settles nothing");
  });

  it("cannot advance the projection while no gap is open", async () => {
    // An entry enters only through an open gap, so a window with no gap open
    // and none begun is a window the projection cannot move in at all.
    const data = await proof();
    await rejects(finalize(data), "InvalidSettlement");
    assert.equal(await contract.openGapOf(tokenId), ethers.ZeroHash);

    await begin();
    await finalize(await proof());
    const settled = await contract.currentEntry(tokenId);
    // Admitted, cancelled and superseded gaps are all closed: none readmits.
    await rejects(finalize(await proof()), "InvalidSettlement");
    await begin(b32("to-cancel"), outsider.address);
    await advance(4000);
    await contract.connect(registrar).cancelSettlement(b32("to-cancel"), b32("done"));
    await rejects(finalize(await proof(), { id: b32("to-cancel") }), "InvalidSettlement");
    await begin(b32("first"), outsider.address, b32("s-a"), BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600));
    await begin(b32("second"), outsider.address, b32("s-b"), BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600));
    await rejects(finalize(await proof(), { id: b32("first") }), "InvalidSettlement");

    const after = await contract.currentEntry(tokenId);
    assert.equal(after.version, settled.version);
    assert.equal(after.recordCommitment, settled.recordCommitment);
  });

  it("scopes settlement authority to the registrar, not to ownerOf", async () => {
    // The projection records the register's holder. Deriving the authority from
    // ownerOf would leave the registrar unable to record its own changes, and
    // would hand the ability to hold a gap open to whoever last bought in.
    assert.equal(await contract.isSettlementAuthority(tokenId, registrar.address), true);
    assert.equal(await contract.isSettlementAuthority(tokenId, owner.address), false);
    assert.equal(await contract.isSettlementAuthority(tokenId, outsider.address), false);
    await rejects(
      contract.connect(owner).beginSettlement(tokenId, settlementId, buyer.address, snapshot, deadline),
      "Unauthorized"
    );
    await contract.connect(owner).transferFrom(owner.address, buyer.address, tokenId);
    assert.equal(await contract.isSettlementAuthority(tokenId, buyer.address), false);
    await rejects(
      contract.connect(buyer).beginSettlement(tokenId, settlementId, buyer.address, snapshot, deadline),
      "Unauthorized"
    );
    await begin();
    assert.equal(await contract.openGapOf(tokenId), settlementId);
  });

  it("rejects an effective time too far ahead of the present", async () => {
    await begin();
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    const tooFar = now + 60n * 24n * 3600n;
    await rejects(
      finalize(await proof({ effectiveAt: tooFar }), { effectiveAt: tooFar }),
      "EffectiveAtTooFar"
    );
    await finalize(await proof());
    assert.equal((await contract.currentEntry(tokenId)).version, 2n);
  });

  it("binds the finality signature to this contract through the EIP-712 domain", async () => {
    await begin();
    const foreign = b32("some-other-domain-separator");
    assert.notEqual(foreign, domainSeparator);
    await rejects(finalize(await proof({ domain: foreign })), "InvalidProof");
    await finalize(await proof());
    assert.equal((await contract.currentEntry(tokenId)).holder, buyer.address);
  });

  it("rejects a membership index carrying bits beyond the path length", async () => {
    // Without exhausting the index, several (index, siblings) pairs verify
    // against one root.
    await begin();
    await rejects(finalize(await proof({ index: 4n })), "InvalidProof");
    await finalize(await proof());
    assert.equal((await contract.currentEntry(tokenId)).version, 2n);
  });
});
