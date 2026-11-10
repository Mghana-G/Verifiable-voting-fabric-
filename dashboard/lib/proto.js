'use strict';

// Minimal protobuf reader, only enough to turn the committed chaincode's
// validation_parameter (an ApplicationPolicy) and a collection's member
// principals back into readable policy text. Field numbers follow
// fabric-protos: common/policies.proto and msp/msp_principal.proto.

function parse(buf) {
    const fields = [];
    let i = 0;
    const varint = () => {
        let result = 0;
        let shift = 0;
        for (;;) {
            if (i >= buf.length) throw new Error('truncated varint');
            const b = buf[i++];
            result += (b & 0x7f) * 2 ** shift;
            if (!(b & 0x80)) return result;
            shift += 7;
        }
    };
    while (i < buf.length) {
        const tag = varint();
        const field = Math.floor(tag / 8);
        const wire = tag % 8;
        if (wire === 0) {
            fields.push({ field, wire, value: varint() });
        } else if (wire === 2) {
            const len = varint();
            if (i + len > buf.length) throw new Error('truncated length-delimited field');
            fields.push({ field, wire, value: buf.subarray(i, i + len) });
            i += len;
        } else {
            throw new Error(`unsupported wire type ${wire}`);
        }
    }
    return fields;
}

const first = (fields, n) => fields.find((f) => f.field === n);
const all = (fields, n) => fields.filter((f) => f.field === n);

const ROLES = { 0: 'member', 1: 'admin', 2: 'client', 3: 'peer', 4: 'orderer' };

// MSPPrincipal.principal bytes (an MSPRole): "OrgIEBCMSP.peer".
function principalText(bytes) {
    const role = parse(bytes);
    const msp = first(role, 1);
    const r = first(role, 2);
    if (!msp) throw new Error('MSPRole without msp_identifier');
    return `${msp.value.toString('utf8')}.${ROLES[r ? r.value : 0] || `role${r.value}`}`;
}

// SignaturePolicy -> text, with SignedBy(n) resolved through `identities`.
function ruleText(bytes, identities) {
    const f = parse(bytes);
    const signedBy = first(f, 1);
    if (signedBy) {
        if (signedBy.value >= identities.length) throw new Error(`signed_by ${signedBy.value} has no identity`);
        return `'${identities[signedBy.value]}'`;
    }
    const nOutOf = first(f, 2);
    if (!nOutOf) throw new Error('SignaturePolicy with neither signed_by nor n_out_of');
    const g = parse(nOutOf.value);
    const n = (first(g, 1) || { value: 0 }).value;
    const rules = all(g, 2).map((r) => ruleText(r.value, identities));
    if (n === 1) return `OR(${rules.join(', ')})`;
    if (n === rules.length) return `AND(${rules.join(', ')})`;
    return `OutOf(${n}, ${rules.join(', ')})`;
}

// SignaturePolicyEnvelope bytes -> policy text.
function envelopeText(bytes, principalDecoder = principalText) {
    const env = parse(bytes);
    const identities = all(env, 3).map((p) => {
        const principal = first(parse(p.value), 2);
        if (!principal) throw new Error('MSPPrincipal without principal bytes');
        return principalDecoder(principal.value);
    });
    const rule = first(env, 2);
    if (!rule) throw new Error('SignaturePolicyEnvelope without rule');
    return ruleText(rule.value, identities);
}

// validation_parameter (base64 ApplicationPolicy) -> policy text.
function applicationPolicyText(b64) {
    const app = parse(Buffer.from(b64, 'base64'));
    const sig = first(app, 1);
    if (sig) return envelopeText(sig.value);
    const ref = first(app, 2);
    if (ref) return `channel policy reference: ${ref.value.toString('utf8')}`;
    throw new Error('ApplicationPolicy has neither signature_policy nor channel_config_policy_reference');
}

// A collection's JSON-form SignaturePolicy (as printed by querycommitted
// --output json): rule tree plus base64 principal bytes.
function jsonPolicyText(policy) {
    const identities = (policy.identities || []).map((p) => principalText(Buffer.from(p.principal, 'base64')));
    const walk = (rule) => {
        const t = rule.Type;
        if ('SignedBy' in t) return `'${identities[t.SignedBy]}'`;
        const rules = t.NOutOf.rules.map(walk);
        const n = t.NOutOf.n;
        if (n === 1) return `OR(${rules.join(', ')})`;
        if (n === rules.length) return `AND(${rules.join(', ')})`;
        return `OutOf(${n}, ${rules.join(', ')})`;
    };
    return walk(policy.rule);
}

module.exports = { parse, applicationPolicyText, jsonPolicyText, envelopeText, principalText };
