const DEFAULT_TABLE = 'interacoes_texto';
const DEFAULT_MULTI_TENANT_TABLE = 'interacoes_cliente';
const DEFAULT_MULTI_TENANT_GROUPS_TABLE = 'grupos';
const groupOwnerCache = new Map();

let cachedMapRaw = null;
let cachedMapParsed = {};

function getConfig() {
    const url = process.env.IMAVY_SUPABASE_URL || process.env.SUPABASE_URL || '';
    const key =
        process.env.IMAVY_SUPABASE_SERVICE_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.IMAVY_SUPABASE_ANON_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        process.env.IMAVY_SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_KEY ||
        '';
    const tableName = process.env.IMAVY_REALTIME_TABLE || DEFAULT_TABLE;
    const multiTenantTable = process.env.IMAVY_INTERACOES_TABLE || DEFAULT_MULTI_TENANT_TABLE;
    const multiTenantGroupsTable = process.env.IMAVY_GRUPOS_TABLE || DEFAULT_MULTI_TENANT_GROUPS_TABLE;
    const enabled = String(process.env.IMAVY_REALTIME_ENABLED || 'true').toLowerCase() !== 'false';
    const multiTenantEnabled = String(process.env.IMAVY_MULTITENANT_WRITE_ENABLED || 'true').toLowerCase() !== 'false';
    const multiTenantStrict = String(process.env.IMAVY_MULTITENANT_STRICT || 'false').toLowerCase() === 'true';
    const groupClientMapRaw = String(process.env.IMAVY_GROUP_CLIENTE_MAP || process.env.IMAVY_TENANT_GROUP_MAP || '').trim();

    return {
        url,
        key,
        tableName,
        multiTenantTable,
        multiTenantGroupsTable,
        enabled,
        multiTenantEnabled,
        multiTenantStrict,
        groupClientMapRaw
    };
}

function toIsoDate(dateObj) {
    const y = dateObj.getUTCFullYear();
    const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function sanitizeText(value, maxLen = 1800) {
    const text = String(value || '').trim();
    if (text.length <= maxLen) {
        return text;
    }

    return text.slice(0, maxLen);
}

function getGroupClientMap(rawMap) {
    if (!rawMap) {
        cachedMapRaw = '';
        cachedMapParsed = {};
        return cachedMapParsed;
    }

    if (rawMap === cachedMapRaw) {
        return cachedMapParsed;
    }

    try {
        const parsed = JSON.parse(rawMap);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            cachedMapRaw = rawMap;
            cachedMapParsed = parsed;
            return cachedMapParsed;
        }
    } catch (_) {}

    cachedMapRaw = rawMap;
    cachedMapParsed = {};
    return cachedMapParsed;
}

function resolveTenantContext(payload, groupClientMap) {
    const clienteIdFromPayload = sanitizeText(payload && payload.clienteId, 120);
    const grupoId = sanitizeText(payload && payload.grupoId, 160);
    const grupoNome = sanitizeText(payload && payload.grupo, 180) || grupoId;

    if (!grupoId) {
        return null;
    }

    if (clienteIdFromPayload) {
        return {
            clienteId: clienteIdFromPayload,
            grupoId,
            grupoNome
        };
    }

    const mapped = groupClientMap[grupoId];
    if (!mapped) {
        return null;
    }

    if (typeof mapped === 'string') {
        const clienteId = sanitizeText(mapped, 120);
        if (!clienteId) {
            return null;
        }

        return {
            clienteId,
            grupoId,
            grupoNome
        };
    }

    if (mapped && typeof mapped === 'object') {
        const clienteId = sanitizeText(mapped.clienteId || mapped.clientId, 120);
        const mappedNome = sanitizeText(mapped.nome || mapped.groupName, 180);
        if (!clienteId) {
            return null;
        }

        return {
            clienteId,
            grupoId,
            grupoNome: mappedNome || grupoNome
        };
    }

    return null;
}

async function ensureGroupOwnership(config, tenantCtx, createdAtIso) {
    const cacheKey = tenantCtx.grupoId;
    const cachedOwner = groupOwnerCache.get(cacheKey);

    if (cachedOwner) {
        if (cachedOwner !== tenantCtx.clienteId) {
            throw new Error('Grupo ja pertence a outro cliente.');
        }
        return;
    }

    const queryUrl = `${config.url}/rest/v1/${config.multiTenantGroupsTable}?select=id,cliente_id&id=eq.${encodeURIComponent(tenantCtx.grupoId)}&limit=1`;
    const lookupResponse = await fetch(queryUrl, {
        method: 'GET',
        headers: {
            apikey: config.key,
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json'
        }
    });

    if (!lookupResponse.ok) {
        const err = await lookupResponse.text();
        throw new Error(`Erro ao consultar grupo multi-tenant (${lookupResponse.status}): ${err}`);
    }

    const rows = await lookupResponse.json();
    const existing = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    if (existing) {
        const currentOwner = sanitizeText(existing.cliente_id, 120);
        if (currentOwner && currentOwner !== tenantCtx.clienteId) {
            throw new Error('Grupo ja pertence a outro cliente.');
        }
        groupOwnerCache.set(cacheKey, tenantCtx.clienteId);
        return;
    }

    const createGroupRecord = {
        id: tenantCtx.grupoId,
        nome: tenantCtx.grupoNome || tenantCtx.grupoId,
        cliente_id: tenantCtx.clienteId,
        criado_em: createdAtIso
    };

    const createResponse = await fetch(`${config.url}/rest/v1/${config.multiTenantGroupsTable}`, {
        method: 'POST',
        headers: {
            apikey: config.key,
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
        },
        body: JSON.stringify(createGroupRecord)
    });

    if (!createResponse.ok) {
        const err = await createResponse.text();
        throw new Error(`Erro ao criar grupo multi-tenant (${createResponse.status}): ${err}`);
    }

    groupOwnerCache.set(cacheKey, tenantCtx.clienteId);
}

async function persistMultiTenantInteraction(config, payload, dateObj, nome, messageId) {
    const groupClientMap = getGroupClientMap(config.groupClientMapRaw);
    const tenantCtx = resolveTenantContext(payload, groupClientMap);

    if (!tenantCtx) {
        return { ok: false, skipped: true, reason: 'tenant_context_not_resolved' };
    }

    const createdAtIso = dateObj.toISOString();
    await ensureGroupOwnership(config, tenantCtx, createdAtIso);

    const multiTenantRecord = {
        id: messageId,
        participante: nome,
        data: toIsoDate(dateObj),
        grupo_id: tenantCtx.grupoId,
        criado_em: createdAtIso
    };

    const mtResponse = await fetch(`${config.url}/rest/v1/${config.multiTenantTable}?on_conflict=id`, {
        method: 'POST',
        headers: {
            apikey: config.key,
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(multiTenantRecord)
    });

    if (!mtResponse.ok) {
        const mtErr = await mtResponse.text();
        throw new Error(`Erro Supabase multi-tenant (${mtResponse.status}): ${mtErr}`);
    }

    return { ok: true };
}

export async function publishRealtimeInteraction(payload) {
    const config = getConfig();
    const {
        url,
        key,
        tableName,
        enabled,
        multiTenantEnabled,
        multiTenantStrict
    } = config;

    if (!enabled) {
        return { ok: false, skipped: true, reason: 'disabled' };
    }

    if (!url || !key) {
        return { ok: false, skipped: true, reason: 'supabase_not_configured' };
    }

    const messageId = String(payload.messageId || '').trim();
    const nome = String(payload.nome || '').trim();
    const grupo = String(payload.grupo || '').trim();
    const grupoId = String(payload.grupoId || '').trim();
    const senderId = String(payload.senderId || '').trim();
    const texto = sanitizeText(payload.texto || '');

    if (!messageId || !nome || !grupo || !payload.dataIso) {
        return { ok: false, skipped: true, reason: 'invalid_payload' };
    }

    const dateObj = new Date(payload.dataIso);
    if (Number.isNaN(dateObj.getTime())) {
        return { ok: false, skipped: true, reason: 'invalid_date' };
    }

    const record = {
        message_id: messageId,
        nome,
        grupo,
        grupo_id: grupoId,
        sender_id: senderId,
        texto,
        data: toIsoDate(dateObj),
        created_at: dateObj.toISOString()
    };

    const response = await fetch(`${url}/rest/v1/${tableName}?on_conflict=message_id`, {
        method: 'POST',
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(record)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Erro Supabase realtime (${response.status}): ${err}`);
    }

    if (multiTenantEnabled) {
        try {
            const mtResult = await persistMultiTenantInteraction(config, payload, dateObj, nome, messageId);
            if (mtResult && mtResult.skipped) {
                return { ok: true, multiTenant: mtResult };
            }
        } catch (error) {
            if (multiTenantStrict) {
                throw error;
            }

            return {
                ok: true,
                multiTenant: {
                    ok: false,
                    skipped: true,
                    reason: 'multi_tenant_write_failed',
                    error: error.message
                }
            };
        }
    }

    return { ok: true };
}
