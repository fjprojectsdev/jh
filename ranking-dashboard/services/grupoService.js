const {
    findClienteById
} = require('../models/cliente.js');
const {
    listGruposByCliente,
    countGruposByCliente,
    createGrupo,
    updateGrupoName,
    deleteGrupo,
    findGrupoById
} = require('../models/grupo.js');
const {
    countInteracoesByGrupoIds
} = require('../models/interacao.js');

const PLAN_LIMITS = {
    free: {
        maxGrupos: 1,
        maxInteracoesMes: 1000
    },
    pro: {
        maxGrupos: 5,
        maxInteracoesMes: null
    },
    enterprise: {
        maxGrupos: null,
        maxInteracoesMes: null
    }
};

function startOfCurrentMonthIso() {
    const now = new Date();
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function endOfCurrentMonthIso() {
    const now = new Date();
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function validarLimitePlano(clienteId, incrementoInteracoes = 0) {
    const cliente = await findClienteById(clienteId, false);
    if (!cliente) {
        throw new Error('Cliente nao encontrado.');
    }

    const plano = cliente.plano || 'free';
    const limite = PLAN_LIMITS[plano] || PLAN_LIMITS.free;

    const totalGrupos = await countGruposByCliente(cliente.id);
    const grupos = await listGruposByCliente(cliente.id);
    const grupoIds = grupos.map((g) => g.id);

    const inicioMes = startOfCurrentMonthIso();
    const fimMes = endOfCurrentMonthIso();
    const totalInteracoesMes = await countInteracoesByGrupoIds(grupoIds, inicioMes, fimMes);

    return {
        clienteId: cliente.id,
        plano,
        limites: {
            maxGrupos: limite.maxGrupos,
            maxInteracoesMes: limite.maxInteracoesMes
        },
        usoAtual: {
            totalGrupos,
            totalInteracoesMes,
            inicioMes,
            fimMes
        },
        permitidoCriarGrupo: limite.maxGrupos === null ? true : totalGrupos < limite.maxGrupos,
        permitidoInteracoesMes: limite.maxInteracoesMes === null
            ? true
            : (totalInteracoesMes + Math.max(0, Number(incrementoInteracoes) || 0)) <= limite.maxInteracoesMes
    };
}

async function criarGrupoParaCliente(clienteId, payload) {
    const statusPlano = await validarLimitePlano(clienteId);
    if (!statusPlano.permitidoCriarGrupo) {
        const erro = new Error('Limite de grupos do plano atingido.');
        erro.statusCode = 403;
        throw erro;
    }

    const grupoExistente = await findGrupoById(payload.id);
    if (grupoExistente && grupoExistente.clienteId !== clienteId) {
        const erro = new Error('Este grupo ja pertence a outro cliente.');
        erro.statusCode = 403;
        throw erro;
    }

    if (grupoExistente && grupoExistente.clienteId === clienteId) {
        const erro = new Error('Grupo ja cadastrado para este cliente.');
        erro.statusCode = 409;
        throw erro;
    }

    return createGrupo({
        id: payload.id,
        nome: payload.nome,
        clienteId
    });
}

async function editarGrupoDoCliente(clienteId, grupoId, payload) {
    const grupo = await findGrupoById(grupoId);
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

    return updateGrupoName(grupoId, clienteId, payload.nome);
}

async function removerGrupoDoCliente(clienteId, grupoId) {
    const grupo = await findGrupoById(grupoId);
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

    await deleteGrupo(grupoId, clienteId);
}

module.exports = {
    PLAN_LIMITS,
    validarLimitePlano,
    criarGrupoParaCliente,
    editarGrupoDoCliente,
    removerGrupoDoCliente,
    listGruposByCliente
};
