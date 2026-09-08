#!/usr/bin/env node
/**
 * Check frozen ERC constants.
 *
 * After compilation, reads the compiled artifacts and computes the real
 * interface ID for each interface (XOR of function selectors, ERC-165 style),
 * then compares against the FROZEN values.
 *
 * If any function signature is added/reordered/removed, the computed ID
 * diverges and this script exits non-zero -- CI goes red immediately.
 *
 * Three things this computation must get right, each of which silently
 * produces a wrong ID if you get it wrong:
 *
 *   1. keccak256, not SHA3-256. Node's crypto has sha3-256, which is a
 *      DIFFERENT function -- same sponge, different padding. Selectors from it
 *      never match. ethers.id() is keccak256.
 *   2. Canonical signatures use parameter TYPES only, never parameter names.
 *   3. supportsInterface is excluded. These interfaces inherit IERC165, and
 *      the ERC-165 identifier of a derived interface is the XOR of the
 *      functions it adds -- otherwise every such interface would fold the
 *      IERC165 selector back in and no published ID would match.
 */

const fs = require('fs');
const path = require('path');
const { Interface, toBeHex } = require('ethers');

const ARTIFACTS_DIR = path.join(__dirname, '..', 'artifacts');
const EXPECTED = {
  IRegisterProjection: '0x6309e170',
  IProjectionSettlement: '0xf4a7d71b',
};

function loadAbi(name) {
  const file = path.join(ARTIFACTS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    console.error(`[frozen-constants] artifact not found: ${file}`);
    console.error('Run `npm run compile` first.');
    process.exit(1);
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const abi = json.abi || json;
  if (!Array.isArray(abi) || abi.length === 0) {
    console.error(`[frozen-constants] artifact has no usable ABI: ${file}`);
    process.exit(1);
  }
  return abi;
}

function ifaceId(abi) {
  const iface = new Interface(abi);
  let value = 0n;
  for (const f of iface.fragments) {
    if (f.type === 'function' && f.name !== 'supportsInterface') {
      value ^= BigInt(f.selector);
    }
  }
  return toBeHex(value, 4);
}

let failed = false;
for (const [name, frozen] of Object.entries(EXPECTED)) {
  const abi = loadAbi(name);
  const computed = ifaceId(abi);
  const ok = computed.toLowerCase() === frozen.toLowerCase();
  const counted = new Interface(abi).fragments.filter(
    (f) => f.type === 'function' && f.name !== 'supportsInterface'
  ).length;
  console.log(
    `[frozen-constants] ${name}: ${counted} selectors, computed=${computed} frozen=${frozen} -> ${ok ? 'OK' : 'MISMATCH'}`
  );
  if (!ok) failed = true;
}

if (failed) {
  console.error('\n[frozen-constants] FATAL: computed interface ID does not match frozen value.');
  console.error('Did you reorder / add / remove a function? The selector changed.');
  console.error('Revert the change, or bump the frozen value deliberately and say so in the spec.');
  process.exit(1);
}

console.log('[frozen-constants] frozen IDs hold');
