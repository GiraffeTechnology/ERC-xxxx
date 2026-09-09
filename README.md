# Asynchronous Register Projection for NFTs

## ERC Working Draft

This repository contains a public Ethereum ERC working draft for **Asynchronous Register Projection for NFTs**.

**Status:** Discussion Draft  
**ERC Number:** Not assigned

This repository is a standards proposal repository. It is not a product repository and does not represent an adopted Ethereum standard.

---

## Overview

Tokenized assets may depend on external registries, including ownership records, custody records, certification systems, and other institutional databases.

These external registries and blockchain networks do not necessarily update at the same time.

An ERC-721 token can represent a transferable on-chain position, but:

```
ownerOf(tokenId)
```

only answers the current blockchain ownership state.

It does not answer:

- which holder an external registry recognized at a particular record instant;
- whether that historical answer is final;
- whether an unresolved registry transition exists.

This proposal introduces a standard interface for representing externally maintained registry states and their temporal evolution alongside ERC-721 compatible assets.

---

## Design Principles

The proposal is based on three principles:

### 1. Separate Token State and Registry State

The token ownership state and external registry-confirmed state are related but distinct.

```
Tradeable Token Position
          ≠
Registry-confirmed Historical State
```

### 2. Do Not Freeze Token Transfers

Registry updates may arrive asynchronously.

A pending registry update should not require freezing normal ERC-721 transfers.

The unresolved state should be represented explicitly through projection semantics.

### 3. Preserve External Registry Boundaries

This proposal does not move external registries on-chain and does not attempt to replace legal or institutional sources of truth.

It provides a verifiable interoperability layer between external registries and blockchain assets.

---

## Core Concepts

### Registry Projection

External registry changes are represented as ordered projection entries.

Each entry contains:

- holder address;
- effective time;
- record commitment;
- previous commitment;
- registry reference;
- version.

Projection entries are append-only.

Required invariants:

- versions are consecutive;
- effective times strictly increase;
- record commitments cannot repeat within a token history;
- existing entries cannot be overwritten, deleted, reordered, or skipped.

---

## Historical Query Semantics

The proposal introduces:

### `holderAsOf(t)`

Returns the holder recorded by the projected registry at a specified instant.

### `isFinalAsOf(t)`

Determines whether future registry admissions can change that historical result.

### `openGapOf(t)`

Indicates whether a registry transition affecting that instant remains unresolved.

These are intentionally separate concepts.

---

## Relationship with Existing Standards

### ERC-721

Provides NFT representation and current on-chain ownership.

### ERC-1400 / ERC-3643

Provide compliance-oriented ownership restrictions and permissioned transfer mechanisms.

### This Proposal

Addresses a different problem:

> How should external registry states and their historical evolution be represented when they update asynchronously relative to blockchain state?

The proposal is complementary to existing token standards.

---

## Scope and Non-Goals

This proposal does not:

- determine legal ownership;
- replace government or institutional registries;
- establish jurisdiction-specific rights;
- make blockchain the legal source of truth;
- define application-specific entitlement rules.

A proof establishes inclusion in an accepted remote state. It does not independently prove the factual correctness of the underlying registry.

---

## Repository Structure

```
ERC9999/
├── EIPS/
│   └── eip-9999.md              Specification draft
├── interfaces/
│   ├── IRegisterProjection.sol
│   └── IProjectionSettlement.sol
├── reference/
│   └── RegisterProjectionReference.sol
├── test/
│   └── invariant tests
└── README.md
```

---

## Status

This repository contains an initial technical discussion draft.

No ERC number has been assigned.

Feedback is welcome regarding:

- historical query semantics;
- finality definitions;
- projection gap handling;
- verification profiles;
- interoperability with existing Ethereum standards.
