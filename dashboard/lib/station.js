'use strict';

// The polling-station write path. The ONLY module in the dashboard that can
// endorse or submit a transaction, and it can submit only MintVAT and
// CastBallot, as User1@orgiebc (what client-app uses). One persistent
// connection. CreateCandidate is deliberately not reachable from here.
//
// It reports four real stages through the fabric-gateway step API:
//   endorsement : newProposal(...).endorse()   (peers simulate and sign)
//   ordering    : transaction.submit()         (orderer accepts, Raft cuts a block)
//   validation  : commit.getStatus() waiting   (peers check policy and MVCC)
//   committed   : status.successful / blockNumber / code

const { ORGS } = require('./fabric');
const identity = require('./identity');
const decode = require('./decode');
const { gateway } = require('@hyperledger/fabric-protos');

const IEBC = ORGS.find((o) => o.key === 'IEBC');
const MINT_ENDORSERS = ['OrgIEBCMSP', 'OrgJudiciaryMSP', 'OrgCivilSocietyMSP']; // DEV-003
const ALLOWED = new Set(['MintVAT', 'CastBallot']);

const ERROR_TEXT = {
    ERR_NOT_ADMIN: 'This action needs an administrator identity.',
    ERR_DUPLICATE_ISSUANCE: 'This voter has already been issued a ballot token in this election.',
    ERR_VAT_NOT_ACTIVE: 'This ballot token has already been used (burned), so the ballot was refused.',
    ERR_NONCE_USED: 'This ballot was refused because its one-time number (nonce) has already been used in this election (replay).',
    ERR_BAD_SIGNATURE: 'The ballot signature did not verify against the ephemeral public key, so the chaincode refused it.',
    ERR_NO_CANDIDATE: 'Candidates not loaded: run step 6 (06-init-candidates.sh) in Network control.',
};

let conn = null;

function connection() {
    if (!conn) {
        conn = identity.open(IEBC, {
            evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
            endorseOptions: () => ({ deadline: Date.now() + 30000 }),
            submitOptions: () => ({ deadline: Date.now() + 15000 }),
            commitStatusOptions: () => ({ deadline: Date.now() + 120000 }),
        });
    }
    return conn;
}

function reset() {
    if (!conn) return;
    try { conn.gateway.close(); conn.grpcClient.close(); } catch { /* closed */ }
    conn = null;
}

function errorText(err) {
    const details = (err.details || []).map((d) => d.message).join(' || ');
    return [err.message, details].filter(Boolean).join(' || ');
}

// Maps a thrown gateway error to { code, text, transport }.
function classify(err) {
    const t = errorText(err);
    const code = Object.keys(ERROR_TEXT).find((c) => t.includes(c));
    if (code) return { code, text: ERROR_TEXT[code], transport: false };
    const transport = /UNAVAILABLE|DEADLINE|ECONNREFUSED|connect|timed? ?out/i.test(`${err.message} ${err.code}`) || err.code === 14 || err.code === 4;
    return { code: null, text: transport ? 'The network did not answer. Check Network control.' : t.split('||')[0].trim().slice(0, 300), transport };
}

// Runs one transaction through the four stages. `emit({stage, state, ...})` is
// called as each stage starts and ends. Rejects with { classified } on failure.
async function run(fn, args, endorsers, emit = () => {}) {
    if (!ALLOWED.has(fn)) throw Object.assign(new Error(`${fn} is not allowed on the station path`), { classified: { code: null, text: 'refused' } });
    const t0 = Date.now();
    const contract = connection().network.getContract('voting');
    let stage = 'endorsement';
    try {
        emit({ stage, state: 'active' });
        const proposal = contract.newProposal(fn, { arguments: args, ...(endorsers ? { endorsingOrganizations: endorsers } : {}) });
        const txID = proposal.getTransactionId();
        const transaction = await proposal.endorse();
        let endorsedBy = [];
        try {
            // getBytes() is a gateway PreparedTransaction wrapping the signed envelope.
            const env = gateway.PreparedTransaction.deserializeBinary(transaction.getBytes()).getEnvelope();
            endorsedBy = decode.decodeEnvelope(env.serializeBinary()).endorsers;
        } catch { /* informational only */ }
        const tEndorse = Date.now() - t0;
        emit({ stage, state: 'done', ms: tEndorse, txID, endorsedBy });

        stage = 'ordering';
        emit({ stage, state: 'active' });
        const commit = await transaction.submit();
        const tOrder = Date.now() - t0 - tEndorse;
        emit({ stage, state: 'done', ms: tOrder });

        stage = 'validation';
        emit({ stage, state: 'active' });
        const status = await commit.getStatus();
        const tValid = Date.now() - t0 - tEndorse - tOrder;
        emit({ stage, state: 'done', ms: tValid });

        const codeNameText = decode.codeName(status.code);
        if (!status.successful) {
            emit({ stage: 'committed', state: 'failed', code: codeNameText });
            throw Object.assign(new Error(`commit unsuccessful: ${codeNameText}`), {
                classified: { code: codeNameText, text: `The transaction reached a block but was marked ${codeNameText}, so its writes were discarded.`, transport: false },
                txID, blockNumber: Number(status.blockNumber),
            });
        }
        const result = Buffer.from(transaction.getResult()).toString('utf8').trim();
        emit({ stage: 'committed', state: 'done', blockNumber: Number(status.blockNumber), code: codeNameText });
        return {
            txID, result, endorsedBy, blockNumber: Number(status.blockNumber), validationCode: codeNameText,
            latencyMs: Date.now() - t0, stagesMs: { endorsement: tEndorse, ordering: tOrder, validation: tValid },
        };
    } catch (err) {
        if (err.classified) throw err;
        // Reconnect on transport loss, and on identity errors (the network may have been rebuilt with new certificates).
        if (/UNAVAILABLE|ECONNREFUSED|access denied|not valid|unknown authority/i.test(errorText(err)) || err.code === 14) reset();
        const classified = classify(err);
        emit({ stage, state: 'failed', error: classified.code || classified.text });
        throw Object.assign(err, { classified });
    }
}

const mintVAT = (voterHash, electionID, pollingStationID, emit) => run('MintVAT', [voterHash, electionID, pollingStationID], MINT_ENDORSERS, emit);

// Six arguments in brief order; no endorsingOrganizations (same as client-app).
const castBallot = (a, emit) => run('CastBallot', [a.vatID, a.candidateID, a.ephemeralPubKey, a.signatureB64, a.payloadStr, a.nonce], null, emit);

function close() { reset(); }

module.exports = { mintVAT, castBallot, classify, close, ERROR_TEXT, MINT_ENDORSERS };
