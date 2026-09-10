/**
 * Turns an execution role into a flat set of security tags.
 *
 * The role name and its attached policy *names* say which policies exist; they
 * never say what the agent may actually do. Answering "can this agent read
 * secrets / assume another role / reach any bucket" needs the policy documents
 * themselves, the inline policies the attached list omits, the trust policy
 * (who may assume the role at all) and the permissions boundary (the ceiling on
 * everything else). This module fetches all four and reduces them to short,
 * bounded tag values.
 *
 * Shared by both pipelines — traceDiscovery.js (AgentCore, CloudWatch) and
 * discovery.js (Bedrock Agent/direct callers, S3) — so a Harness, a Runtime and
 * a Bedrock Agent are all described the same way, under their own prefix.
 *
 * Fail-open throughout: a role that cannot be read yields fewer tags, never a
 * failed message. Losing enrichment must not lose the traffic it describes.
 */
const {
    GetRoleCommand, ListAttachedRolePoliciesCommand, GetPolicyCommand, GetPolicyVersionCommand,
    ListRolePoliciesCommand, GetRolePolicyCommand
} = require('@aws-sdk/client-iam');
const config = require('./config');

/**
 * Per-value cap. Tags travel on every message for the life of an agent, so an
 * IAM-heavy role must not dominate the payload. Actions get the larger budget
 * because they are the field a reviewer actually reads.
 */
const MAX_ACTIONS_CHARS = 1500;
const MAX_FIELD_CHARS = 512;

/**
 * Actions worth surfacing on their own rather than leaving buried in the full
 * list: privilege escalation, credential access, and broad data reach. Matched
 * case-insensitively against the whole `service:Action` string.
 */
const PRIVILEGED_PATTERNS = [
    /^iam:/i, /^sts:AssumeRole/i, /^organizations:/i,
    /^secretsmanager:Get/i, /^secretsmanager:List/i, /^ssm:GetParameter/i,
    /^kms:Decrypt/i, /^kms:GenerateDataKey/i,
    /^s3:GetObject/i, /^s3:PutObject/i, /^s3:DeleteObject/i,
    /^lambda:InvokeFunction/i, /^lambda:UpdateFunctionCode/i, /^lambda:AddPermission/i,
    /^dynamodb:(Get|Put|Delete|Scan|Query)/i,
    /^ec2:RunInstances/i, /^ec2:CreateTags/i,
    /^bedrock:InvokeModel/i, /^bedrock-agentcore:Invoke/i
];

/**
 * Cached per role. Lambda keeps module state for a container's whole life, so an
 * unbounded cache would serve a role's permissions from the moment the container
 * started — hours after a policy changed. A TTL bounds that staleness while still
 * collapsing thousands of messages onto one set of IAM calls.
 */
const PROFILE_TTL_MS = Number(process.env.IAM_PROFILE_TTL_MS || 15 * 60 * 1000);
const profileCache = {};

function cacheGet(key) {
    const entry = profileCache[key];
    if (!entry) return null;
    if (Date.now() - entry.at > PROFILE_TTL_MS) { delete profileCache[key]; return null; }
    return entry.value;
}

function cacheSet(key, value) {
    profileCache[key] = { at: Date.now(), value };
    return value;
}

/**
 * IAM returns policy documents URL-encoded in some paths and pre-parsed in
 * others, depending on SDK version. Accept every shape rather than assume one.
 */
function parsePolicyDocument(doc) {
    if (!doc) return null;
    if (typeof doc === 'object') return doc;
    try {
        return JSON.parse(doc);
    } catch {
        try {
            return JSON.parse(decodeURIComponent(doc));
        } catch {
            return null;
        }
    }
}

/** IAM allows a bare string or an array everywhere a list is accepted. */
function toArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

/** Joins a set into a bounded, comma-separated tag value. */
function joinCapped(values, maxChars) {
    const sorted = [...values].sort();
    const out = [];
    let used = 0;
    for (let i = 0; i < sorted.length; i++) {
        const cost = sorted[i].length + (out.length ? 1 : 0);
        if (used + cost > maxChars) return `${out.join(',')},…+${sorted.length - i} more`;
        out.push(sorted[i]);
        used += cost;
    }
    return out.join(',');
}

/** Folds one policy document's statements into the accumulating profile. */
function absorbStatements(document, acc) {
    for (const statement of toArray(document?.Statement)) {
        acc.statementCount += 1;
        const actions = [...toArray(statement.Action), ...toArray(statement.NotAction)]
            .filter((a) => typeof a === 'string');
        const resources = toArray(statement.Resource).filter((r) => typeof r === 'string');
        for (const resource of resources) acc.resources.add(resource);
        const isDeny = statement.Effect === 'Deny';
        const resourceIsWildcard = resources.some((r) => r === '*');

        for (const action of actions) {
            if (isDeny) { acc.denyActions.add(action); continue; }
            acc.actions.add(action);
            const service = action.includes(':') ? action.split(':')[0] : action;
            if (service && service !== '*') acc.services.add(service);
            if (action.includes('*')) acc.wildcardActions.add(action);
            if (resourceIsWildcard) acc.wildcardResourceActions.add(action);
            if (PRIVILEGED_PATTERNS.some((p) => p.test(action))) acc.privilegedActions.add(action);
            if (action === '*' && resourceIsWildcard) acc.isAdmin = true;
        }
    }
}

/** Reads the trust policy: which principals may assume the role, under which condition keys. */
function readTrustPolicy(document, acc, accountId) {
    for (const statement of toArray(document?.Statement)) {
        if (statement.Effect !== 'Allow') continue;
        const principal = statement.Principal;
        const entries = [];
        if (typeof principal === 'string') entries.push(principal);
        else if (principal && typeof principal === 'object') {
            for (const value of Object.values(principal)) for (const e of toArray(value)) entries.push(String(e));
        }
        for (const entry of entries) {
            acc.trustPrincipals.add(entry);
            // A bare "*" principal means anyone may assume the role — the single
            // most serious thing a trust policy can say.
            if (entry === '*') acc.trustWildcard = true;
            // An IAM ARN whose account differs from the role's own is cross-account trust.
            const match = /^arn:aws[^:]*:(?:iam|sts)::(\d{12}):/.exec(entry);
            if (match && match[1] !== accountId) acc.trustExternalAccounts.add(match[1]);
        }
        for (const operator of Object.values(statement.Condition || {})) {
            for (const key of Object.keys(operator || {})) acc.trustConditions.add(key);
        }
    }
}

/**
 * Builds the security tag set for one execution role.
 *
 * `prefix` names the fields ('harness', 'runtime' or 'bedrock') so the same
 * profile reads correctly whichever resource type owns the role. Cached per
 * role for the life of the invocation — a busy account resolves the same few
 * roles on every message, and IAM is rate-limited.
 */
async function getRoleSecurityProfile(executionRoleArn, prefix) {
    if (!executionRoleArn) return {};
    const roleName = executionRoleArn.split('/').pop();
    const roleAccountId = (/^arn:aws[^:]*:iam::(\d{12}):/.exec(executionRoleArn) || [])[1] || '';
    if (!roleName) return {};

    const cacheKey = `${prefix}:${roleName}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const acc = {
        actions: new Set(), denyActions: new Set(), services: new Set(),
        wildcardActions: new Set(), wildcardResourceActions: new Set(),
        privilegedActions: new Set(), resources: new Set(),
        trustPrincipals: new Set(), trustConditions: new Set(), trustExternalAccounts: new Set(),
        isAdmin: false, trustWildcard: false, statementCount: 0
    };
    const policyVersions = [];
    const policyTypes = [];
    let rolePath = '';
    const attachedNames = [];
    const attachedArns = [];
    const inlineNames = [];
    let permissionsBoundary = '';
    let lastUsed = '';

    // Trust policy + boundary + last-used all come from the one GetRole call.
    try {
        const role = (await config.iamClient.send(new GetRoleCommand({ RoleName: roleName }))).Role || {};
        readTrustPolicy(parsePolicyDocument(role.AssumeRolePolicyDocument), acc, roleAccountId);
        permissionsBoundary = role.PermissionsBoundary?.PermissionsBoundaryArn || '';
        lastUsed = role.RoleLastUsed?.LastUsedDate ? new Date(role.RoleLastUsed.LastUsedDate).toISOString() : '';
        rolePath = role.Path || '';
    } catch (error) {
        console.error(`⚠️ GetRole failed for ${roleName}: ${error.message}`);
    }

    // Attached (managed) policies — names were already reported before this
    // module existed; the documents behind them are what is new.
    try {
        const attached = (await config.iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }))).AttachedPolicies || [];
        for (const policy of attached) {
            attachedNames.push(policy.PolicyName);
            attachedArns.push(policy.PolicyArn);
            try {
                const detail = (await config.iamClient.send(new GetPolicyCommand({ PolicyArn: policy.PolicyArn }))).Policy || {};
                const versionId = detail.DefaultVersionId;
                // Version + update date make a policy change detectable downstream
                // without diffing the whole document.
                policyVersions.push(`${policy.PolicyName}:${versionId || '?'}@${detail.UpdateDate ? new Date(detail.UpdateDate).toISOString().slice(0, 10) : '?'}`);
                policyTypes.push(`${policy.PolicyName}:${String(policy.PolicyArn).startsWith('arn:aws:iam::aws:policy/') ? 'aws-managed' : 'customer-managed'}`);
                if (!versionId) continue;
                const version = await config.iamClient.send(new GetPolicyVersionCommand({ PolicyArn: policy.PolicyArn, VersionId: versionId }));
                absorbStatements(parsePolicyDocument(version.PolicyVersion?.Document), acc);
            } catch (error) {
                console.error(`⚠️ Policy document read failed for ${policy.PolicyArn}: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`⚠️ ListAttachedRolePolicies failed for ${roleName}: ${error.message}`);
    }

    // Inline policies are invisible to ListAttachedRolePolicies, so a role that
    // keeps its real grants inline looked unprivileged until this call existed.
    try {
        const names = (await config.iamClient.send(new ListRolePoliciesCommand({ RoleName: roleName }))).PolicyNames || [];
        for (const name of names) {
            inlineNames.push(name);
            try {
                const inline = await config.iamClient.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: name }));
                absorbStatements(parsePolicyDocument(inline.PolicyDocument), acc);
            } catch (error) {
                console.error(`⚠️ GetRolePolicy failed for ${roleName}/${name}: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`⚠️ ListRolePolicies failed for ${roleName}: ${error.message}`);
    }

    const tags = {
        // Folded in so ListAttachedRolePolicies runs once per role, not twice.
        [`${prefix}-role-policies`]: joinCapped(attachedNames, MAX_FIELD_CHARS),
        [`${prefix}-role-policy-versions`]: joinCapped(policyVersions, MAX_FIELD_CHARS),
        [`${prefix}-role-policy-types`]: joinCapped(policyTypes, MAX_FIELD_CHARS),
        [`${prefix}-role-resources`]: joinCapped(acc.resources, MAX_ACTIONS_CHARS),
        [`${prefix}-role-statement-count`]: String(acc.statementCount),
        [`${prefix}-role-path`]: rolePath,
        [`${prefix}-role-is-service-linked`]: rolePath.startsWith('/aws-service-role/') ? 'true' : 'false',
        [`${prefix}-role-trust-external-accounts`]: joinCapped(acc.trustExternalAccounts, MAX_FIELD_CHARS),
        [`${prefix}-role-trust-wildcard-principal`]: acc.trustWildcard ? 'true' : 'false',
        [`${prefix}-role-policy-arns`]: joinCapped(attachedArns, MAX_FIELD_CHARS),
        [`${prefix}-role-inline-policies`]: joinCapped(inlineNames, MAX_FIELD_CHARS),
        [`${prefix}-role-services`]: joinCapped(acc.services, MAX_FIELD_CHARS),
        [`${prefix}-role-actions`]: joinCapped(acc.actions, MAX_ACTIONS_CHARS),
        [`${prefix}-role-wildcard-actions`]: joinCapped(acc.wildcardActions, MAX_FIELD_CHARS),
        [`${prefix}-role-wildcard-resource-actions`]: joinCapped(acc.wildcardResourceActions, MAX_FIELD_CHARS),
        [`${prefix}-role-privileged-actions`]: joinCapped(acc.privilegedActions, MAX_FIELD_CHARS),
        [`${prefix}-role-deny-actions`]: joinCapped(acc.denyActions, MAX_FIELD_CHARS),
        [`${prefix}-role-is-admin`]: acc.isAdmin ? 'true' : 'false',
        [`${prefix}-role-trust-principals`]: joinCapped(acc.trustPrincipals, MAX_FIELD_CHARS),
        [`${prefix}-role-trust-conditions`]: joinCapped(acc.trustConditions, MAX_FIELD_CHARS),
        [`${prefix}-permissions-boundary`]: permissionsBoundary,
        [`${prefix}-role-last-used`]: lastUsed
    };

    return cacheSet(cacheKey, tags);
}

/** Attached managed policy names only — the pre-existing `{prefix}-role-policies` value. */
async function getAttachedPolicyNames(roleName) {
    if (!roleName) return '';
    const cacheKey = `attached-names:${roleName}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
    try {
        const response = await config.iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
        return cacheSet(cacheKey, response.AttachedPolicies?.map((p) => p.PolicyName).join(',') || '');
    } catch (error) {
        console.error(`⚠️ Policy list failed for role ${roleName}: ${error.message}`);
        return '';
    }
}

module.exports = { getRoleSecurityProfile, getAttachedPolicyNames };
