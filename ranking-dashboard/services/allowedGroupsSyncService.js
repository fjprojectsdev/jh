const crypto = require('crypto');
const { listAllowedGroupsFromBot } = require('../models/allowedGroup.js');
const { createGrupo, findGrupoById } = require('../models/grupo.js');
const { sanitizeText } = require('./supabaseTenantClient.js');

function normalizeForId(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

function buildManagedGroupId(groupName) {
    const safeName = sanitizeText(groupName, 180);
    const slug = normalizeForId(safeName) || 'grupo';
    const hash = crypto.createHash('sha1').update(safeName).digest('hex').slice(0, 12);
    return `bot-${slug}-${hash}`.slice(0, 160);
}

async function vincularGruposAutorizadosAoCliente(clienteId) {
    const safeClienteId = sanitizeText(clienteId, 120);
    if (!safeClienteId) {
        throw new Error('clienteId invalido para sincronizacao de grupos autorizados.');
    }

    const allowed = await listAllowedGroupsFromBot();
    const summary = {
        totalAutorizados: allowed.length,
        criados: 0,
        jaVinculadosAoCliente: 0,
        bloqueadosPorOutroCliente: 0
    };

    for (const group of allowed) {
        const nome = sanitizeText(group && group.nome, 180);
        if (!nome) {
            continue;
        }

        const groupId = buildManagedGroupId(nome);
        const existente = await findGrupoById(groupId);

        if (existente && existente.clienteId === safeClienteId) {
            summary.jaVinculadosAoCliente += 1;
            continue;
        }

        if (existente && existente.clienteId !== safeClienteId) {
            summary.bloqueadosPorOutroCliente += 1;
            continue;
        }

        await createGrupo({
            id: groupId,
            nome,
            clienteId: safeClienteId
        });
        summary.criados += 1;
    }

    return summary;
}

module.exports = {
    vincularGruposAutorizadosAoCliente,
    buildManagedGroupId
};
