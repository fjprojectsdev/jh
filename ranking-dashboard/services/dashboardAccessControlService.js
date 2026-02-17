const fs = require('fs');
const path = require('path');
const { sanitizeText, sanitizeEmail } = require('./supabaseTenantClient.js');
const { listGruposByCliente } = require('../models/grupo.js');

const DASHBOARD_ACCESS_PATH = path.resolve(__dirname, '..', '..', 'dashboard_access.json');
const DEVELOPER_ADMIN_EMAILS_DEFAULT = new Set([
    'flaviojhonatan2020@gmail.com'
]);
const FORCED_VISIBLE_GROUPS = [
    'CriptoNoPix é Vellora (1)',
    'CriptoNoPix é Vellora (2)',
    'SQUAD Web3 | @AlexCPO_'
];
const FORCED_VISIBLE_GROUPS_SET = new Set(FORCED_VISIBLE_GROUPS.map((name) => normalizeGroupName(name)));

function normalizeGroupName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function uniqueStrings(values, maxLen = 180) {
    const out = [];
    const seen = new Set();

    for (const value of Array.isArray(values) ? values : []) {
        const safe = sanitizeText(value, maxLen);
        if (!safe || seen.has(safe)) {
            continue;
        }

        seen.add(safe);
        out.push(safe);
    }

    return out;
}

function uniqueNormalizedNames(values) {
    const out = [];
    const seen = new Set();

    for (const value of Array.isArray(values) ? values : []) {
        const safe = sanitizeText(value, 180);
        const normalized = normalizeGroupName(safe);

        if (!safe || !normalized || seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        out.push(safe);
    }

    return out;
}

function defaultPolicy(clienteId) {
    return {
        clienteId: sanitizeText(clienteId, 120),
        allowMultipleGroups: true,
        maxGroups: null,
        primaryGroupId: '',
        allowedGroupIds: [],
        allowedGroupNames: [],
        updatedAt: null,
        updatedBy: ''
    };
}

function normalizePolicy(policy, clienteId) {
    const base = defaultPolicy(clienteId);
    const allowMultipleGroups = policy && typeof policy.allowMultipleGroups === 'boolean'
        ? policy.allowMultipleGroups
        : base.allowMultipleGroups;

    let maxGroups = null;
    if (allowMultipleGroups) {
        if (policy && policy.maxGroups !== undefined && policy.maxGroups !== null && String(policy.maxGroups).trim() !== '') {
            const parsed = Math.floor(Number(policy.maxGroups));
            maxGroups = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        }
    } else {
        maxGroups = 1;
    }

    return {
        clienteId: base.clienteId,
        allowMultipleGroups,
        maxGroups,
        primaryGroupId: sanitizeText(policy && policy.primaryGroupId, 160),
        allowedGroupIds: uniqueStrings(policy && policy.allowedGroupIds, 160),
        allowedGroupNames: uniqueNormalizedNames(policy && policy.allowedGroupNames),
        updatedAt: sanitizeText(policy && policy.updatedAt, 60) || null,
        updatedBy: sanitizeText(policy && policy.updatedBy, 180)
    };
}

function safeReadAccessStore() {
    try {
        if (!fs.existsSync(DASHBOARD_ACCESS_PATH)) {
            return { policies: {} };
        }

        const raw = fs.readFileSync(DASHBOARD_ACCESS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const policies = parsed && typeof parsed === 'object' && parsed.policies && typeof parsed.policies === 'object'
            ? parsed.policies
            : {};

        return { policies };
    } catch (_) {
        return { policies: {} };
    }
}

function safeWriteAccessStore(store) {
    const payload = {
        updatedAt: new Date().toISOString(),
        policies: store && store.policies && typeof store.policies === 'object' ? store.policies : {}
    };

    fs.writeFileSync(DASHBOARD_ACCESS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function listDashboardAccessPolicies() {
    const store = safeReadAccessStore();
    const out = {};

    for (const [clienteId, policy] of Object.entries(store.policies || {})) {
        const safeId = sanitizeText(clienteId, 120);
        if (!safeId) {
            continue;
        }
        out[safeId] = normalizePolicy(policy, safeId);
    }

    return out;
}

function getDashboardAccessPolicy(clienteId) {
    const safeClienteId = sanitizeText(clienteId, 120);
    const policies = listDashboardAccessPolicies();
    return policies[safeClienteId] || defaultPolicy(safeClienteId);
}

function upsertDashboardAccessPolicy(payload) {
    const safeClienteId = sanitizeText(payload && payload.clienteId, 120);
    if (!safeClienteId) {
        throw new Error('clienteId invalido para atualizar politica de acesso.');
    }

    const current = getDashboardAccessPolicy(safeClienteId);
    const merged = {
        ...current,
        clienteId: safeClienteId,
        updatedAt: new Date().toISOString(),
        updatedBy: sanitizeEmail(payload && payload.updatedBy)
    };

    const fields = ['allowMultipleGroups', 'maxGroups', 'primaryGroupId', 'allowedGroupIds', 'allowedGroupNames'];
    for (const field of fields) {
        if (payload && payload[field] !== undefined) {
            merged[field] = payload[field];
        }
    }

    const normalized = normalizePolicy(merged, safeClienteId);
    const store = safeReadAccessStore();
    store.policies[safeClienteId] = normalized;
    safeWriteAccessStore(store);
    return normalized;
}

function clearDashboardAccessPolicy(clienteId) {
    const safeClienteId = sanitizeText(clienteId, 120);
    const store = safeReadAccessStore();
    delete store.policies[safeClienteId];
    safeWriteAccessStore(store);
}

function applyPolicyToGroups(grupos, policy) {
    const available = Array.isArray(grupos) ? grupos.slice() : [];
    const safePolicy = normalizePolicy(policy, policy && policy.clienteId);

    let filtered = available;

    if (safePolicy.allowedGroupIds.length > 0) {
        const ids = new Set(safePolicy.allowedGroupIds);
        filtered = filtered.filter((g) => ids.has(g.id));
    }

    if (safePolicy.allowedGroupNames.length > 0) {
        const names = new Set(safePolicy.allowedGroupNames.map((name) => normalizeGroupName(name)));
        filtered = filtered.filter((g) => names.has(normalizeGroupName(g.nome)));
    }

    // Escopo fixo de grupos visiveis no dashboard principal.
    filtered = filtered.filter((g) => FORCED_VISIBLE_GROUPS_SET.has(normalizeGroupName(g.nome)));

    filtered.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));

    if (safePolicy.primaryGroupId) {
        const idx = filtered.findIndex((g) => g.id === safePolicy.primaryGroupId);
        if (idx > 0) {
            const [first] = filtered.splice(idx, 1);
            filtered.unshift(first);
        }
    }

    const maxGroups = Number(safePolicy.maxGroups);
    if (Number.isFinite(maxGroups) && maxGroups > 0) {
        filtered = filtered.slice(0, maxGroups);
    }

    return filtered;
}

async function resolveDashboardAccessForCliente(clienteId) {
    const safeClienteId = sanitizeText(clienteId, 120);
    const gruposDisponiveis = await listGruposByCliente(safeClienteId);
    const policy = getDashboardAccessPolicy(safeClienteId);
    const gruposVisiveis = applyPolicyToGroups(gruposDisponiveis, policy);

    const nomesVisiveis = gruposVisiveis.map((g) => sanitizeText(g.nome, 180)).filter(Boolean);
    const nomesFallback = uniqueNormalizedNames(policy.allowedGroupNames);
    const permittedGroupNames = nomesVisiveis.length > 0 ? nomesVisiveis : nomesFallback;

    return {
        policy,
        gruposDisponiveis,
        gruposVisiveis,
        permittedGroupNames
    };
}

function getDashboardDeveloperAdminEmails() {
    const emails = new Set(DEVELOPER_ADMIN_EMAILS_DEFAULT);
    const fromEnv = String(process.env.IMAVY_DASHBOARD_DEVELOPER_ADMINS || '').split(',');

    for (const value of fromEnv) {
        const safeEmail = sanitizeEmail(value);
        if (safeEmail) {
            emails.add(safeEmail);
        }
    }

    return Array.from(emails);
}

function isDashboardDeveloperAdminEmail(email) {
    const safeEmail = sanitizeEmail(email);
    if (!safeEmail) {
        return false;
    }

    const list = getDashboardDeveloperAdminEmails();
    return list.includes(safeEmail);
}

function getDashboardRoleForEmail(email) {
    return isDashboardDeveloperAdminEmail(email) ? 'developer_admin' : 'cliente';
}

module.exports = {
    DASHBOARD_ACCESS_PATH,
    normalizeGroupName,
    getDashboardRoleForEmail,
    isDashboardDeveloperAdminEmail,
    getDashboardAccessPolicy,
    listDashboardAccessPolicies,
    upsertDashboardAccessPolicy,
    clearDashboardAccessPolicy,
    resolveDashboardAccessForCliente
};
