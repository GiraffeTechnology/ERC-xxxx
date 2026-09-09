# Security Considerations

## Trust Boundaries

This proposal does not establish that an external registry is truthful. It establishes how accepted external states may be represented and queried.

## Registrar Trust

Registry governance, attestation authority and verification profile correctness remain external responsibilities.

## Finality

A historical answer may remain provisional while future registry admissions are possible.

Applications requiring settled states should check finality semantics before irreversible actions.

## Privacy

The proposal keeps registry contents off-chain. However, commitments, references and related metadata may still reveal information depending on implementation.

## Authority Separation

Settlement authority should be explicitly defined and should not automatically derive from token ownership.
