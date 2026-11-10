#!/usr/bin/env node
'use strict';
/** Used by test6-invalid-endorsement.sh. Prints GetTally(electionID) as JSON. */

const { connectAs } = require('./gateway');

async function main() {
    const [, , electionID] = process.argv;
    if (!electionID) {
        console.error('usage: get-tally.js <electionID>');
        process.exit(1);
    }
    const { contract, close } = await connectAs('IEBC');
    try {
        const bytes = await contract.evaluateTransaction('GetTally', electionID);
        process.stdout.write(Buffer.from(bytes).toString('utf8'));
    } finally {
        close();
    }
}

main().catch((err) => { console.error('FATAL', err.message); process.exit(1); });
