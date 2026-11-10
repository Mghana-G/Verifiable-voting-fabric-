'use strict';

const { connectIEBC } = require('./gateway');

const CHANNEL    = 'votingchannel';
const CHAINCODE  = 'voting';

async function mintVAT(voterHash, electionID, pollingStationID) {
    const { gateway, close } = await connectIEBC();
    try {
        const contract = gateway.getNetwork(CHANNEL).getContract(CHAINCODE);
        // endorsingOrganizations bypasses service discovery: voterIssuedCollection
        // has memberOnlyWrite:true which limits discovery to 2 orgs, conflicting
        // with the OutOf(3,...) chaincode endorsement policy.
        const transaction = await contract.newProposal('MintVAT', {
            arguments: [voterHash, electionID, pollingStationID],
            endorsingOrganizations: ['OrgIEBCMSP', 'OrgJudiciaryMSP', 'OrgCivilSocietyMSP'],
        }).endorse();
        const submitted = await transaction.submit();
        await submitted.getStatus();
        return Buffer.from(submitted.getResult()).toString('utf8').trim();
    } finally {
        close();
    }
}

module.exports = { mintVAT };
