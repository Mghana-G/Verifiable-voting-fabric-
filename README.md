# Voting Network

A blockchain-based voting prototype for **end-to-end verifiable presidential elections**, built on Hyperledger Fabric. It was designed around the Kenyan election context as the research project of Gift Mghana (Strathmore University).

## Why this project exists

Kenyan presidential results have been contested repeatedly, and the dispute is almost always the same: citizens, candidates and observers are asked to *trust* a tally they cannot independently check. When the only party that counts the votes is also the party that holds the records, a mistake, an insider change or a rumour of one cannot be settled with evidence.

The question behind this project:

> Can an election be run so that every voter can confirm their ballot was counted as cast, anyone can confirm the total is correct, and no single institution, insider included, can quietly change the result?

## What it is for

This is a **research prototype**, not a production voting system. It exists to show, with measurable evidence, that a permissioned blockchain can give a presidential election three properties that paper and centralised databases struggle to give together:

1. **One person, one vote.** A voter can be counted once. Double voting, sequential or concurrent, is rejected by the ledger.
2. **Verifiability by anyone.** The tally can be recomputed from the ledger, and a voter can check their own ballot with a receipt without the receipt revealing who they voted for.
3. **No single point of trust.** The ledger is held by independent organisations (the electoral commission, judiciary, civil society and media), each running its own peer. A change must be endorsed by several of them, and a tampered copy on one peer is detected and recoverable.

## Why Hyperledger Fabric

A presidential election is not a public-chain problem. The participants are known institutions, the ballots must stay secret, and the system has to be fast and cheap enough to run on ordinary hardware. A permissioned network gives identity, endorsement policies and private data collections, which a public chain does not offer in the same way.

## How it answers the question

| Concern | Design response |
|---|---|
| Insider alters results | Transactions need endorsement from multiple organisations; ledger copies are compared across peers |
| Double voting | Chaincode burns each voter's one-time credential on use; the audit invariant `burnedCount == tallyTotal` is checked |
| Replayed or forged ballots | Deterministic transaction IDs; replays and tampered payloads are rejected |
| Ballot secrecy vs. verifiability | Voter identity is kept in a private data collection; the public ledger holds only an anonymous receipt |
| Trust in the process | A public verifier page lets anyone audit the ledger without signing in |

## What is in the repository

| Folder | Purpose |
|---|---|
| `network/` | Fabric network: 3 Raft orderers, 4 organisations (1 peer each), CouchDB, CAs, and the numbered bring-up scripts |
| `chaincode/voting/` | The voting smart contract (Node.js) |
| `client-app/` | Gateway client that submits ballots |
| `voter-generator/` | Generates synthetic voters and candidates for testing |
| `dashboard/` | Voter booth, administrator console and public verifier (local demo) |
| `verification-dashboard/` | Standalone verification view |
| `test/` | Validation suite: double voting, insider modification, tally parity, replay, tampered ballot, invalid endorsement, performance up to 10,000 ballots |
| `docs/` | `HOW_IT_WORKS.md` (architecture and a vote traced end to end), `COMMANDS.md`, `DEVIATIONS.md`, `PHASE4_DECISIONS.md` |
| `evidence/SUMMARY.md` | Summary of test results against the success criteria |

## Results

All seven pass/fail criteria (double voting, replay, tampered ballot, invalid endorsement, audit invariant, tally parity, ledger recovery) passed in three repeated runs. Latency and throughput were measured at 100, 500, 1,000, 5,000 and 10,000 ballots, and the audit invariant held at every scale. See `evidence/SUMMARY.md`.

## Getting started

Prerequisites: Ubuntu 24.04, Docker Engine 27 with the Compose plugin, Node.js 20, Python 3.12, Hyperledger Fabric 2.5.x binaries.

```bash
cd network
./scripts/00-prereqs.sh
./scripts/01-generate-crypto.sh
./scripts/02-generate-artifacts.sh
./scripts/03-network-up.sh
./scripts/04-create-channel.sh
./scripts/05-deploy-chaincode.sh
./scripts/06-init-candidates.sh
```

Then see `dashboard/README.md` to run the dashboard and `docs/HOW_IT_WORKS.md` for the full walkthrough.

## Limitations

This is a prototype running on a single machine. Voter authentication is simulated, access control in the dashboard is demo-grade, and throughput is bounded by contention on a single tally counter. These are documented in `docs/HOW_IT_WORKS.md` (Known limits) and `docs/DEVIATIONS.md`. It must not be used for a real election.
