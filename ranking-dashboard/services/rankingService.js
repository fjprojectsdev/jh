const gerarRankingParticipantesTexto = require('../../functions/rankingParticipantesTextos.cjs');
const {
    listGruposByCliente,
    findGrupoById
} = require('../models/grupo.js');
const {
    listInteracoesByGrupoIds,
    normalizeDate
} = require('../models/interacao.js');

function mapInteracoesToRankingInput(interacoes) {
    return (interacoes || []).map((item) => ({
        nome: item.participante,
        data: item.data,
        grupo: item.grupoId
    }));
}

async function resolveGrupoIds(clienteId, grupoIdOpcional) {
    const gruposCliente = await listGruposByCliente(clienteId);
    const ids = gruposCliente.map((g) => g.id);

    if (!grupoIdOpcional) {
        return {
            grupoIds: ids,
            gruposConsiderados: gruposCliente
        };
    }

    const grupo = await findGrupoById(grupoIdOpcional);
    if (!grupo) {
        const erro = new Error('Grupo nao encontrado.');
        erro.statusCode = 404;
        throw erro;
    }

    if (grupo.clienteId !== clienteId) {
        const erro = new Error('Acesso negado ao grupo informado.');
        erro.statusCode = 403;
        throw erro;
    }

    return {
        grupoIds: [grupo.id],
        gruposConsiderados: [grupo]
    };
}

async function gerarRankingPorCliente(payload) {
    const clienteId = payload && payload.clienteId;
    const dataInicio = normalizeDate(payload && payload.dataInicio);
    const dataFim = normalizeDate(payload && payload.dataFim);
    const grupoId = payload && payload.grupoId;

    if (!clienteId || !dataInicio || !dataFim) {
        const erro = new Error('clienteId, dataInicio e dataFim sao obrigatorios.');
        erro.statusCode = 400;
        throw erro;
    }

    const { grupoIds, gruposConsiderados } = await resolveGrupoIds(clienteId, grupoId);
    const interacoes = await listInteracoesByGrupoIds(grupoIds, dataInicio, dataFim, 100000);

    const rankingInput = mapInteracoesToRankingInput(interacoes);
    const resultado = gerarRankingParticipantesTexto(rankingInput, dataInicio, dataFim);

    return {
        ...resultado,
        contexto: {
            clienteId,
            dataInicio,
            dataFim,
            totalGruposConsiderados: gruposConsiderados.length,
            gruposConsiderados
        }
    };
}

module.exports = {
    gerarRankingPorCliente
};
