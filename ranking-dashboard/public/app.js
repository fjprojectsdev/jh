const state = {
    ultimoResultado: null
};

const SAMPLE_DATA = [
    { nome: 'Joao', data: '2026-02-01' },
    { nome: 'Maria', data: '2026-02-01' },
    { nome: 'Joao', data: '2026-02-02' },
    { nome: 'Ana', data: '2026-02-02' },
    { nome: 'Paulo', data: '2026-02-02' },
    { nome: 'Joao', data: '2026-02-03' },
    { nome: 'Maria', data: '2026-02-03' },
    { nome: 'Maria', data: '2026-02-04' },
    { nome: 'Ana', data: '2026-02-04' },
    { nome: 'Rita', data: '2026-02-04' },
    { nome: 'Ana', data: '2026-02-05' },
    { nome: 'Rita', data: '2026-02-05' },
    { nome: 'Lia', data: '2026-01-30' },
    { nome: 'Lia', data: '2026-01-31' },
    { nome: 'Paulo', data: '2026-01-31' }
];

function byId(id) {
    return document.getElementById(id);
}

function setStatus(text, type) {
    const el = byId('status');
    el.textContent = text;
    el.classList.remove('delta-pos', 'delta-neg', 'delta-zero');

    if (type === 'error') {
        el.classList.add('delta-neg');
    } else if (type === 'ok') {
        el.classList.add('delta-pos');
    }
}

function parseInputJson() {
    const raw = byId('interacoesJson').value.trim();
    if (!raw) {
        throw new Error('Preencha o campo de interacoes com um JSON valido.');
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        throw new Error('JSON de interacoes invalido.');
    }

    if (!Array.isArray(parsed)) {
        throw new Error('O JSON deve ser um array de interacoes.');
    }

    return parsed;
}

function formatPercent(value) {
    return `${Number(value).toFixed(2)}%`;
}

function formatGrowth(crescimento) {
    const percentual = Number(crescimento.percentual || 0);
    const sinal = percentual > 0 ? '+' : '';
    return `${sinal}${percentual.toFixed(2)}% (abs ${crescimento.absoluto})`;
}

function growthClass(crescimento) {
    const valor = Number(crescimento.percentual || 0);
    if (valor > 0) return 'delta-pos';
    if (valor < 0) return 'delta-neg';
    return 'delta-zero';
}

function renderTable(targetId, rows) {
    const tbody = byId(targetId);
    tbody.innerHTML = '';

    for (const row of rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${row.posicao}</td>
            <td>${row.nome}</td>
            <td>${row.total}</td>
            <td>${formatPercent(row.percentual)}</td>
            <td class="${growthClass(row.crescimento)}">${formatGrowth(row.crescimento)}</td>
        `;
        tbody.appendChild(tr);
    }
}

function renderInsights(insights) {
    const ul = byId('insightsList');
    ul.innerHTML = '';

    for (const item of insights) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
    }
}

function renderResumo(resumo) {
    byId('totalGeral').textContent = String(resumo.totalGeral);
    byId('totalParticipantes').textContent = String(resumo.totalParticipantes);
    byId('mediaPorParticipante').textContent = String(resumo.mediaPorParticipante);
}

function renderResultado(resultado) {
    state.ultimoResultado = resultado;
    renderResumo(resultado.resumo);
    renderInsights(resultado.insights || []);
    renderTable('top15Body', resultado.top15 || []);
    renderTable('rankingBody', resultado.rankingCompleto || []);
    byId('resultados').classList.remove('hidden');
}

async function gerarDashboard() {
    try {
        setStatus('Processando ranking...', 'ok');
        const interacoes = parseInputJson();
        const dataInicio = byId('dataInicio').value;
        const dataFim = byId('dataFim').value;

        if (!dataInicio || !dataFim) {
            throw new Error('Informe data inicio e data fim.');
        }

        const response = await fetch('/api/ranking-texto', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ interacoes, dataInicio, dataFim })
        });

        const body = await response.json();
        if (!response.ok) {
            throw new Error(body.error || 'Erro ao gerar ranking.');
        }

        renderResultado(body);
        setStatus('Ranking atualizado com sucesso.', 'ok');
    } catch (error) {
        setStatus(error.message || 'Erro inesperado.', 'error');
    }
}

function carregarExemplo() {
    byId('interacoesJson').value = JSON.stringify(SAMPLE_DATA, null, 2);
    byId('dataInicio').value = '2026-02-01';
    byId('dataFim').value = '2026-02-05';
    setStatus('Exemplo carregado. Clique em "Gerar Dashboard".', 'ok');
}

function init() {
    byId('gerarBtn').addEventListener('click', gerarDashboard);
    byId('exemploBtn').addEventListener('click', carregarExemplo);

    const hoje = new Date();
    const y = hoje.getUTCFullYear();
    const m = String(hoje.getUTCMonth() + 1).padStart(2, '0');
    const d = String(hoje.getUTCDate()).padStart(2, '0');
    const isoHoje = `${y}-${m}-${d}`;

    byId('dataInicio').value = isoHoje;
    byId('dataFim').value = isoHoje;
    carregarExemplo();
}

window.addEventListener('DOMContentLoaded', init);
