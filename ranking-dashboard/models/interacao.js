const {
    requestJson,
    requestCount,
    sanitizeText
} = require('../services/supabaseTenantClient.js');

const TABLE = process.env.IMAVY_INTERACOES_TABLE || 'interacoes_cliente';

function mapInteracaoRow(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        participante: row.participante,
        data: row.data,
        grupoId: row.grupo_id,
        criadoEm: row.criado_em
    };
}

function normalizeDate(value) {
    const safe = sanitizeText(value, 20);
    return /^\d{4}-\d{2}-\d{2}$/.test(safe) ? safe : null;
}

function buildGrupoInFilter(grupoIds) {
    const ids = (grupoIds || [])
        .map((id) => sanitizeText(id, 160))
        .filter(Boolean)
        .map((id) => `"${id.replace(/"/g, '\\"')}"`);

    if (ids.length === 0) {
        return null;
    }

    return `(${ids.join(',')})`;
}

async function createInteracao(payload) {
    const id = sanitizeText(payload && payload.id, 180);
    const participante = sanitizeText(payload && payload.participante, 160);
    const data = normalizeDate(payload && payload.data);
    const grupoId = sanitizeText(payload && payload.grupoId, 160);

    if (!id || !participante || !data || !grupoId) {
        throw new Error('Dados invalidos para criar interacao.');
    }

    const record = {
        id,
        participante,
        data,
        grupo_id: grupoId,
        criado_em: new Date().toISOString()
    };

    const query = `${TABLE}?select=id,participante,data,grupo_id,criado_em`;
    const rows = await requestJson('POST', query, record, {
        headers: {
            Prefer: 'return=representation'
        }
    });

    return mapInteracaoRow(Array.isArray(rows) ? rows[0] : null);
}

async function listInteracoesByGrupoIds(grupoIds, dataInicio, dataFim, limit = 50000) {
    const grupoFilter = buildGrupoInFilter(grupoIds);
    const start = normalizeDate(dataInicio);
    const end = normalizeDate(dataFim);

    if (!grupoFilter || !start || !end) {
        return [];
    }

    const query = `${TABLE}?select=id,participante,data,grupo_id,criado_em&grupo_id=in.${encodeURIComponent(grupoFilter)}&data=gte.${encodeURIComponent(start)}&data=lte.${encodeURIComponent(end)}&order=data.asc&limit=${Number(limit) || 50000}`;
    const rows = await requestJson('GET', query);

    return (rows || []).map(mapInteracaoRow);
}

async function countInteracoesByGrupoIds(grupoIds, dataInicio, dataFim) {
    const grupoFilter = buildGrupoInFilter(grupoIds);
    const start = normalizeDate(dataInicio);
    const end = normalizeDate(dataFim);

    if (!grupoFilter || !start || !end) {
        return 0;
    }

    const query = `${TABLE}?select=id&grupo_id=in.${encodeURIComponent(grupoFilter)}&data=gte.${encodeURIComponent(start)}&data=lte.${encodeURIComponent(end)}`;
    return requestCount(query);
}

module.exports = {
    normalizeDate,
    createInteracao,
    listInteracoesByGrupoIds,
    countInteracoesByGrupoIds
};
