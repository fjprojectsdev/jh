const AUTH_STORAGE_KEY = 'imavy_multitenant_token';

const state = {
    tokenPayload: null,
    periodoDias: 30,
    grupos: [],
    ranking: null,
    intelEvents: [],
    intelSummary: null,
    opsResumo: null,
    botStatus: null
};

function byId(id) {
    return document.getElementById(id);
}

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function getAuthToken() {
    try {
        return localStorage.getItem(AUTH_STORAGE_KEY) || '';
    } catch (_) {
        return '';
    }
}

function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') {
        return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        return null;
    }

    try {
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
        return JSON.parse(atob(padded));
    } catch (_) {
        return null;
    }
}

function isTokenAtivo(token) {
    const payload = decodeJwtPayload(token);
    if (!payload || typeof payload.exp !== 'number') {
        return false;
    }
    return (payload.exp * 1000) > Date.now();
}

function garantirSessao() {
    const token = getAuthToken();
    if (!isTokenAtivo(token)) {
        const next = encodeURIComponent(`${window.location.pathname}${window.location.search || ''}`);
        window.location.replace(`./multitenant.html?next=${next}`);
        return null;
    }
    return decodeJwtPayload(token);
}

async function fetchComAuth(url, options = {}) {
    const token = getAuthToken();
    const headers = {
        ...(options.headers || {})
    };

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    return fetch(url, {
        ...options,
        headers
    });
}

async function fetchJsonComAuth(url, options = {}) {
    const response = await fetchComAuth(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (body && body.ok === false)) {
        throw new Error(body.error || `Falha em ${url}`);
    }
    return body;
}

function toIsoDate(value) {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) {
        return '';
    }
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getPeriodoRange(dias) {
    const totalDias = Math.max(1, Number(dias) || 30);
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end.getTime() - (totalDias - 1) * 24 * 60 * 60 * 1000);

    return {
        dataInicio: toIsoDate(start),
        dataFim: toIsoDate(end),
        dias: totalDias
    };
}

function formatDateTime(value) {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '-';
    return dt.toLocaleString('pt-BR');
}

function formatPercent(value) {
    const num = Number(value) || 0;
    return `${num.toFixed(2)}%`;
}

function formatGrowth(growth) {
    const n = Number(growth && growth.percentual || 0);
    if (n > 0) return `+${n.toFixed(2)}%`;
    return `${n.toFixed(2)}%`;
}

function mapTokenStats(events) {
    const stats = new Map();
    for (const item of events || []) {
        const token = String(item.token || item.topToken || '').trim().toUpperCase() || 'SEM_TOKEN';
        stats.set(token, (stats.get(token) || 0) + 1);
    }

    return Array.from(stats.entries())
        .map(([token, total]) => ({ token, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);
}

function renderMetaLine() {
    const range = getPeriodoRange(state.periodoDias);
    const rankingResumo = state.ranking && state.ranking.resumo ? state.ranking.resumo : {};
    const intelSummary = state.intelSummary || {};
    const text = [
        `Atualizado ${formatDateTime(Date.now())}`,
        `${rankingResumo.totalGeral || 0} interacoes no periodo`,
        `${intelSummary.totalIntel24h || 0} eventos intel (24h)`,
        `janela ${range.dataInicio} ate ${range.dataFim}`
    ].join(' | ');
    byId('metaLinha').textContent = text;
}

function renderSummaryCards() {
    const rankingResumo = state.ranking && state.ranking.resumo ? state.ranking.resumo : {};
    const intelSummary = state.intelSummary || {};

    byId('kpiTotalGrupos').textContent = String(state.grupos.length || 0);
    byId('kpiMembrosAtivos').textContent = String(rankingResumo.totalParticipantes || 0);
    byId('kpiInteracoesPeriodo').textContent = String(rankingResumo.totalGeral || 0);
    byId('kpiEventosIntel').textContent = String(intelSummary.totalIntel24h || 0);

    byId('rpGruposAtivos').textContent = String(state.grupos.length || 0);
    byId('rpMediaParticipante').textContent = String(rankingResumo.mediaPorParticipante || 0);
    byId('rpIncidentes').textContent = String((state.opsResumo && state.opsResumo.ameacasBloqueadas) || 0);

    const top = Array.isArray(state.ranking && state.ranking.rankingCompleto)
        ? state.ranking.rankingCompleto[0]
        : null;
    byId('rpTopNome').textContent = top ? top.nome : '-';
}

function renderRelatoriosTabela() {
    const tbody = byId('relatoriosTopBody');
    const rows = Array.isArray(state.ranking && state.ranking.rankingCompleto)
        ? state.ranking.rankingCompleto.slice(0, 12)
        : [];

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5">Sem dados no periodo.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item) => `
        <tr>
            <td>${item.posicao}</td>
            <td>${escapeHtml(item.nome)}</td>
            <td>${item.total}</td>
            <td>${formatPercent(item.percentual)}</td>
            <td>${formatGrowth(item.crescimento)}</td>
        </tr>
    `).join('');
}

function renderGrupos() {
    const tbody = byId('gruposBody');
    if (!state.grupos.length) {
        tbody.innerHTML = '<tr><td colspan="2">Nenhum grupo visivel para o usuario.</td></tr>';
        return;
    }

    tbody.innerHTML = state.grupos.map((grupo) => `
        <tr>
            <td>${escapeHtml(grupo.id)}</td>
            <td>${escapeHtml(grupo.nome || grupo.id)}</td>
        </tr>
    `).join('');
}

function renderMembros() {
    const tbody = byId('membrosBody');
    const rows = Array.isArray(state.ranking && state.ranking.rankingCompleto)
        ? state.ranking.rankingCompleto.slice(0, 40)
        : [];

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4">Sem membros no periodo.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item) => `
        <tr>
            <td>${item.posicao}</td>
            <td>${escapeHtml(item.nome)}</td>
            <td>${item.total}</td>
            <td>${formatPercent(item.percentual)}</td>
        </tr>
    `).join('');
}

function renderComandos() {
    const el = byId('comandosToggles');
    const runtime = state.botStatus && state.botStatus.runtimeFeatures ? state.botStatus.runtimeFeatures : {};
    const isLinked = Boolean(state.botStatus && state.botStatus.ok);

    const entries = [
        { key: 'commandsEnabled', label: 'Comandos gerais' },
        { key: 'moderationEnabled', label: 'Moderacao automatica' },
        { key: 'intelEnabled', label: 'Inteligencia (intel)' },
        { key: 'leadsEnabled', label: 'Leads e engajamento' }
    ];

    el.innerHTML = entries.map((entry) => `
        <div class="toggle-row">
            <span>${entry.label}</span>
            <label>
                <input type="checkbox" data-flag="${entry.key}" ${runtime[entry.key] === false ? '' : 'checked'} ${isLinked ? '' : 'disabled'} />
                <span>${runtime[entry.key] === false ? 'OFF' : 'ON'}</span>
            </label>
        </div>
    `).join('');

    byId('comandosStatus').textContent = isLinked
        ? 'Controle conectado ao bot em tempo real.'
        : 'Webhook bot-sync nao configurado no backend do dashboard.';
}

function renderAgendamentos() {
    const ops = state.opsResumo || {};
    const list = byId('agendamentosList');
    const items = [
        `Lembretes ativos: ${Number(ops.lembretesAtivos || 0)}`,
        `Comandos aceitos (24h): ${Number(ops.comandosAceitos24h || 0)}`,
        `Ultima atualizacao: ${formatDateTime(ops.atualizacao)}`
    ];
    list.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderAutomacoes() {
    const ops = state.opsResumo || {};
    const list = byId('automacoesList');
    const items = Array.isArray(ops.itens) && ops.itens.length
        ? ops.itens.map((item) => `${item.label}: ${item.valor}`)
        : ['Sem automacoes com gatilhos recentes.'];
    list.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderModeracao() {
    const ops = state.opsResumo || {};
    const list = byId('moderacaoList');
    const items = [
        `Links bloqueados: ${Number(ops.linksBloqueados || 0)}`,
        `Ameacas bloqueadas: ${Number(ops.ameacasBloqueadas || 0)}`,
        `Eventos inteligentes (24h): ${Number(ops.totalIntel24h || 0)}`
    ];
    list.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderIncidentes() {
    const tbody = byId('incidentesBody');
    const rows = Array.isArray(state.intelEvents) ? state.intelEvents.slice(0, 60) : [];
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5">Sem incidentes recentes.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item) => `
        <tr>
            <td>${formatDateTime(item.timestamp)}</td>
            <td>${escapeHtml(item.type || '-')}</td>
            <td>${escapeHtml(item.token || item.topToken || '-')}</td>
            <td>${escapeHtml(item.group || item.groupJid || '-')}</td>
            <td>${escapeHtml(item.summary || item.snippet || item.intent || '-')}</td>
        </tr>
    `).join('');
}

function renderTokens() {
    const container = byId('tokensRows');
    const rows = mapTokenStats(state.intelEvents);
    if (!rows.length) {
        container.innerHTML = '<p class="helper">Sem dados de token no periodo.</p>';
        return;
    }

    const max = rows[0].total || 1;
    container.innerHTML = rows.map((row) => {
        const pct = Math.max(2, Math.round((row.total / max) * 100));
        return `
            <div class="bar-row">
                <div class="bar-label">
                    <span>${escapeHtml(row.token)}</span>
                    <strong>${row.total}</strong>
                </div>
                <div class="bar-track">
                    <div class="bar-fill" style="width:${pct}%"></div>
                </div>
            </div>
        `;
    }).join('');
}

function renderAtividade() {
    const list = byId('atividadeList');
    const events = Array.isArray(state.intelEvents) ? state.intelEvents.slice(0, 20) : [];
    if (!events.length) {
        list.innerHTML = '<li>Sem atividade recente.</li>';
        return;
    }

    list.innerHTML = events.map((evt) => {
        const when = formatDateTime(evt.timestamp);
        const token = evt.token || evt.topToken || '-';
        const msg = evt.summary || evt.snippet || evt.intent || 'Evento registrado';
        return `<li><strong>${escapeHtml(evt.type || 'EVENT')}</strong> | ${escapeHtml(token)} | ${escapeHtml(when)}<br>${escapeHtml(msg)}</li>`;
    }).join('');
}

function renderConfiguracoes() {
    const list = byId('configList');
    const status = state.botStatus || {};
    const botSync = status.ok ? 'conectado' : (status.skipped ? 'nao configurado' : 'erro');
    const payload = state.tokenPayload || {};
    const items = [
        `Plano: ${payload.plano || 'desconhecido'}`,
        `Cliente ID: ${payload.clienteId || '-'}`,
        `Bot sync: ${botSync}`,
        `Atualizacao frontend: ${formatDateTime(Date.now())}`
    ];
    list.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderAll() {
    renderMetaLine();
    renderSummaryCards();
    renderRelatoriosTabela();
    renderGrupos();
    renderMembros();
    renderComandos();
    renderAgendamentos();
    renderAutomacoes();
    renderModeracao();
    renderIncidentes();
    renderTokens();
    renderAtividade();
    renderConfiguracoes();
}

function attachMenu() {
    const nav = byId('menuNav');
    nav.addEventListener('click', (event) => {
        const btn = event.target.closest('.menu-item');
        if (!btn) return;

        const section = String(btn.getAttribute('data-section') || '').trim();
        if (!section) return;

        for (const node of nav.querySelectorAll('.menu-item')) {
            node.classList.toggle('is-active', node === btn);
        }

        for (const panel of document.querySelectorAll('.section')) {
            panel.classList.remove('is-active');
        }

        const target = byId(`section-${section}`);
        if (target) {
            target.classList.add('is-active');
        }

        const titleMap = {
            relatorios: 'Relatorios',
            grupos: 'Grupos',
            membros: 'Membros',
            comandos: 'Comandos',
            agendamentos: 'Agendamentos',
            automacoes: 'Automacoes & Moderacao',
            moderacao: 'Moderacao',
            incidentes: 'Incidentes',
            broadcast: 'Broadcast',
            tokens: 'Tokens',
            atividade: 'Atividade',
            configuracoes: 'Configuracoes'
        };
        const title = titleMap[section] || 'Painel';
        document.querySelector('h1').textContent = title;
    });
}

async function carregarDados() {
    const range = getPeriodoRange(state.periodoDias);

    const requests = await Promise.allSettled([
        fetchJsonComAuth('/api/grupos', { method: 'GET' }),
        fetchJsonComAuth(`/api/dashboard/ranking?dataInicio=${encodeURIComponent(range.dataInicio)}&dataFim=${encodeURIComponent(range.dataFim)}`, { method: 'GET' }),
        fetchJsonComAuth('/api/ops-resumo', { method: 'GET' }),
        fetchJsonComAuth('/api/dashboard/intel-events?limit=120', { method: 'GET' }),
        fetchJsonComAuth('/api/dashboard/bot-control', { method: 'GET' })
    ]);

    state.grupos = requests[0].status === 'fulfilled' ? (requests[0].value.grupos || []) : [];
    state.ranking = requests[1].status === 'fulfilled' ? requests[1].value : { resumo: { totalGeral: 0, totalParticipantes: 0, mediaPorParticipante: 0 }, rankingCompleto: [] };
    state.opsResumo = requests[2].status === 'fulfilled' ? requests[2].value : {};

    if (requests[3].status === 'fulfilled') {
        state.intelEvents = requests[3].value.events || [];
        state.intelSummary = requests[3].value.summary || {};
    } else {
        state.intelEvents = [];
        state.intelSummary = {};
    }

    if (requests[4].status === 'fulfilled') {
        const status = requests[4].value.botStatus || {};
        state.botStatus = status && status.body ? { ok: status.ok, ...status.body, statusCode: status.status } : status;
    } else {
        state.botStatus = { ok: false, skipped: true, reason: 'unavailable' };
    }
}

async function salvarComandosRuntime() {
    const patch = {};
    for (const input of document.querySelectorAll('[data-flag]')) {
        const key = String(input.getAttribute('data-flag') || '').trim();
        if (!key) continue;
        patch[key] = Boolean(input.checked);
    }

    const statusEl = byId('comandosStatus');
    statusEl.textContent = 'Aplicando patch em tempo real...';

    try {
        const body = await fetchJsonComAuth('/api/dashboard/bot-control', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ patch })
        });

        const syncOk = body && body.botSync && body.botSync.ok;
        statusEl.textContent = syncOk
            ? 'Patch aplicado no bot com sucesso.'
            : 'Patch enviado, mas o bot nao confirmou aplicacao.';

        await carregarDados();
        renderAll();
    } catch (error) {
        statusEl.textContent = error.message || 'Erro ao aplicar patch.';
    }
}

function attachActions() {
    byId('periodoSelect').addEventListener('change', async (event) => {
        state.periodoDias = Number(event.target.value) || 30;
        await carregarDados();
        renderAll();
    });

    byId('atualizarBtn').addEventListener('click', async () => {
        await carregarDados();
        renderAll();
    });

    byId('acoesBtn').addEventListener('click', () => {
        const targetBtn = document.querySelector('.menu-item[data-section="comandos"]');
        if (targetBtn) {
            targetBtn.click();
        }
    });

    byId('salvarComandosBtn').addEventListener('click', salvarComandosRuntime);
}

async function boot() {
    const payload = garantirSessao();
    if (!payload) return;
    state.tokenPayload = payload;

    attachMenu();
    attachActions();
    await carregarDados();
    renderAll();
}

boot().catch((error) => {
    byId('metaLinha').textContent = error.message || 'Falha ao iniciar painel.';
});
