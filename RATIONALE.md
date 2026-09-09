# Rationale

## Problem

Tokenized assets may depend on external registries whose state changes asynchronously relative to blockchain state.

ERC-721 provides current token ownership but does not represent historical states maintained by external registries.

## Design Choice

This proposal separates:

- tradeable token ownership;
- externally confirmed registry state.

The goal is not to replace external registries, but to provide a standard way to represent their temporal evolution.

## Why Not Freeze Transfers?

Freezing token transfers hides registry latency by stopping market activity. This proposal represents synchronization status explicitly instead.

## Why Historical Queries Matter

Many asset rights depend on historical records, including:

- distributions;
- collateral decisions;
- voting records;
- compliance checks.

A system may need to know not only who is recorded, but whether that answer is final.
