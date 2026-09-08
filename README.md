# Asynchronous Register Projection for NFTs

This repository contains an ERC working draft:
`IRegisterProjection` and `IProjectionSettlement`, plus a reference
implementation and the invariant tests.

## What this standard does

An off-chain register that records who holds an asset updates asynchronously,
and no on-chain design removes that lag. This ERC turns each register change —
identified by the instant it takes effect and a commitment to its content — into
an ordered projection onto an ERC-721 token, so that **every past instant
resolves to exactly one confirmed holder**, and whether that answer can still
change is decidable from the same invariants.

The token keeps trading throughout. `ownerOf` is the tradeable position; the
projection is the confirmed record; the two are deliberately kept apart.

## Layout

```
erc-9999/
├── EIPS/eip-9999.md                          the specification
├── interfaces/
│   ├── IRegisterProjection.sol               extracted verbatim from the spec
│   └── IProjectionSettlement.sol             extracted verbatim from the spec
├── reference/
│   └── RegisterProjectionReference.sol       CC0 reference implementation
├── test/
│   └── protocol.cjs                          invariant tests, local EVM only
├── scripts/
│   ├── lint.js
│   ├── flatten-artifacts.js
│   ├── check-frozen-erc-constants.js
│   ├── secret-scan.js
│   └── check-imports.js
├── .github/workflows/ci.yml
└── README.md
```

The two files under `interfaces/` are lifted straight out of the two Solidity
blocks in `EIPS/eip-9999.md`, so the compiled ABIs are the spec's own text and
cannot drift from it.

## Frozen constants

The interface IDs are **frozen** and MUST NOT change. CI verifies them on every
push and PR:

| Interface               | ID           | Selectors |
| ----------------------- | ------------ | --------- |
| `IRegisterProjection`   | `0x6309e170` | 7         |
| `IProjectionSettlement` | `0xf4a7d71b` | 8         |

CI compiles the interfaces, computes the real selector XOR from the resulting
ABI, and compares against these values. Reordering, adding or removing a
function changes the selector and turns CI red — do not bypass it.

The computation has three ways to go silently wrong, and
`scripts/check-frozen-erc-constants.js` documents each: it must use keccak256
rather than Node's `sha3-256` (a different function), canonical signatures with
parameter types only, and it must exclude `supportsInterface`, since these
interfaces inherit `IERC165` and an ERC-165 identifier covers the functions an
interface adds.

## Scripts

| Command                     | What it does |
| --------------------------- | ------------ |
| `npm run lint`              | LF endings, no tabs or trailing whitespace, trailing newline, SPDX and pragma on every `.sol`, ASCII-only Solidity |
| `npm run compile`           | solc 0.8.26 via Hardhat, then flattens the two interface artifacts to where the constants check reads them |
| `npm run verify:constants`  | recomputes both interface IDs and compares to the frozen values |
| `npm run verify:secret-scan`| fails on internal references leaking into the public tree |
| `npm run verify:imports`    | checks that relative imports stay within this package |
| `npm test`                  | the invariant suite on a local EVM — no wallet, RPC endpoint, testnet asset or external signer |
| `npm run build`             | writes `dist/` — both ABIs, the computed IDs, the spec, and a manifest with a sha256 per file |
| `npm run verify:all`        | the whole pipeline, in CI order |

## CI

`.github/workflows/ci.yml` runs on push to `main` and on every PR:

```
install -> lint -> compile -> verify:constants -> secret-scan -> check-imports -> test -> build
```

Green means: selectors match the frozen IDs, no internal references leaked,
import boundaries respected, and every invariant holds.

## Relationship to the `ethereum/ERCs` submission

`EIPS/eip-9999.md` is the submission text. `9999` is a **numeric placeholder** —
under EIP-1 the editors assign ERC numbers, and an author-chosen number is
treated as number gaming. The submission tree that `ethereum/ERCs` expects
(`ERCS/erc-N.md` plus `assets/eip-N/`) is generated separately; the only
difference from the text here is where the reference implementation and tests
sit, and the two links in the Reference Implementation section that point at
them.

The `discussions-to` field is a placeholder until a public discussion exists.
This repository does not represent an assigned or accepted ERC.

## Licence

CC0-1.0. See `LICENSE`.
