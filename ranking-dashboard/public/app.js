const state = {
    ultimoResultado: null,
    rankingEnriquecido: [],
    insightsPremium: [],
    premiumMeta: null,
    realtimeEnabled: false,
    realtimeClient: null,
    realtimeChannel: null,
    realtimeDebounceTimer: null
};

const realtimeConfig = window.ImavyRealtimeConfig || {};

const SAMPLE_DATA = [
    { nome: 'Joao', data: '2026-02-01', grupo: 'Vendas' },
    { nome: 'Maria', data: '2026-02-01', grupo: 'Vendas' },
    { nome: 'Joao', data: '2026-02-02', grupo: 'Vendas' },
    { nome: 'Ana', data: '2026-02-02', grupo: 'Suporte' },
    { nome: 'Paulo', data: '2026-02-02', grupo: 'Suporte' },
    { nome: 'Joao', data: '2026-02-03', grupo: 'Vendas' },
    { nome: 'Maria', data: '2026-02-03', grupo: 'Vendas' },
    { nome: 'Maria', data: '2026-02-04', grupo: 'Vendas' },
    { nome: 'Ana', data: '2026-02-04', grupo: 'Suporte' },
    { nome: 'Rita', data: '2026-02-04', grupo: 'Suporte' },
    { nome: 'Ana', data: '2026-02-05', grupo: 'Suporte' },
    { nome: 'Rita', data: '2026-02-05', grupo: 'Suporte' },
    { nome: 'Lia', data: '2026-01-30', grupo: 'Marketing' },
    { nome: 'Lia', data: '2026-01-31', grupo: 'Marketing' },
    { nome: 'Paulo', data: '2026-01-31', grupo: 'Suporte' }
];

function byId(id) {
    return document.getElementById(id);
}

function round2(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function setStatus(text, type) {
    const el = byId('status');
    el.textContent = text;
    el.classList.remove('delta-pos', 'delta-neg', 'delta-zero');

    if (type === 'error') {
        el.classList.add('delta-neg');
    } else if (type === 'ok') {
        el.classList.add('delta-pos');
    } else {
        el.classList.add('delta-zero');
    }
}

function setFonteDados(text) {
    const el = byId('fonteDados');
    if (el) {
        el.textContent = text;
    }
}

function setLiveBadge(text, statusType) {
    const el = byId('liveBadge');
    if (!el) {
        return;
    }

    el.textContent = text;
    el.classList.remove('delta-pos', 'delta-neg', 'delta-zero');

    if (statusType === 'ok') {
        el.classList.add('delta-pos');
    } else if (statusType === 'error') {
        el.classList.add('delta-neg');
    } else {
        el.classList.add('delta-zero');
    }
}

function isSupabaseRealtimeReady() {
    return Boolean(
        window.supabase &&
        typeof window.supabase.createClient === 'function' &&
        realtimeConfig.supabaseUrl &&
        realtimeConfig.supabaseAnonKey
    );
}

function createRealtimeClient() {
    if (!isSupabaseRealtimeReady()) {
        throw new Error('Configuracao Supabase Realtime indisponivel no frontend.');
    }

    if (state.realtimeClient) {
        return state.realtimeClient;
    }

    state.realtimeClient = window.supabase.createClient(
        realtimeConfig.supabaseUrl,
        realtimeConfig.supabaseAnonKey
    );

    return state.realtimeClient;
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

function extrairGrupos(interacoes) {
    const grupos = new Set();

    for (const item of interacoes) {
        if (!item || typeof item.grupo !== 'string') {
            continue;
        }

        const nomeGrupo = item.grupo.trim();
        if (nomeGrupo) {
            grupos.add(nomeGrupo);
        }
    }

    return Array.from(grupos).sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
}

function atualizarSeletorGrupos(interacoes) {
    const select = byId('grupoSelecionado');
    const valorAtual = select.value;
    const grupos = extrairGrupos(interacoes);

    select.innerHTML = '';

    const todosOption = document.createElement('option');
    todosOption.value = '';
    todosOption.textContent = 'Todos os grupos';
    select.appendChild(todosOption);

    for (const grupo of grupos) {
        const option = document.createElement('option');
        option.value = grupo;
        option.textContent = grupo;
        select.appendChild(option);
    }

    const existe = Array.from(select.options).some((opt) => opt.value === valorAtual);
    select.value = existe ? valorAtual : '';
}

function formatPercent(value) {
    return `${Number(value || 0).toFixed(2)}%`;
}

function parseDateInput(value) {
    if (!value) {
        return null;
    }

    const parts = String(value).split('-');
    if (parts.length !== 3) {
        return null;
    }

    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    const dt = new Date(Date.UTC(year, month - 1, day));

    if (
        dt.getUTCFullYear() !== year ||
        dt.getUTCMonth() !== month - 1 ||
        dt.getUTCDate() !== day
    ) {
        return null;
    }

    return dt;
}

function formatDateInput(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function addDays(date, delta) {
    return new Date(date.getTime() + (delta * 24 * 60 * 60 * 1000));
}

function diffDaysInclusive(startDate, endDate) {
    return Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

function calcPreviousRange(dataInicio, dataFim) {
    const startDate = parseDateInput(dataInicio);
    const endDate = parseDateInput(dataFim);

    if (!startDate || !endDate) {
        return null;
    }

    const days = diffDaysInclusive(startDate, endDate);
    const prevEnd = addDays(startDate, -1);
    const prevStart = addDays(prevEnd, -(days - 1));

    return {
        dataInicio: formatDateInput(prevStart),
        dataFim: formatDateInput(prevEnd),
        dias: days
    };
}

function calcularRankingPeriodoLocal(interacoes, dataInicio, dataFim, grupoSelecionado) {
    const inicio = parseDateInput(dataInicio);
    const fim = parseDateInput(dataFim);

    if (!inicio || !fim || !Array.isArray(interacoes)) {
        return [];
    }

    const groupFilter = grupoSelecionado && String(grupoSelecionado).trim()
        ? String(grupoSelecionado).trim().toLowerCase()
        : null;

    const mapa = new Map();

    for (const item of interacoes) {
        if (!item || typeof item.nome !== 'string') {
            continue;
        }

        const data = parseDateInput(item.data);
        if (!data || data.getTime() < inicio.getTime() || data.getTime() > fim.getTime()) {
            continue;
        }

        if (groupFilter) {
            const grupo = typeof item.grupo === 'string' ? item.grupo.trim().toLowerCase() : '';
            if (grupo !== groupFilter) {
                continue;
            }
        }

        const nome = item.nome.trim();
        if (!nome) {
            continue;
        }

        mapa.set(nome, (mapa.get(nome) || 0) + 1);
    }

    const total = Array.from(mapa.values()).reduce((sum, value) => sum + value, 0);

    return Array.from(mapa.entries())
        .map(([nome, qtd]) => ({
            nome,
            total: qtd,
            percentual: total === 0 ? 0 : round2((qtd / total) * 100)
        }))
        .sort((a, b) => {
            if (b.total !== a.total) {
                return b.total - a.total;
            }
            return a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' });
        });
}

function setActiveQuickRange(range) {
    const chips = Array.from(document.querySelectorAll('.chip'));
    for (const chip of chips) {
        if (chip.dataset.range === range) {
            chip.classList.add('active');
        } else {
            chip.classList.remove('active');
        }
    }
}

function aplicarFiltroRapido(range) {
    const hoje = new Date();
    const hojeUtc = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));

    let inicio = null;
    let fim = null;

    if (range === '7d') {
        fim = hojeUtc;
        inicio = addDays(hojeUtc, -6);
    }

    if (range === '30d') {
        fim = hojeUtc;
        inicio = addDays(hojeUtc, -29);
    }

    if (range === 'month') {
        fim = hojeUtc;
        inicio = new Date(Date.UTC(hojeUtc.getUTCFullYear(), hojeUtc.getUTCMonth(), 1));
    }

    if (range === 'previous') {
        const atualInicio = byId('dataInicio').value;
        const atualFim = byId('dataFim').value;
        const prev = calcPreviousRange(atualInicio, atualFim);
        if (prev) {
            byId('dataInicio').value = prev.dataInicio;
            byId('dataFim').value = prev.dataFim;
            setActiveQuickRange(range);
            setStatus('Ciclo anterior aplicado.', 'ok');
            return;
        }

        setStatus('Defina um periodo atual antes de aplicar ciclo anterior.', 'error');
        return;
    }

    if (!inicio || !fim) {
        return;
    }

    byId('dataInicio').value = formatDateInput(inicio);
    byId('dataFim').value = formatDateInput(fim);
    setActiveQuickRange(range);
    setStatus('Filtro rapido aplicado.', 'ok');
}

function growthIcon(crescimentoPercentual) {
    const value = Number(crescimentoPercentual || 0);
    if (value > 0) {
        return '\uD83D\uDD3C';
    }

    if (value < 0) {
        return '\uD83D\uDD3D';
    }

    return '\u2796';
}

function growthClass(crescimentoPercentual) {
    const value = Number(crescimentoPercentual || 0);
    if (value > 0) return 'delta-pos';
    if (value < 0) return 'delta-neg';
    return 'delta-zero';
}

function formatGrowth(crescimento) {
    const percentual = Number(crescimento && crescimento.percentual || 0);
    const icon = growthIcon(percentual);
    const sinal = percentual > 0 ? '+' : '';
    return `${icon} ${sinal}${percentual.toFixed(2)}% (abs ${crescimento.absoluto})`;
}

function enrichRanking(resultado) {
    const ranking = (resultado.rankingCompleto || []).map((item) => ({ ...item }));
    const totalParticipantes = Math.max(1, ranking.length);

    for (const row of ranking) {
        row.emRisco = Number(row.crescimento.percentual || 0) <= -50 || Number(row.total || 0) === 1;
        row.scoreEngajamento = window.PremiumAnalytics.calcularScoreEngajamento(row);
        row.nivel = window.PremiumAnalytics.classificarNivel({
            posicao: row.posicao,
            totalParticipantes,
            emRisco: row.emRisco
        });
    }

    return ranking;
}

function renderTable(targetId, rows, maxTotal) {
    const tbody = byId(targetId);
    tbody.innerHTML = '';

    for (const row of rows) {
        const tr = document.createElement('tr');
        if (row.emRisco) {
            tr.classList.add('risk-row');
        }

        const barWidth = maxTotal > 0 ? Math.max(2, (Number(row.total || 0) / maxTotal) * 100) : 0;

        tr.innerHTML = `
            <td>${row.posicao}</td>
            <td>${row.nome}</td>
            <td><span class="level-pill">${row.nivel}</span></td>
            <td>
                <div class="bar-cell">
                    <strong>${row.total}</strong>
                    <div class="bar-track"><div class="bar-fill" style="width:${barWidth}%;"></div></div>
                </div>
            </td>
            <td>${formatPercent(row.percentual)}</td>
            <td><strong>${Number(row.scoreEngajamento || 0).toFixed(2)}</strong></td>
            <td class="growth ${growthClass(row.crescimento.percentual)}">${formatGrowth(row.crescimento)}</td>
        `;

        tbody.appendChild(tr);
    }
}

function renderInsights(targetId, insights) {
    const ul = byId(targetId);
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

function renderPremiumCards(meta) {
    byId('indiceConcentracao').textContent = `${meta.indiceConcentracao.top3Percentual}%`;
    byId('classificacaoConcentracao').textContent = meta.indiceConcentracao.classificacao;
    byId('scoreMedio').textContent = String(meta.scoreMedio);
    byId('participantesRisco').textContent = String(meta.participantesRisco);
}

function renderTop1(meta) {
    const lider = meta.lider;

    if (!lider) {
        byId('top1Nome').textContent = '-';
        byId('top1Resumo').textContent = 'Sem dados no periodo selecionado.';
        byId('top1Total').textContent = '0';
        byId('top1Score').textContent = '0';
        byId('top1Projecao').textContent = 'Sem projecao.';
        return;
    }

    byId('top1Nome').textContent = lider.nome;
    byId('top1Resumo').textContent = `${lider.nivel} com ${formatPercent(lider.percentual)} de participacao.`;
    byId('top1Total').textContent = String(lider.total);
    byId('top1Score').textContent = String(lider.scoreEngajamento.toFixed(2));
    byId('top1Projecao').textContent = `Se o ritmo continuar, ${lider.nome} fechara o mes com ${meta.projecaoLider.totalProjetado} mensagens.`;
}

function calcularMetaPremium(interacoes, resultado, rankingEnriquecido, grupoSelecionado, dataInicio, dataFim) {
    const indiceConcentracao = window.PremiumAnalytics.calcularIndiceConcentracao(rankingEnriquecido);
    const lider = rankingEnriquecido[0] || null;

    const previousRange = calcPreviousRange(dataInicio, dataFim);
    const rankingAnterior = previousRange
        ? calcularRankingPeriodoLocal(interacoes, previousRange.dataInicio, previousRange.dataFim, grupoSelecionado)
        : [];

    const totalAnterior = rankingAnterior.reduce((sum, item) => sum + Number(item.total || 0), 0);
    const diasPeriodo = previousRange ? previousRange.dias : 1;
    const mediaDiariaAtual = Number(resultado.resumo.totalGeral || 0) / Math.max(1, diasPeriodo);
    const mediaDiariaAnterior = Number(totalAnterior || 0) / Math.max(1, diasPeriodo);

    const projecaoLider = lider
        ? window.PremiumAnalytics.calcularProjecao(lider.total, dataInicio, dataFim)
        : { mediaDiaria: 0, totalProjetado: 0, diasRestantesNoMes: 0 };

    const scoreMedio = rankingEnriquecido.length === 0
        ? 0
        : round2(
            rankingEnriquecido.reduce((sum, item) => sum + Number(item.scoreEngajamento || 0), 0) /
            rankingEnriquecido.length
        );

    const participantesRisco = rankingEnriquecido.filter((item) => item.emRisco).length;

    const insightsPremium = window.PremiumAnalytics.gerarInsightsPremium({
        ranking: rankingEnriquecido,
        rankingAnterior,
        resumo: resultado.resumo,
        resumoAnterior: { totalGeral: totalAnterior },
        indiceConcentracao,
        projecaoLider,
        mediaDiariaAtual: round2(mediaDiariaAtual),
        mediaDiariaAnterior: round2(mediaDiariaAnterior)
    });

    return {
        indiceConcentracao,
        projecaoLider,
        lider,
        scoreMedio,
        participantesRisco,
        insightsPremium
    };
}

function renderResultado(resultado, rankingEnriquecido, premiumMeta) {
    state.ultimoResultado = resultado;
    state.rankingEnriquecido = rankingEnriquecido;
    state.premiumMeta = premiumMeta;
    state.insightsPremium = premiumMeta.insightsPremium;

    const top15Enriquecido = rankingEnriquecido.slice(0, 15);
    const maxTotal = rankingEnriquecido.reduce((max, row) => Math.max(max, Number(row.total || 0)), 0);

    renderResumo(resultado.resumo);
    renderPremiumCards(premiumMeta);
    renderTop1(premiumMeta);
    renderInsights('insightsList', resultado.insights || []);
    renderInsights('insightsPremiumList', premiumMeta.insightsPremium || []);
    renderTable('top15Body', top15Enriquecido, maxTotal);
    renderTable('rankingBody', rankingEnriquecido, maxTotal);

    byId('resultados').classList.remove('hidden');
}

function shouldUseSupabaseSource(options) {
    if (options && options.forceSupabase) {
        return true;
    }

    return state.realtimeEnabled;
}

async function carregarGruposDoSupabase() {
    const response = await fetch('/api/grupos-texto', { method: 'GET' });
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error || 'Erro ao listar grupos do Supabase.');
    }

    if (!body || !Array.isArray(body.grupos)) {
        return;
    }

    const select = byId('grupoSelecionado');
    const atual = select.value;
    const existentes = new Set(Array.from(select.options).map((opt) => opt.value));

    for (const grupo of body.grupos) {
        if (!grupo || existentes.has(grupo)) {
            continue;
        }

        const option = document.createElement('option');
        option.value = grupo;
        option.textContent = grupo;
        select.appendChild(option);
        existentes.add(grupo);
    }

    if (atual && existentes.has(atual)) {
        select.value = atual;
    }
}

function agendarAtualizacaoRealtime() {
    if (!state.realtimeEnabled) {
        return;
    }

    if (state.realtimeDebounceTimer) {
        clearTimeout(state.realtimeDebounceTimer);
    }

    state.realtimeDebounceTimer = setTimeout(() => {
        gerarDashboard({ forceSupabase: true, silentStatus: true }).catch(() => {
            // status tratado na pr??pria fun????o.
        });
    }, 700);
}

async function conectarTempoReal() {
    try {
        const client = createRealtimeClient();
        const tableName = realtimeConfig.tableName || 'interacoes_texto';

        if (state.realtimeChannel) {
            try {
                client.removeChannel(state.realtimeChannel);
            } catch (_) {}
            state.realtimeChannel = null;
        }

        state.realtimeEnabled = true;
        setFonteDados('Supabase Realtime');
        setLiveBadge('Conectando...', 'loading');

        state.realtimeChannel = client
            .channel('imavy-ranking-live')
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: tableName },
                () => {
                    agendarAtualizacaoRealtime();
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    setLiveBadge('Online', 'ok');
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    setLiveBadge('Erro', 'error');
                } else {
                    setLiveBadge(status || 'Aguardando', 'loading');
                }
            });

        await carregarGruposDoSupabase();
        await gerarDashboard({ forceSupabase: true });
    } catch (error) {
        state.realtimeEnabled = false;
        setFonteDados('Manual (JSON)');
        setLiveBadge('Offline', 'error');
        setStatus(error.message || 'Falha ao conectar em tempo real.', 'error');
    }
}

function desconectarTempoReal() {
    state.realtimeEnabled = false;

    if (state.realtimeDebounceTimer) {
        clearTimeout(state.realtimeDebounceTimer);
        state.realtimeDebounceTimer = null;
    }

    if (state.realtimeClient && state.realtimeChannel) {
        try {
            state.realtimeClient.removeChannel(state.realtimeChannel);
        } catch (_) {}
    }

    state.realtimeChannel = null;
    setFonteDados('Manual (JSON)');
    setLiveBadge('Offline', 'loading');
    setStatus('Tempo real desconectado. Modo manual ativo.', 'ok');
}

async function carregarInteracoesDoSupabase(dataInicio, dataFim, grupoSelecionado) {
    const query = new URLSearchParams();
    query.set('dataInicio', dataInicio);
    query.set('dataFim', dataFim);

    if (grupoSelecionado) {
        query.set('grupoSelecionado', grupoSelecionado);
    }

    const response = await fetch(`/api/interacoes-texto?${query.toString()}`, { method: 'GET' });
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error || 'Erro ao carregar interacoes do Supabase.');
    }

    return Array.isArray(body.interacoes) ? body.interacoes : [];
}

async function gerarDashboard(options = {}) {
    try {
        if (!options.silentStatus) {
            setStatus('Processando ranking premium...', 'ok');
        }

        const dataInicio = byId('dataInicio').value;
        const dataFim = byId('dataFim').value;
        const grupoSelecionado = byId('grupoSelecionado').value;
        const usarSupabase = shouldUseSupabaseSource(options);

        if (!dataInicio || !dataFim) {
            throw new Error('Informe data inicio e data fim.');
        }

        let interacoes = [];
        if (!usarSupabase) {
            interacoes = parseInputJson();
            atualizarSeletorGrupos(interacoes);
        }

        const response = await fetch('/api/ranking-texto', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                interacoes: usarSupabase ? undefined : interacoes,
                dataInicio,
                dataFim,
                grupoSelecionado,
                usarSupabase
            })
        });

        const body = await response.json();
        if (!response.ok) {
            throw new Error(body.error || 'Erro ao gerar ranking.');
        }

        if (usarSupabase) {
            interacoes = await carregarInteracoesDoSupabase(dataInicio, dataFim, grupoSelecionado);
        }

        const rankingEnriquecido = enrichRanking(body);
        const premiumMeta = calcularMetaPremium(
            interacoes,
            body,
            rankingEnriquecido,
            grupoSelecionado,
            dataInicio,
            dataFim
        );

        renderResultado(body, rankingEnriquecido, premiumMeta);

        if (!options.silentStatus) {
            if (grupoSelecionado) {
                setStatus(`iMavy Analytics 2.5 atualizado para o grupo "${grupoSelecionado}".`, 'ok');
            } else {
                setStatus('iMavy Analytics 2.5 atualizado para todos os grupos.', 'ok');
            }
        }
    } catch (error) {
        setStatus(error.message || 'Erro inesperado.', 'error');
    }
}

function carregarExemplo() {
    byId('interacoesJson').value = JSON.stringify(SAMPLE_DATA, null, 2);
    byId('dataInicio').value = '2026-02-01';
    byId('dataFim').value = '2026-02-05';
    atualizarSeletorGrupos(SAMPLE_DATA);
    setActiveQuickRange('');
    setStatus('Exemplo premium carregado. Clique em "Gerar Dashboard".', 'ok');
}

function onInteracoesChange() {
    if (state.realtimeEnabled) {
        return;
    }

    try {
        const interacoes = parseInputJson();
        atualizarSeletorGrupos(interacoes);
    } catch (_) {
        // Ignora erro durante digitacao parcial.
    }
}

function downloadFile(filename, content, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function escapeCsv(value) {
    const txt = String(value == null ? '' : value);
    if (txt.includes(',') || txt.includes('"') || txt.includes('\n')) {
        return `"${txt.replace(/"/g, '""')}"`;
    }
    return txt;
}

function exportarCsv() {
    if (!state.rankingEnriquecido || state.rankingEnriquecido.length === 0) {
        setStatus('Gere o dashboard antes de exportar CSV.', 'error');
        return;
    }

    const headers = ['posicao', 'nome', 'nivel', 'total', 'percentual', 'scoreEngajamento', 'crescimentoAbsoluto', 'crescimentoPercentual', 'emRisco'];
    const rows = state.rankingEnriquecido.map((row) => [
        row.posicao,
        row.nome,
        row.nivel,
        row.total,
        row.percentual,
        row.scoreEngajamento,
        row.crescimento.absoluto,
        row.crescimento.percentual,
        row.emRisco
    ]);

    const csv = [headers.join(',')]
        .concat(rows.map((r) => r.map(escapeCsv).join(',')))
        .join('\n');

    downloadFile('imavy-analytics-ranking.csv', csv, 'text/csv;charset=utf-8');
    setStatus('CSV exportado com sucesso.', 'ok');
}

function exportarJson() {
    if (!state.ultimoResultado) {
        setStatus('Gere o dashboard antes de exportar JSON.', 'error');
        return;
    }

    const payload = {
        resultadoBase: state.ultimoResultado,
        rankingPremium: state.rankingEnriquecido,
        insightsPremium: state.insightsPremium,
        premiumMeta: state.premiumMeta
    };

    downloadFile('imavy-analytics-ranking.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    setStatus('JSON exportado com sucesso.', 'ok');
}

async function copiarRanking() {
    if (!state.rankingEnriquecido || state.rankingEnriquecido.length === 0) {
        setStatus('Gere o dashboard antes de copiar o ranking.', 'error');
        return;
    }

    const linhas = state.rankingEnriquecido.map((row) => (
        `${row.posicao}. ${row.nome} | ${row.total} msgs | ${formatPercent(row.percentual)} | ${row.nivel} | score ${row.scoreEngajamento.toFixed(2)} | ${formatGrowth(row.crescimento)}`
    ));

    const texto = `iMavy Analytics 2.5 - Ranking\n${linhas.join('\n')}`;

    try {
        await navigator.clipboard.writeText(texto);
        setStatus('Ranking copiado para a area de transferencia.', 'ok');
    } catch (_) {
        setStatus('Falha ao copiar automaticamente. Permita acesso ao clipboard.', 'error');
    }
}

function initQuickFilters() {
    const chips = Array.from(document.querySelectorAll('.chip'));
    for (const chip of chips) {
        chip.addEventListener('click', () => {
            aplicarFiltroRapido(chip.dataset.range);
        });
    }
}

function init() {
    byId('gerarBtn').addEventListener('click', gerarDashboard);
    byId('exemploBtn').addEventListener('click', carregarExemplo);
    byId('exportCsvBtn').addEventListener('click', exportarCsv);
    byId('exportJsonBtn').addEventListener('click', exportarJson);
    byId('copiarBtn').addEventListener('click', copiarRanking);
    byId('conectarTempoRealBtn').addEventListener('click', conectarTempoReal);
    byId('desconectarTempoRealBtn').addEventListener('click', desconectarTempoReal);
    byId('interacoesJson').addEventListener('input', onInteracoesChange);

    initQuickFilters();

    const hoje = new Date();
    const hojeUtc = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
    const isoHoje = formatDateInput(hojeUtc);

    byId('dataInicio').value = isoHoje;
    byId('dataFim').value = isoHoje;
    setFonteDados('Manual (JSON)');
    setLiveBadge('Offline', 'loading');
    setStatus('Pronto. Para dados reais, conecte em tempo real. Para teste, use "Carregar Exemplo".', 'ok');
    carregarGruposDoSupabase().catch(() => {});
}

window.addEventListener('DOMContentLoaded', init);

