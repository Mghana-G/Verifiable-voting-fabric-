#!/usr/bin/env node
'use strict';
/**
 * Used by test6-invalid-endorsement.sh. Fetches the current last block FROM
 * A PEER (never the orderer — see docs/PHASE4_DECISIONS.md E.3) and prints
 * its decoded validation codes as JSON.
 *
 * Usage: node decode-last-block.js <org> <scratchDir>
 */

const { getChannelHeight, getBlockValidationCodes } = require('./blockchain');

function main() {
    const [, , orgArg, scratchDirArg] = process.argv;
    const org = orgArg || 'IEBC';
    const scratchDir = scratchDirArg || '/tmp';
    const height = getChannelHeight(org);
    const blockNum = height - 1;
    const decoded = getBlockValidationCodes(blockNum, org, scratchDir);
    process.stdout.write(JSON.stringify({ height, blockNum, codes: decoded.codes, labels: decoded.labels, numTx: decoded.numTx }));
}

main();
