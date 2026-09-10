const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('@aws-sdk/util-arn-parser');
const { actorFromIdentityArn, actorIp, PLACEHOLDER_IP } = require('../identityActor');
// Keep in sync with akto data-ingestion-service src/test/resources/identity-actor-cases.json
const cases = require('./identity-actor-cases.json');

describe('actorFromIdentityArn', () => {
    for (const { name, arn, actor } of cases) {
        it(name, () => {
            assert.equal(actorFromIdentityArn(arn), actor);
        });
    }

    it('null', () => {
        assert.equal(actorFromIdentityArn(null), '');
    });

    it('non-string', () => {
        assert.equal(actorFromIdentityArn(12), '');
    });

    it('trims surrounding whitespace', () => {
        assert.equal(
            actorFromIdentityArn('  arn:aws:iam::123456789012:user/alice  '),
            'alice'
        );
    });
});

describe('actorIp', () => {
    it('falls back to placeholder when the ARN is not a caller identity', () => {
        assert.equal(actorIp(''), PLACEHOLDER_IP);
        assert.equal(actorIp('arn:aws:bedrock:us-east-1:123456789012:agent/ABCDEF'), PLACEHOLDER_IP);
    });

    it('uses the parsed identity when present', () => {
        assert.equal(
            actorIp('arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/mabba@example.com'),
            'mabba@example.com'
        );
    });
});

describe('@aws-sdk/util-arn-parser envelope (what Java parseArn must match)', () => {
    it('splits assumed-role resource the same way as BedrockIdentityActor.parseArn', () => {
        const parsed = parse('arn:aws:sts::123456789012:assumed-role/aria-usertask-role/edf60249dbcf44b19f0c10eedfe1790f');
        assert.equal(parsed.service, 'sts');
        assert.equal(parsed.resource, 'assumed-role/aria-usertask-role/edf60249dbcf44b19f0c10eedfe1790f');
    });
});
