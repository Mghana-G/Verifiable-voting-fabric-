'use strict';

// What each validation test attacks and which layer stops it (HOW_IT_WORKS 4).
// `quick` tests may be started from the dashboard; the others are shown as
// commands only. The evidence/ folders are written by the tests themselves.

const TESTS = {
    '1a': { script: 'test1a-double-voting-sequential.js', args: [], quick: true, attacks: 'Double voting: cast twice with the same ballot token, one after the other.', stoppedBy: 'Chaincode check 3 (ERR_VAT_NOT_ACTIVE), at endorsement; no block is written.' },
    '1b': { script: 'test1b-double-voting-concurrent.js', args: [], quick: true, attacks: 'Double voting: two casts with the same token submitted at the same time.', stoppedBy: 'MVCC read conflict at validation (code 11); the first commits, the second is marked invalid.' },
    '2': { script: 'test2-insider-modification.js', args: [], quick: false, typed: 'RUN TEST 2', attacks: 'Insider modification: overwrite a tally value in one peer\'s CouchDB.', stoppedBy: 'Containment, not prevention: the forged read-write set cannot match the honest peers (endorsement mismatch); rebuild-dbs replays the immutable block store to recover.' },
    '3': { script: 'test3-parity-audit.js', args: [], quick: true, count: true, attacks: 'Parity audit: N sequential ballots, then burnedCount must equal tallyTotal.', stoppedBy: 'Not a rejection: GetAuditInvariant compares BURNEDCOUNT with the sum of TALLY values. Casts are sequential (DEV-005).' },
    '4a': { script: 'test4a-replay-byte-identical.js', args: [], quick: true, attacks: 'Replay: resubmit the byte-identical signed proposal.', stoppedBy: 'Platform duplicate transaction ID rejection at endorsement, before the chaincode runs (DEV-004).' },
    '4b': { script: 'test4b-replay-argument-tuple.js', args: [], quick: true, attacks: 'Replay: resubmit the same six arguments as a new transaction.', stoppedBy: 'Chaincode check 2 (ERR_NONCE_USED), which runs before the token check (DEV-004).' },
    '5': { script: 'test5-tampered-ballot.js', args: [], quick: true, attacks: 'Tampered ballot: change the payload after signing.', stoppedBy: 'Chaincode check 1 (ERR_BAD_SIGNATURE), at endorsement.' },
    '6': { script: 'test6-invalid-endorsement.sh', args: [], quick: true, bash: true, attacks: 'Invalid endorsement: collect fewer endorsements than the policy needs.', stoppedBy: 'Endorsement policy at validation (code 10, ENDORSEMENT_POLICY_FAILURE).' },
    '7': { quick: false, command: 'node test/test7-performance.js sweep 100,500,1000', attacks: 'Performance at scale.', stoppedBy: 'Not a rejection test.' },
    all: { quick: false, command: 'bash test/run-all.sh', attacks: 'The whole suite, three runs each.', stoppedBy: 'See each test.' },
};

module.exports = { TESTS };
