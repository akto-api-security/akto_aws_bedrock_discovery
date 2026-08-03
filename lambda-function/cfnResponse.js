/**
 * Minimal CloudFormation custom-resource responder.
 *
 * CFN hands us a presigned S3 URL and waits up to an hour for a PUT to it. If
 * that PUT never lands the client's stack hangs and then rolls back, so callers
 * must send exactly one response on every path, including failures.
 *
 * Uses node:https rather than fetch on purpose: the presigned URL expects the
 * documented request shape (empty Content-Type, explicit Content-Length), and
 * fetch would impose its own Content-Type on a string body.
 */
const https = require('https');
const { URL } = require('url');

const SUCCESS = 'SUCCESS';
const FAILED = 'FAILED';

/**
 * PUTs the result back to CFN. Never rejects — a throw here would be
 * indistinguishable from not responding at all, which is the one outcome that
 * strands a stack.
 */
function sendCfnResponse(event, { status, reason = '', data = {}, physicalResourceId } = {}) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            Status: status,
            Reason: reason || `See CloudWatch log stream for details`,
            PhysicalResourceId: physicalResourceId || event.PhysicalResourceId || event.LogicalResourceId,
            StackId: event.StackId,
            RequestId: event.RequestId,
            LogicalResourceId: event.LogicalResourceId,
            NoEcho: false,
            Data: data
        });

        if (!event.ResponseURL) {
            console.error('⚠️ No ResponseURL on the event — cannot respond to CloudFormation');
            return resolve();
        }

        console.log(`📮 Responding ${status} to CloudFormation: ${reason || '(no reason given)'}`);
        const parsed = new URL(event.ResponseURL);
        const request = https.request({
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: `${parsed.pathname}${parsed.search}`,
            method: 'PUT',
            headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) }
        }, (response) => {
            console.log(`📮 CloudFormation acknowledged: HTTP ${response.statusCode}`);
            response.resume();          // drain so the socket can close
            response.on('end', resolve);
        });

        request.on('error', (error) => {
            console.error(`❌ Failed to respond to CloudFormation: ${error.message}`);
            resolve();
        });
        request.write(body);
        request.end();
    });
}

module.exports = { sendCfnResponse, SUCCESS, FAILED };
