#!/usr/bin/env node
/**
 * One-off: remove specific interceptor Lambdas from AgentCore Gateways.
 *
 * Used to release gateways still held by an earlier-generation AKTO interceptor
 * so the current one can take over. UpdateGateway is a FULL REPLACE — every
 * field must be read back and re-sent, or it is silently cleared — which is why
 * this exists instead of a hand-written CLI call.
 *
 * Safe by default: dry run unless --apply is passed, backs up each gateway's
 * configuration before touching it, removes only the interceptor ARNs you name,
 * and skips any gateway that isn't READY.
 *
 * Usage:
 *   node detach-interceptors.js --region ap-south-1 --arns <arn>[,<arn>]        # preview
 *   node detach-interceptors.js --region ap-south-1 --arns <arn> --apply        # do it
 *
 * Options:
 *   --region <r>      AWS region (required)
 *   --arns <list>     Interceptor Lambda ARNs to remove. Substring match is
 *                     allowed, so a bare function name works too.
 *   --all             Remove EVERY interceptor from the matched gateways.
 *                     Mutually exclusive with --arns.
 *   --gateways <list> Restrict to these gateway IDs (default: all in the region)
 *   --apply           Actually modify. Without it, nothing is written.
 *   --backup-dir <d>  Where to write pre-change snapshots (default: ./gateway-backups)
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Reuse the SDK already installed for the Lambda package.
const lambdaRequire = createRequire(path.join(__dirname, '../../lambda-function/package.json'));
const {
    BedrockAgentCoreControlClient, ListGatewaysCommand, GetGatewayCommand, UpdateGatewayCommand
} = lambdaRequire('@aws-sdk/client-bedrock-agentcore-control');

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
    const args = { apply: false, all: false, backupDir: path.join(process.cwd(), 'gateway-backups') };
    for (let i = 2; i < argv.length; i++) {
        const flag = argv[i];
        const next = () => argv[++i];
        if (flag === '--region') args.region = next();
        else if (flag === '--arns') args.arns = next().split(',').map((a) => a.trim()).filter(Boolean);
        else if (flag === '--gateways') args.gateways = next().split(',').map((g) => g.trim()).filter(Boolean);
        else if (flag === '--backup-dir') args.backupDir = next();
        else if (flag === '--apply') args.apply = true;
        else if (flag === '--all') args.all = true;
        else if (flag === '--help' || flag === '-h') args.help = true;
        else {
            console.error(`Unknown option: ${flag}`);
            process.exit(2);
        }
    }
    return args;
}

const args = parseArgs(process.argv);
if (args.help || !args.region || (!args.arns && !args.all) || (args.arns && args.all)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    process.exit(args.help ? 0 : 2);
}

const client = new BedrockAgentCoreControlClient({ region: args.region });

// Fields UpdateGateway needs echoed back; anything omitted is cleared.
const PRESERVED_FIELDS = [
    'description', 'protocolType', 'protocolConfiguration', 'authorizerConfiguration',
    'kmsKeyArn', 'customTransformConfiguration', 'policyEngineConfiguration',
    'exceptionLevel', 'wafConfiguration'
];

const matchesTarget = (arn) => !!arn && (args.all || args.arns.some((target) => arn.includes(target)));

function buildUpdateParams(gateway, interceptorConfigurations) {
    const params = {
        gatewayIdentifier: gateway.gatewayId,
        name: gateway.name,
        roleArn: gateway.roleArn,
        authorizerType: gateway.authorizerType
    };
    // AWS rejects an empty list, so removing the last interceptor means omitting
    // the field entirely — this full-replace API reads that as "none".
    if (interceptorConfigurations && interceptorConfigurations.length) {
        params.interceptorConfigurations = interceptorConfigurations;
    }
    for (const field of PRESERVED_FIELDS) {
        if (gateway[field] !== undefined && gateway[field] !== null) params[field] = gateway[field];
    }
    return params;
}

/** Sends the update, retrying without protocolType if the API rejects it as immutable. */
async function sendUpdate(gateway, configs) {
    const params = buildUpdateParams(gateway, configs);
    try {
        return await client.send(new UpdateGatewayCommand(params));
    } catch (error) {
        const rejectsProtocol = 'protocolType' in params && /protocol/i.test(error?.message || '');
        if (!rejectsProtocol) throw error;
        console.log(`      note: API rejected protocolType (${error.message}) — retrying without it`);
        const { protocolType, ...withoutProtocol } = params;
        return client.send(new UpdateGatewayCommand(withoutProtocol));
    }
}

async function listGatewayIds() {
    if (args.gateways?.length) return args.gateways;
    const ids = [];
    let nextToken;
    do {
        const page = await client.send(new ListGatewaysCommand({ nextToken }));
        ids.push(...(page.items || []).map((g) => g.gatewayId).filter(Boolean));
        nextToken = page.nextToken;
    } while (nextToken);
    return ids;
}

async function main() {
    console.log(`Region: ${args.region}`);
    console.log(args.all ? 'Target: ALL interceptors' : `Target ARNs: ${args.arns.join(', ')}`);
    console.log(args.apply ? 'Mode:   APPLY — gateways will be modified\n' : 'Mode:   DRY RUN — nothing will be modified (pass --apply to execute)\n');

    const gatewayIds = await listGatewayIds();
    if (!gatewayIds.length) {
        console.log('No gateways found.');
        return;
    }

    if (args.apply) fs.mkdirSync(args.backupDir, { recursive: true });
    const summary = { detached: 0, unchanged: 0, skipped: 0, failed: 0 };

    for (const gatewayId of gatewayIds) {
        try {
            const gateway = await client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
            const existing = gateway.interceptorConfigurations || [];
            const doomed = existing.filter((c) => matchesTarget(c?.interceptor?.lambda?.arn));
            const remaining = existing.filter((c) => !matchesTarget(c?.interceptor?.lambda?.arn));

            console.log(`--- ${gatewayId} (${gateway.name})`);
            if (existing.length === 0) {
                console.log('    no interceptors attached — nothing to do');
                summary.unchanged++;
                continue;
            }
            for (const config of existing) {
                const arn = config?.interceptor?.lambda?.arn || '(unknown)';
                const points = (config?.interceptionPoints || []).join('+');
                console.log(`    ${matchesTarget(arn) ? 'REMOVE' : 'keep  '}  ${points.padEnd(17)} ${arn}`);
            }
            if (doomed.length === 0) {
                console.log('    nothing matched — leaving untouched');
                summary.unchanged++;
                continue;
            }
            if (gateway.status !== 'READY') {
                console.log(`    ⚠️  status=${gateway.status} — cannot modify right now, skipping`);
                summary.skipped++;
                continue;
            }
            if (!gateway.name || !gateway.roleArn || !gateway.authorizerType) {
                console.log('    ⚠️  gateway is missing a field UpdateGateway requires — skipping rather than risk a partial write');
                summary.skipped++;
                continue;
            }

            if (!args.apply) {
                console.log(`    would remove ${doomed.length}, keep ${remaining.length}  [dry run]`);
                summary.detached++;
                continue;
            }

            const backupFile = path.join(args.backupDir, `${gatewayId}.json`);
            fs.writeFileSync(backupFile, JSON.stringify(gateway, null, 2));
            console.log(`    backup written: ${backupFile}`);

            await sendUpdate(gateway, remaining);
            console.log(`    ✅ removed ${doomed.length}, kept ${remaining.length}`);
            summary.detached++;
        } catch (error) {
            console.log(`    ❌ ${gatewayId}: ${error.message}`);
            summary.failed++;
        }
    }

    console.log(`\n${args.apply ? 'Done' : 'Dry run complete'}: ${JSON.stringify(summary)}`);
    if (!args.apply && summary.detached > 0) console.log('Re-run with --apply to execute.');
}

main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
});
