import axios from 'axios';

const BASE_URL = String(
    process.env.MULTITENANT_BASE_URL ||
    process.env.API_BASE_URL ||
    'http://localhost:3010'
).replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = Number(process.env.MULTITENANT_TIMEOUT_MS || 30000);

const api = axios.create({
    baseURL: BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
    headers: {
        'Content-Type': 'application/json'
    }
});

function logOk(descricao) {
    console.log(`TESTE OK -> ${descricao}`);
}

function logErro(descricao, detalhe) {
    console.error(`ERRO -> ${descricao}`);
    if (detalhe !== undefined) {
        console.error(typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe, null, 2));
    }
}

function formatBody(body) {
    if (body === undefined || body === null) {
        return '<sem corpo>';
    }
    try {
        return JSON.stringify(body, null, 2);
    } catch (_) {
        return String(body);
    }
}

function isoDateUtc(deltaDays = 0) {
    const now = new Date();
    const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + deltaDays));
    return utc.toISOString().slice(0, 10);
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function authHeaders(token) {
    return {
        Authorization: `Bearer ${token}`
    };
}

function validarResposta(response, expectedStatus, descricao) {
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const { status, data } = response;

    if (!statuses.includes(status)) {
        throw new Error(
            `${descricao}: status esperado ${statuses.join(' ou ')}, recebido ${status}. Corpo: ${formatBody(data)}`
        );
    }

    if (data && typeof data === 'object' && data.ok === false) {
        throw new Error(`${descricao}: API retornou ok=false. Corpo: ${formatBody(data)}`);
    }

    return data;
}

async function criarCliente({ nome, email, senha, plano }) {
    const response = await api.post('/api/auth/register', { nome, email, senha, plano });

    if (response.status === 409) {
        logOk(`Cliente ${email} ja cadastrado.`);
        return { jaExiste: true };
    }

    const data = validarResposta(response, 201, `Registro de cliente ${email}`);
    logOk(`Registro concluido para ${email}.`);
    return data;
}

async function login({ email, senha }) {
    const response = await api.post('/api/auth/login', { email, senha });
    const data = validarResposta(response, 200, `Login de ${email}`);

    assert(typeof data.token === 'string' && data.token.length > 10, `Token invalido para ${email}.`);
    logOk(`Login concluido para ${email}.`);

    return {
        token: data.token,
        cliente: data.cliente
    };
}

async function criarGrupo(token, { id, nome }) {
    const response = await api.post('/api/grupos', { id, nome }, { headers: authHeaders(token) });
    const data = validarResposta(response, 201, `Criacao do grupo ${nome}`);

    assert(data.grupo && data.grupo.id === id, `Grupo criado sem id esperado (${id}).`);
    logOk(`Grupo criado: ${nome} (${id}).`);
    return data.grupo;
}

async function criarInteracao(token, { id, participante, data, grupoId }) {
    const response = await api.post(
        '/api/dashboard/interacoes',
        { id, participante, data, grupoId },
        { headers: authHeaders(token) }
    );

    const payload = validarResposta(response, 201, `Criacao de interacao ${id}`);
    assert(payload.interacao && payload.interacao.id === id, `Interacao ${id} nao retornou corretamente.`);
    logOk(`Interacao criada: ${id} (${participante} -> ${grupoId} em ${data}).`);
    return payload.interacao;
}

async function gerarRanking(token, { dataInicio, dataFim, grupoId }) {
    const response = await api.get('/api/dashboard/ranking', {
        params: {
            dataInicio,
            dataFim,
            ...(grupoId ? { grupoId } : {})
        },
        headers: authHeaders(token)
    });

    const data = validarResposta(response, 200, `Ranking ${grupoId || 'geral'} de ${dataInicio} ate ${dataFim}`);
    assert(data.resumo && typeof data.resumo.totalGeral === 'number', 'Ranking sem resumo.totalGeral.');
    logOk(`Ranking gerado (${grupoId || 'todos os grupos'}) com total ${data.resumo.totalGeral}.`);
    return data;
}

async function listarGrupos(token) {
    const response = await api.get('/api/grupos', { headers: authHeaders(token) });
    const data = validarResposta(response, 200, 'Listagem de grupos');
    assert(Array.isArray(data.grupos), 'Resposta de grupos sem array.');
    return data.grupos;
}

function validarOrdenacaoRanking(ranking, descricao) {
    const rows = Array.isArray(ranking.rankingCompleto) ? ranking.rankingCompleto : [];

    for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1];
        const curr = rows[i];

        if (prev.total < curr.total) {
            throw new Error(`${descricao}: ordenacao invalida (total crescente em ${prev.nome}/${curr.nome}).`);
        }

        if (prev.total === curr.total && prev.nome.localeCompare(curr.nome, 'pt-BR', { sensitivity: 'base' }) > 0) {
            throw new Error(`${descricao}: desempate alfabetico invalido em ${prev.nome}/${curr.nome}.`);
        }
    }

    logOk(`${descricao}: ordenacao validada.`);
}

async function esperarErroDeAcesso(descricao, requestFn) {
    const response = await requestFn();
    const status = response.status;

    if (status !== 403 && status !== 404) {
        throw new Error(`${descricao}: esperado 403/404, recebido ${status}. Corpo: ${formatBody(response.data)}`);
    }

    logOk(`${descricao}: bloqueio confirmado (${status}).`);
}

async function removerGrupo(token, grupoId) {
    const response = await api.delete(`/api/grupos/${encodeURIComponent(grupoId)}`, {
        headers: authHeaders(token)
    });

    if (response.status === 200 || response.status === 204) {
        logOk(`Limpeza: grupo ${grupoId} removido.`);
        return;
    }

    logErro(`Limpeza: falha ao remover grupo ${grupoId}`, {
        status: response.status,
        body: response.data
    });
}

async function executar() {
    const runId = Date.now();
    const datas = {
        diaA: isoDateUtc(-4),
        diaB: isoDateUtc(-1)
    };

    const createdGroups = [];

    console.log(`Iniciando testes multi-tenant em ${BASE_URL}`);
    console.log(`Janela de datas: ${datas.diaA} ate ${datas.diaB}`);

    const victor = {
        nome: 'Victor',
        email: 'victor@email.com',
        senha: 'senha123',
        plano: 'enterprise'
    };

    const maria = {
        nome: 'Maria',
        email: 'maria@email.com',
        senha: 'senha123',
        plano: 'enterprise'
    };

    try {
        await criarCliente(victor);
        await criarCliente(maria);

        const victorLogin = await login(victor);
        const mariaLogin = await login(maria);
        const victorToken = victorLogin.token;
        const mariaToken = mariaLogin.token;

        const grupos = {
            victorCripto: await criarGrupo(victorToken, {
                id: `victor-cripto-${runId}@g.us`,
                nome: 'Cripto'
            }),
            victorForex: await criarGrupo(victorToken, {
                id: `victor-forex-${runId}@g.us`,
                nome: 'Forex'
            }),
            mariaNft: await criarGrupo(mariaToken, {
                id: `maria-nft-${runId}@g.us`,
                nome: 'NFT'
            })
        };

        createdGroups.push(
            { token: victorToken, id: grupos.victorCripto.id },
            { token: victorToken, id: grupos.victorForex.id },
            { token: mariaToken, id: grupos.mariaNft.id }
        );

        let seq = 0;
        const nextId = (prefix) => `${prefix}-${runId}-${++seq}`;

        // Victor: 5 mensagens em Cripto (3 no diaA + 2 no diaB).
        for (let i = 0; i < 3; i += 1) {
            await criarInteracao(victorToken, {
                id: nextId('vx-cripto-a'),
                participante: 'Satoshi',
                data: datas.diaA,
                grupoId: grupos.victorCripto.id
            });
        }

        for (let i = 0; i < 2; i += 1) {
            await criarInteracao(victorToken, {
                id: nextId('vx-cripto-b'),
                participante: 'Nakamoto',
                data: datas.diaB,
                grupoId: grupos.victorCripto.id
            });
        }

        // Victor: 3 mensagens em Forex (diaA).
        for (let i = 0; i < 3; i += 1) {
            await criarInteracao(victorToken, {
                id: nextId('vx-forex-a'),
                participante: 'TraderX',
                data: datas.diaA,
                grupoId: grupos.victorForex.id
            });
        }

        // Maria: 7 mensagens em NFT (5 no diaA + 2 no diaB).
        for (let i = 0; i < 5; i += 1) {
            await criarInteracao(mariaToken, {
                id: nextId('mr-nft-a'),
                participante: 'MariaUser',
                data: datas.diaA,
                grupoId: grupos.mariaNft.id
            });
        }

        for (let i = 0; i < 2; i += 1) {
            await criarInteracao(mariaToken, {
                id: nextId('mr-nft-b'),
                participante: 'MariaUser',
                data: datas.diaB,
                grupoId: grupos.mariaNft.id
            });
        }

        const gruposVictor = await listarGrupos(victorToken);
        const gruposMaria = await listarGrupos(mariaToken);
        const idsVictor = new Set(gruposVictor.map((g) => g.id));
        const idsMaria = new Set(gruposMaria.map((g) => g.id));

        assert(idsVictor.has(grupos.victorCripto.id), 'Victor nao encontrou grupo Cripto.');
        assert(idsVictor.has(grupos.victorForex.id), 'Victor nao encontrou grupo Forex.');
        assert(!idsVictor.has(grupos.mariaNft.id), 'Victor enxergou grupo da Maria.');
        logOk('Isolamento de grupos: Victor nao enxerga grupo da Maria.');

        assert(idsMaria.has(grupos.mariaNft.id), 'Maria nao encontrou grupo NFT.');
        assert(!idsMaria.has(grupos.victorCripto.id), 'Maria enxergou grupo Cripto do Victor.');
        assert(!idsMaria.has(grupos.victorForex.id), 'Maria enxergou grupo Forex do Victor.');
        logOk('Isolamento de grupos: Maria nao enxerga grupos do Victor.');

        await esperarErroDeAcesso(
            'Victor tentando editar grupo da Maria',
            () => api.put(
                `/api/grupos/${encodeURIComponent(grupos.mariaNft.id)}`,
                { nome: 'Invadido' },
                { headers: authHeaders(victorToken) }
            )
        );

        await esperarErroDeAcesso(
            'Maria tentando editar grupo do Victor',
            () => api.put(
                `/api/grupos/${encodeURIComponent(grupos.victorCripto.id)}`,
                { nome: 'Invadido' },
                { headers: authHeaders(mariaToken) }
            )
        );

        await esperarErroDeAcesso(
            'Victor tentando gerar ranking com grupo da Maria',
            () => api.get('/api/dashboard/ranking', {
                params: { dataInicio: datas.diaA, dataFim: datas.diaB, grupoId: grupos.mariaNft.id },
                headers: authHeaders(victorToken)
            })
        );

        await esperarErroDeAcesso(
            'Maria tentando gerar ranking com grupo do Victor',
            () => api.get('/api/dashboard/ranking', {
                params: { dataInicio: datas.diaA, dataFim: datas.diaB, grupoId: grupos.victorCripto.id },
                headers: authHeaders(mariaToken)
            })
        );

        const rankingVictorGeral = await gerarRanking(victorToken, {
            dataInicio: datas.diaA,
            dataFim: datas.diaB
        });

        assert(rankingVictorGeral.resumo.totalGeral === 8, `Total Victor geral esperado 8, recebido ${rankingVictorGeral.resumo.totalGeral}.`);
        validarOrdenacaoRanking(rankingVictorGeral, 'Ranking geral Victor');

        const nomesVictor = (rankingVictorGeral.rankingCompleto || []).map((r) => r.nome);
        assert(!nomesVictor.includes('MariaUser'), 'Ranking Victor contem dado da Maria.');

        const topVictor = rankingVictorGeral.rankingCompleto || [];
        assert(topVictor[0] && topVictor[0].nome === 'Satoshi' && topVictor[0].total === 3, 'Top 1 Victor invalido.');
        assert(topVictor[1] && topVictor[1].nome === 'TraderX' && topVictor[1].total === 3, 'Top 2 Victor invalido.');
        assert(topVictor[2] && topVictor[2].nome === 'Nakamoto' && topVictor[2].total === 2, 'Top 3 Victor invalido.');
        logOk('Ranking geral Victor validado (total, ordenacao e isolamento).');

        const rankingVictorCripto = await gerarRanking(victorToken, {
            dataInicio: datas.diaA,
            dataFim: datas.diaB,
            grupoId: grupos.victorCripto.id
        });

        assert(rankingVictorCripto.resumo.totalGeral === 5, `Total Victor Cripto esperado 5, recebido ${rankingVictorCripto.resumo.totalGeral}.`);
        const nomesCripto = new Set((rankingVictorCripto.rankingCompleto || []).map((r) => r.nome));
        assert(nomesCripto.has('Satoshi') && nomesCripto.has('Nakamoto'), 'Ranking Cripto sem participantes esperados.');
        assert(!nomesCripto.has('TraderX') && !nomesCripto.has('MariaUser'), 'Ranking Cripto contem dados indevidos.');
        logOk('Ranking do grupo Cripto validado.');

        const rankingVictorForex = await gerarRanking(victorToken, {
            dataInicio: datas.diaA,
            dataFim: datas.diaB,
            grupoId: grupos.victorForex.id
        });

        assert(rankingVictorForex.resumo.totalGeral === 3, `Total Victor Forex esperado 3, recebido ${rankingVictorForex.resumo.totalGeral}.`);
        const forexRows = rankingVictorForex.rankingCompleto || [];
        assert(forexRows.length === 1 && forexRows[0].nome === 'TraderX' && forexRows[0].total === 3, 'Ranking Forex invalido.');
        logOk('Ranking do grupo Forex validado.');

        const rankingMariaGeral = await gerarRanking(mariaToken, {
            dataInicio: datas.diaA,
            dataFim: datas.diaB
        });

        assert(rankingMariaGeral.resumo.totalGeral === 7, `Total Maria geral esperado 7, recebido ${rankingMariaGeral.resumo.totalGeral}.`);
        const nomesMaria = (rankingMariaGeral.rankingCompleto || []).map((r) => r.nome);
        assert(nomesMaria.includes('MariaUser'), 'Ranking Maria nao contem MariaUser.');
        assert(!nomesMaria.includes('Satoshi') && !nomesMaria.includes('TraderX') && !nomesMaria.includes('Nakamoto'), 'Ranking Maria contem dados do Victor.');
        logOk('Ranking geral Maria validado (total e isolamento).');

        const rankingVictorDiaB = await gerarRanking(victorToken, {
            dataInicio: datas.diaB,
            dataFim: datas.diaB
        });
        assert(rankingVictorDiaB.resumo.totalGeral === 2, `Victor diaB esperado 2, recebido ${rankingVictorDiaB.resumo.totalGeral}.`);
        assert((rankingVictorDiaB.rankingCompleto || []).length === 1, 'Victor diaB deveria ter 1 participante.');
        assert((rankingVictorDiaB.rankingCompleto || [])[0].nome === 'Nakamoto', 'Victor diaB deveria conter somente Nakamoto.');
        logOk('Filtro de periodo Victor validado.');

        const rankingMariaDiaB = await gerarRanking(mariaToken, {
            dataInicio: datas.diaB,
            dataFim: datas.diaB
        });
        assert(rankingMariaDiaB.resumo.totalGeral === 2, `Maria diaB esperado 2, recebido ${rankingMariaDiaB.resumo.totalGeral}.`);
        assert((rankingMariaDiaB.rankingCompleto || []).length === 1, 'Maria diaB deveria ter 1 participante.');
        assert((rankingMariaDiaB.rankingCompleto || [])[0].nome === 'MariaUser', 'Maria diaB deveria conter somente MariaUser.');
        logOk('Filtro de periodo Maria validado.');

        console.log('');
        console.log('TESTE OK -> Cenario multi-tenant completo finalizado com sucesso.');
    } catch (error) {
        logErro('Falha geral no fluxo de testes multi-tenant', error.message || error);
        process.exitCode = 1;
    } finally {
        // Limpeza best-effort dos grupos criados no teste para evitar acúmulo.
        for (const group of createdGroups.reverse()) {
            // eslint-disable-next-line no-await-in-loop
            await removerGrupo(group.token, group.id);
        }
    }
}

await executar();
