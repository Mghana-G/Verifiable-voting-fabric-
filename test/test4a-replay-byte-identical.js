#!/usr/bin/env node
'use strict';
/**
 * Test 4a — Replay Attack Rejection, byte-identical signed proposal
 * docs/PHASE4_DECISIONS.md E.4 / docs/DEVIATIONS.md DEV-004.
 *
 * Reconstructs the exact proposal bytes and signature of an already-
 * committed CastBallot via fabric-gateway's offline-signing API
 * (Proposal.getBytes/getDigest, Gateway.newSignedProposal) and resubmits
 * them unmodified. Expected (verified empirically): rejected at the
 * ENDORSE stage with "duplicate transaction found [<txid>]" — a
 * platform-level Fabric transaction-ID check. The chaincode is never
 * invoked, so ERR_NONCE_USED must NOT appear in this test's error text;
 * that is exclusively 4b's evidence.
 */

const { connectAs } = require('./lib/gateway');
const { mintVAT, buildCastArgs, errorText, signers } = require('./lib/vote');
const { loadVoters } = require('./lib/voters');
const { isoStamp, evidenceDir, writeJSON, capturePeerLogs, jsonSafe } = require('./lib/evidence');

const CANDIDATE = 'C001';
const POLLING_STATION = 'PS-TEST4A';
const PEER_LOGS = ['peer0.orgiebc.example.com', 'peer0.orgjudiciary.example.com'];

async function run(runIndex) {
    const stamp = isoStamp();
    const dir = evidenceDir('test4a', stamp);
    const electionID = `test4a-run${runIndex}-${Date.now()}`;
    const result = { test: '4a', runIndex, electionID, pass: false };

    const { gateway, contract, privateKey, close } = await connectAs('IEBC');
    try {
        const [voter] = loadVoters(1, 400 + runIndex * 3);
        const vatID = await mintVAT(contract, voter.hash, electionID, POLLING_STATION);
        result.vatID = vatID;

        const args = buildCastArgs(vatID, CANDIDATE, electionID);

        // Offline-signing flow: build the unsigned proposal, capture its
        // bytes and digest, sign the digest ourselves with the same signer
        // the gateway would use internally, then submit the reconstructed
        // signed proposal. This gives us bytes+signature we can replay
        // byte-for-byte afterwards.
        const unsignedProposal = contract.newProposal('CastBallot', {
            arguments: [args.vatID, args.candidateID, args.ephemeralPubKey, args.signatureB64, args.payloadStr, args.nonce],
        });
        const proposalBytes = unsignedProposal.getBytes();
        const digest = unsignedProposal.getDigest();
        const signFn = signers.newPrivateKeySigner(privateKey);
        const signature = await signFn(digest);

        const originalSignedProposal = gateway.newSignedProposal(proposalBytes, signature);
        const originalTx = await originalSignedProposal.endorse();
        const originalCommit = await originalTx.submit();
        const originalStatus = await originalCommit.getStatus();
        result.originalCommitted = originalStatus.successful;
        result.originalTransactionId = originalStatus.transactionId;
        if (!originalStatus.successful) {
            throw new Error(`original CastBallot failed to commit: code=${originalStatus.code}`);
        }

        const invBefore = JSON.parse(Buffer.from(await contract.evaluateTransaction('GetAuditInvariant', electionID)).toString('utf8'));
        result.invariantBefore = invBefore;

        // Byte-identical replay: same bytes, same signature.
        let replayError = null;
        let replayStage = null;
        try {
            const replayProposal = gateway.newSignedProposal(proposalBytes, signature);
            const replayTx = await replayProposal.endorse();
            replayStage = 'endorsed (unexpected)';
            try {
                const replayCommit = await replayTx.submit();
                const replayStatus = await replayCommit.getStatus();
                result.replayCommitStatus = { successful: replayStatus.successful, code: Number(replayStatus.code) };
                replayStage = 'committed (unexpected)';
            } catch (submitErr) {
                replayError = errorText(submitErr) || submitErr.message;
                replayStage = 'rejected at submit/commit';
            }
        } catch (endorseErr) {
            replayError = errorText(endorseErr) || endorseErr.message;
            replayStage = 'rejected at endorse';
        }

        result.replayStage = replayStage;
        result.replayError = replayError;
        result.rejectedAtEndorser = replayStage === 'rejected at endorse';
        result.containsDuplicateTxid = !!(replayError && replayError.toLowerCase().includes('duplicate transaction'));
        result.containsNonceUsed = !!(replayError && replayError.includes('ERR_NONCE_USED'));

        const invAfter = JSON.parse(Buffer.from(await contract.evaluateTransaction('GetAuditInvariant', electionID)).toString('utf8'));
        result.invariantAfter = invAfter;
        result.invariantUnchanged = invBefore.burnedCount === invAfter.burnedCount && invBefore.tallyTotal === invAfter.tallyTotal;

        result.pass = result.rejectedAtEndorser && result.containsDuplicateTxid && !result.containsNonceUsed && result.invariantUnchanged;
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        close();
    }

    writeJSON(dir, 'result.json', jsonSafe(result));
    capturePeerLogs(dir, PEER_LOGS, 200);

    const keyEvidence = result.replayError || result.fatalError || 'no error captured';
    console.log(`test4a run${runIndex} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

if (require.main === module) {
    const runIndex = parseInt(process.argv[2] || '1', 10);
    run(runIndex).then((r) => process.exit(r.pass ? 0 : 1)).catch((e) => { console.error('FATAL', e); process.exit(2); });
}

module.exports = { run };
