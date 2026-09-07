/**
 * Turns a Bedrock identity ARN into the value we put in the ingest `ip` field.
 *
 * Guardrail activity's Actor column is that field (guardrails-service copies
 * `ip` onto the malicious event). Model-invocation logs never carry a client
 * IP, but they do carry identity.arn — already forwarded as
 * `bedrock-identity-arn`. This module picks a human identity out of that ARN
 * so Actor shows a user or a role instead of 0.0.0.0.
 *
 * Two common shapes (STS assumed-role):
 *   arn:aws:sts::ACCOUNT:assumed-role/AWSReservedSSO_…Role_hash/mabba@example.com
 *     → mabba@example.com   (SSO session is the person)
 *   arn:aws:sts::ACCOUNT:assumed-role/aria-usertask-role/edf60249dbcf44b19f0c10eedfe1790f
 *     → aria-usertask-role  (session is a machine id, so the role is the actor)
 *
 * ARN envelope (partition / service / resource) is parsed by
 * @aws-sdk/util-arn-parser. Actor selection from the resource string is ours;
 * keep it aligned with BedrockIdentityActor.java (same cases in
 * test/identity-actor-cases.json).
 *
 * The display value must not contain ':' — threat-detection's cleanIp()
 * splits on the first colon (IPv4:port), so a full ARN would collapse to "arn".
 */
const { parse, validate } = require('@aws-sdk/util-arn-parser');

const PLACEHOLDER_IP = '0.0.0.0';

function isMachineSession(session) {
    if (!session) return true;
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(session)) return true;
    if (/^[0-9a-f]{32,}$/i.test(session)) return true;
    if (/^i-[0-9a-f]{8,}$/i.test(session)) return true;
    return false;
}

function lastSegment(parts) {
    return parts.length ? parts[parts.length - 1] : '';
}

function actorFromAssumedRole(roleName, session) {
    if (!roleName) return '';
    if (session.includes('@')) return session;
    if (/^AWSReservedSSO_/i.test(roleName) && session) return session;
    if (!isMachineSession(session)) return session;
    return roleName;
}

/** Resource is the parser's `resource` field, e.g. assumed-role/role/session. */
function actorFromResource(resource) {
    const parts = String(resource || '').split('/').filter(Boolean);
    if (parts.length === 0) return '';
    const type = parts[0];
    switch (type) {
        case 'assumed-role':
            return actorFromAssumedRole(parts[1] || '', parts.slice(2).join('/'));
        case 'federated-user':
        case 'user':
        case 'role':
            return lastSegment(parts.slice(1));
        case 'root':
            return 'root';
        default:
            return parts.length > 1 ? lastSegment(parts) : '';
    }
}

function actorFromIdentityArn(arn) {
    if (!arn || typeof arn !== 'string') return '';
    const trimmed = arn.trim();
    if (!validate(trimmed)) return '';
    let parsed;
    try {
        parsed = parse(trimmed);
    } catch {
        return '';
    }
    if (parsed.service !== 'sts' && parsed.service !== 'iam') return '';
    return actorFromResource(parsed.resource);
}

function actorIp(arn) {
    return actorFromIdentityArn(arn) || PLACEHOLDER_IP;
}

module.exports = { actorFromIdentityArn, actorIp, PLACEHOLDER_IP };
