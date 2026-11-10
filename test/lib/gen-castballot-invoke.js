#!/usr/bin/env node
'use strict';
/**
 * Used only by test6-invalid-endorsement.sh. Mints a fresh VAT and builds a
 * correctly signed CastBallot argument tuple, so the shell script's
 * under-endorsed `peer chaincode invoke` has a transaction that is valid in
 * every respect except endorsement count. Prints ONLY the compact invoke
 * JSON to stdout (for direct use as `-c` to peer chaincode invoke); writes
 * the full captured ballot to <outFile> for evidence.
 *
 * Usage: node gen-castballot-invoke.js <electionID> <candidateID> <pollingStation> <outFile>
 */

const fs = require('fs');
const { connectAs } = require('./gateway');
const { mintVAT, buildCastArgs } = require('./vote');
const { loadVoters } = require('./voters');

async function main() {
    const [, , electionID, candidateID, pollingStation, outFile] = process.argv;
    if (!electionID || !candidateID || !pollingStation || !outFile) {
        console.error('usage: gen-castballot-invoke.js <electionID> <candidateID> <pollingStation> <outFile>');
        process.exit(1);
    }

    const offset = 700 + (Date.now() % 4000);
    const [voter] = loadVoters(1, offset);

    const { contract, close } = await connectAs('IEBC');
    try {
        const vatID = await mintVAT(contract, voter.hash, electionID, pollingStation);
        const args = buildCastArgs(vatID, candidateID, electionID);
        fs.writeFileSync(outFile, JSON.stringify({ vatID, ...args }, null, 2) + '\n');

        const invoke = {
            function: 'CastBallot',
            Args: [args.vatID, args.candidateID, args.ephemeralPubKey, args.signatureB64, args.payloadStr, args.nonce],
        };
        process.stdout.write(JSON.stringify(invoke));
    } finally {
        close();
    }
}

main().catch((err) => { console.error('FATAL', err.message); process.exit(1); });
