const {
    requestJson,
    requestCount,
    sanitizeText
} = require('../services/supabaseTenantClient.js');

const TABLE = process.env.IMAVY_GRUPOS_TABLE || 'grupos';

function mapGrupoRow(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        nome: row.nome,
        clienteId: row.cliente_id,
        criadoEm: row.criado_em
    };
}

async function listGruposByCliente(clienteId) {
    const safeClienteId = sanitizeText(clienteId, 120);
    const query = `${TABLE}?select=id,nome,cliente_id,criado_em&cliente_id=eq.${encodeURIComponent(safeClienteId)}&order=criado_em.desc`;
    const rows = await requestJson('GET', query);
    return (rows || []).map(mapGrupoRow);
}

async function countGruposByCliente(clienteId) {
    const safeClienteId = sanitizeText(clienteId, 120);
    const query = `${TABLE}?select=id&cliente_id=eq.${encodeURIComponent(safeClienteId)}`;
    return requestCount(query);
}

async function findGrupoById(grupoId) {
    const safeGroupId = sanitizeText(grupoId, 160);
    const query = `${TABLE}?select=id,nome,cliente_id,criado_em&id=eq.${encodeURIComponent(safeGroupId)}&limit=1`;
    const rows = await requestJson('GET', query);
    return mapGrupoRow(Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
}

async function createGrupo(payload) {
    const id = sanitizeText(payload && payload.id, 160);
    const nome = sanitizeText(payload && payload.nome, 180);
    const clienteId = sanitizeText(payload && payload.clienteId, 120);

    if (!id || !nome || !clienteId) {
        throw new Error('id, nome e clienteId sao obrigatorios para criar grupo.');
    }

    const record = {
        id,
        nome,
        cliente_id: clienteId,
        criado_em: new Date().toISOString()
    };

    const query = `${TABLE}?select=id,nome,cliente_id,criado_em`;
    const rows = await requestJson('POST', query, record, {
        headers: {
            Prefer: 'return=representation'
        }
    });

    return mapGrupoRow(Array.isArray(rows) ? rows[0] : null);
}

async function updateGrupoName(grupoId, clienteId, novoNome) {
    const safeGroupId = sanitizeText(grupoId, 160);
    const safeClienteId = sanitizeText(clienteId, 120);
    const safeNome = sanitizeText(novoNome, 180);

    if (!safeNome) {
        throw new Error('Nome do grupo invalido.');
    }

    const query = `${TABLE}?id=eq.${encodeURIComponent(safeGroupId)}&cliente_id=eq.${encodeURIComponent(safeClienteId)}&select=id,nome,cliente_id,criado_em`;
    const rows = await requestJson('PATCH', query, { nome: safeNome }, {
        headers: {
            Prefer: 'return=representation'
        }
    });

    return mapGrupoRow(Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
}

async function deleteGrupo(grupoId, clienteId) {
    const safeGroupId = sanitizeText(grupoId, 160);
    const safeClienteId = sanitizeText(clienteId, 120);

    const query = `${TABLE}?id=eq.${encodeURIComponent(safeGroupId)}&cliente_id=eq.${encodeURIComponent(safeClienteId)}`;
    await requestJson('DELETE', query, undefined, {
        noBody: true,
        headers: {
            Prefer: 'return=minimal'
        }
    });
}

module.exports = {
    listGruposByCliente,
    countGruposByCliente,
    findGrupoById,
    createGrupo,
    updateGrupoName,
    deleteGrupo
};
