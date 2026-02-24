
const AUTH_STORAGE_KEY = 'imavy_dashboard_token';
const LEGACY_AUTH_STORAGE_KEY = 'imavy_multitenant_token';
const CUSTOM_TOKENS_STORAGE_KEY = 'imavy_admin_custom_tokens';
const DEFAULT_IMAGE_STORAGE_KEY = 'imavy_admin_default_image';

const state = {
    tokenPayload: null,
    activeSection: 'relatorios',
    periodoDias: 30,
    pollingIntervalMs: 10000,
    pollingTimerId: null,
    grupos: [],
    ranking: null,
    groupRankings: {},
    intelEvents: [],
    intelSummary: null,
    opsResumo: null,
    agendamentosStatus: null,
    botStatus: null,
    buyResumo: null,
    customTokens: []
};

let refreshInFlight = false;
let refreshQueued = false;

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

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function getAuthToken() {
    try {
        return localStorage.getItem(AUTH_STORAGE_KEY) || localStorage.getItem(LEGACY_AUTH_STORAGE_KEY) || '';
    } catch (_) {
        return '';
    }
}

function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

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
    if (!payload || typeof payload.exp !== 'number') return false;
    return (payload.exp * 1000) > Date.now();
}

function garantirSessao() {
    const token = getAuthToken();
    if (isTokenAtivo(token)) return decodeJwtPayload(token);

    return {
        plano: 'single',
        clienteId: 'default',
        dashboardRole: 'developer_admin',
        isDashboardAdmin: true,
        singleMode: true
    };
}

function loadCustomTokens() {
    try {
        const raw = localStorage.getItem(CUSTOM_TOKENS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function saveCustomTokens() {
    try {
        localStorage.setItem(CUSTOM_TOKENS_STORAGE_KEY, JSON.stringify(state.customTokens || []));
    } catch (_) {}
}

function getDefaultImageValue() {
    try {
        return localStorage.getItem(DEFAULT_IMAGE_STORAGE_KEY) || 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?auto=format&fit=crop&w=1200&q=80';
    } catch (_) {
        return 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?auto=format&fit=crop&w=1200&q=80';
    }
}

function setDefaultImageValue(value) {
    try {
        localStorage.setItem(DEFAULT_IMAGE_STORAGE_KEY, String(value || ''));
    } catch (_) {}
}

async function fetchComAuth(url, options = {}) {
    const token = getAuthToken();
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { ...options, headers });
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
    if (Number.isNaN(dt.getTime())) return '';
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
    return { dataInicio: toIsoDate(start), dataFim: toIsoDate(end), dias: totalDias };
}

function formatDateTime(value) {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '-';
    return dt.toLocaleString('pt-BR');
}

function formatTime(value) {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '--:--:--';
    return dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatPercent(value) {
    const num = Number(value) || 0;
    return `${num.toFixed(2)}%`;
}

function formatGrowth(growth) {
    const n = Number(growth && growth.percentual || 0);
    return n > 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;
}

function formatUsd(value) {
    const num = Number(value) || 0;
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatAmount(value) {
    const num = Number(value) || 0;
    return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function shortHash(value, left = 8, right = 8) {
    const safe = String(value || '').trim();
    if (!safe) return '-';
    if (safe.length <= left + right + 3) return safe;
    return `${safe.slice(0, left)}...${safe.slice(-right)}`;
}

function getGroupName(grupo) {
    if (!grupo) return '';
    if (typeof grupo === 'string') return grupo;
    return String(grupo.nome || grupo.id || '').trim();
}

function resolveTopGroups() {
    const names = state.grupos.map((item) => getGroupName(item)).filter(Boolean);
    const findByNumber = (num) => names.find((name) => {
        const normalized = normalizeText(name);
        return normalized.includes('vellora') && (normalized.includes(`(${num})`) || normalized.includes(` ${num}`));
    });

    const g1 = findByNumber(1) || names[0] || '';
    const g2 = findByNumber(2) || names[1] || names[0] || '';
    return [g1, g2];
}

function statusChipClass(label) {
    const safe = normalizeText(label);
    if (safe.includes('pendente')) return 'status-chip pending';
    if (safe.includes('enviado') || safe.includes('ativo')) return 'status-chip sent';
    return 'status-chip off';
}
function renderBotBadge() {
    const gruposAtivos = Math.max(1, Number(state.grupos.length || 0));
    byId('botBadge').textContent = `TESTE BOT (${gruposAtivos} ativo${gruposAtivos === 1 ? '' : 's'})`;
}

function renderMetaLine() {
    const buySummary = state.buyResumo && state.buyResumo.summary ? state.buyResumo.summary : {};
    const buyMeta = state.buyResumo && state.buyResumo.meta ? state.buyResumo.meta : {};
    const ops = state.opsResumo || {};
    const telegramStatus = state.botStatus && state.botStatus.ok ? 'ok' : 'off';
    const text = [
        `Atualizado ${formatTime(state.buyResumo && state.buyResumo.updatedAt || Date.now())}`,
        `${Number(buySummary.totalBuys || 0)} compras no periodo`,
        `minUSD ${formatUsd(buyMeta.minUsdAlert || 0)}`,
        `incidentes ${Number(ops.ameacasBloqueadas || 0)}`,
        `telegram ${telegramStatus}`,
        `uptime ${Number(buyMeta.uptimeSec || 0)}s`
    ].join(' | ');
    byId('metaLinha').textContent = text;
}

function renderSummaryCards() {
    const rankingResumo = state.ranking && state.ranking.resumo ? state.ranking.resumo : {};
    const buySummary = state.buyResumo && state.buyResumo.summary ? state.buyResumo.summary : {};

    byId('kpiTotalGrupos').textContent = String(state.grupos.length || 0);
    byId('kpiMembrosAtivos').textContent = String(rankingResumo.totalParticipantes || 0);
    byId('kpiVolumeTotal').textContent = formatUsd(buySummary.totalUsd || 0);
    byId('kpiAlertasEnviados').textContent = String(buySummary.alertasEnviados || 0);
}

function renderGroupTopBody(tbody, rankingPayload) {
    const rows = Array.isArray(rankingPayload && rankingPayload.rankingCompleto)
        ? rankingPayload.rankingCompleto.slice(0, 5)
        : [];

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4">Sem dados no periodo.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item) => `
        <tr>
            <td>${item.posicao}</td>
            <td>${escapeHtml(item.nome)}</td>
            <td>${item.total}</td>
            <td>${formatGrowth(item.crescimento)}</td>
        </tr>
    `).join('');
}

function renderRelatorios() {
    const buySummary = state.buyResumo && state.buyResumo.summary ? state.buyResumo.summary : {};
    const buyMeta = state.buyResumo && state.buyResumo.meta ? state.buyResumo.meta : {};
    const trends = Array.isArray(state.buyResumo && state.buyResumo.tokenTrends) ? state.buyResumo.tokenTrends : [];
    const distribution = Array.isArray(state.buyResumo && state.buyResumo.networkDistribution) ? state.buyResumo.networkDistribution : [];
    const topBuys = Array.isArray(state.buyResumo && state.buyResumo.topBuys) ? state.buyResumo.topBuys : [];
    const ag = state.agendamentosStatus && state.agendamentosStatus.summary ? state.agendamentosStatus.summary : {};

    byId('rpCompras').textContent = String(buySummary.totalBuys || 0);
    byId('rpVolume').textContent = formatUsd(buySummary.totalUsd || 0);
    byId('rpTokensAtivos').textContent = String(buySummary.tokensAtivos || 0);
    byId('rpGruposAtivos').textContent = String(state.grupos.length || 0);
    byId('rpMinUsd').textContent = formatUsd(buyMeta.minUsdAlert || 0);
    byId('rpFilas').textContent = `Fila process: ${Number(ag.totalMensagensAgendadas || 0)} | telegram: ${Number(ag.totalLembretes || 0)}`;

    const tokenTrendList = byId('tokenTrendList');
    const trendRows = trends.slice(0, 8);
    tokenTrendList.innerHTML = trendRows.length
        ? trendRows.map((item) => `<span class="token-chip">${escapeHtml(item.token)} ${Number(item.total || 0)}</span>`).join('')
        : '<p class="helper">Sem dados de tokens no periodo.</p>';

    const redeBars = byId('redeBars');
    const maxRede = distribution.reduce((max, item) => Math.max(max, Number(item.total || 0)), 0) || 1;
    redeBars.innerHTML = distribution
        .map((item) => {
            const total = Number(item.total || 0);
            const pct = Math.max(2, Math.round((total / maxRede) * 100));
            return `
                <div class="bar-row">
                    <span>${escapeHtml(item.network)}</span>
                    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                    <strong>${total}</strong>
                </div>
            `;
        })
        .join('');

    const impactList = byId('impactList');
    impactList.innerHTML = topBuys.length
        ? topBuys.slice(0, 10).map((item) => `
            <article class="impact-item">
                <div class="impact-main">
                    <strong>${escapeHtml(item.token || '-')} - ${formatUsd(item.usd || 0)}</strong>
                    <small>Rede: ${escapeHtml(item.network || 'BSC')} | Buyer: ${escapeHtml(shortHash(item.buyer || '-', 8, 6))} | Amount: ${escapeHtml(formatAmount(item.amount || 0))}</small>
                </div>
                <span class="impact-tx">${escapeHtml(shortHash(item.tx || '-', 12, 10))}</span>
            </article>
        `).join('')
        : '<p class="helper">Sem compras de impacto no periodo.</p>';

    const [group1, group2] = resolveTopGroups();
    byId('topGroup1Title').textContent = `Top 5 ${group1 || 'Grupo 1'}`;
    byId('topGroup2Title').textContent = `Top 5 ${group2 || 'Grupo 2'}`;
    renderGroupTopBody(byId('topGroup1Body'), state.groupRankings[group1]);
    renderGroupTopBody(byId('topGroup2Body'), state.groupRankings[group2]);
}

function renderGrupos() {
    const tbody = byId('gruposBody');
    if (!state.grupos.length) {
        tbody.innerHTML = '<tr><td colspan="2">Nenhum grupo visivel para o usuario.</td></tr>';
        return;
    }

    tbody.innerHTML = state.grupos.map((grupo) => {
        const id = typeof grupo === 'string' ? grupo : (grupo.id || grupo.nome || '-');
        const nome = typeof grupo === 'string' ? grupo : (grupo.nome || grupo.id || '-');
        return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(nome)}</td></tr>`;
    }).join('');
}

function renderMembros() {
    const tbody = byId('membrosBody');
    const rows = Array.isArray(state.ranking && state.ranking.rankingCompleto)
        ? state.ranking.rankingCompleto.slice(0, 40)
        : [];

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5">Sem membros no periodo.</td></tr>';
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
function buildAgendamentoRows() {
    const ag = state.agendamentosStatus || {};
    const rows = [];

    for (const lembrete of Array.isArray(ag.lembretes) ? ag.lembretes : []) {
        const recorrencia = lembrete.type === 'daily' ? 'Diario' : `${Number(lembrete.intervalHours || 0)}h`;
        const dataHora = lembrete.nextTrigger ? formatDateTime(lembrete.nextTrigger) : '-';
        const status = lembrete.nextTrigger && Number(lembrete.nextTrigger) > Date.now() ? 'Pendente' : 'Ativo';
        rows.push({
            message: String(lembrete.command || 'Lembrete automatico').trim(),
            groupId: String(lembrete.groupId || '-').trim(),
            tipo: 'Mensagem',
            dataHora,
            recorrencia,
            status,
            actions: ['Run', 'Editar', 'Desativar', 'Excluir']
        });
    }

    for (const agendado of Array.isArray(ag.agendados) ? ag.agendados : []) {
        const dataHora = agendado.timestamp ? formatDateTime(agendado.timestamp) : (agendado.time || '-');
        const status = agendado.timestamp && Number(agendado.timestamp) <= Date.now() ? 'Enviado' : 'Pendente';
        rows.push({
            message: String(agendado.message || 'Mensagem agendada').trim(),
            groupId: String(agendado.groupId || '-').trim(),
            tipo: 'Mensagem',
            dataHora,
            recorrencia: 'Unico',
            status,
            actions: ['Run', 'Editar', 'Reativar', 'Excluir']
        });
    }

    return rows;
}

function renderAgendamentos() {
    const search = normalizeText(byId('agendamentosSearch').value || '');
    const tbody = byId('agendamentosBody');
    const rows = buildAgendamentoRows().filter((row) => !search || normalizeText(`${row.message} ${row.groupId} ${row.status} ${row.recorrencia}`).includes(search));

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6">Sem agendamentos encontrados.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td><strong>${escapeHtml(row.message)}</strong><br><small>${escapeHtml(row.groupId)}</small></td>
            <td>${escapeHtml(row.tipo)}</td>
            <td>${escapeHtml(row.dataHora)}</td>
            <td>${escapeHtml(row.recorrencia)}</td>
            <td><span class="${statusChipClass(row.status)}">${escapeHtml(row.status)}</span></td>
            <td><div class="action-inline">${row.actions.map((action) => `<button class="btn-soft" type="button">${escapeHtml(action)}</button>`).join('')}</div></td>
        </tr>
    `).join('');
}

function renderAutomacoes() {
    const select = byId('automacaoGrupoSelect');
    const groupNames = state.grupos.map((item) => getGroupName(item)).filter(Boolean);
    select.innerHTML = groupNames.length
        ? groupNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')
        : '<option value="">Sem grupos</option>';

    const runtime = state.botStatus && state.botStatus.runtimeFeatures ? state.botStatus.runtimeFeatures : {};
    const linked = Boolean(state.botStatus && state.botStatus.ok);
    const rows = [
        { title: 'Mensagem de Boas-vindas', subtitle: 'Enviar mensagem quando um novo membro entrar', flag: '', enabled: true },
        { title: 'Resposta Automatica', subtitle: 'Responder automaticamente palavras-chave configuradas', flag: 'commandsEnabled', enabled: runtime.commandsEnabled !== false },
        { title: 'Anti-Spam', subtitle: 'Remover mensagens de spam em tempo real', flag: 'moderationEnabled', enabled: runtime.moderationEnabled !== false },
        { title: 'Inteligencia de Conversa', subtitle: 'Analisar eventos inteligentes em tempo real', flag: 'intelEnabled', enabled: runtime.intelEnabled !== false },
        { title: 'Leads e Engajamento', subtitle: 'Classificar intencao e priorizar respostas', flag: 'leadsEnabled', enabled: runtime.leadsEnabled !== false }
    ];

    byId('automacoesRows').innerHTML = rows.map((row) => `
        <article class="auto-row">
            <div class="auto-main">
                <p><strong>${escapeHtml(row.title)}</strong></p>
                <small>${escapeHtml(row.subtitle)}</small>
            </div>
            <div class="auto-actions">
                <label class="switch">
                    <input class="runtime-flag" type="checkbox" ${row.enabled ? 'checked' : ''} ${row.flag && linked ? '' : 'disabled'} data-flag="${escapeHtml(row.flag)}" />
                    <span class="slider"></span>
                </label>
                <button class="btn-ghost" type="button">Configurar</button>
            </div>
        </article>
    `).join('');
}

function renderModeracao() {
    const ops = state.opsResumo || {};
    const rows = Array.isArray(state.intelEvents) ? state.intelEvents.slice(0, 30) : [];

    byId('modPendentes').textContent = String(rows.length || 0);
    byId('modBanidos').textContent = '0';
    byId('modResolvidos').textContent = '0';
    byId('modStrikes').textContent = String(Number(ops.linksBloqueados || 0));

    const tbody = byId('moderacaoBody');
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5"><strong>Sem denuncias pendentes</strong><br><small>Tudo sob controle no momento.</small></td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item) => {
        const user = item.senderId || item.groupJid || item.group || '-';
        const motivo = item.summary || item.snippet || item.intent || '-';
        return `<tr><td>${formatDateTime(item.timestamp)}</td><td>${escapeHtml(item.type || '-')}</td><td>${escapeHtml(shortHash(user, 10, 6))}</td><td><span class="status-chip pending">Pendente</span></td><td>${escapeHtml(motivo)}</td></tr>`;
    }).join('');
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

function renderBroadcast() {
    const list = byId('broadcastGroupList');
    const groups = state.grupos.map((item) => getGroupName(item)).filter(Boolean);
    list.innerHTML = groups.length
        ? groups.map((group, index) => `<label class="group-option"><input type="checkbox" value="${escapeHtml(group)}" ${index === 0 ? 'checked' : ''} /><span>${escapeHtml(group)}</span></label>`).join('')
        : '<p class="helper">Nenhum grupo disponivel para broadcast.</p>';
}

function getCombinedTokens() {
    const catalog = Array.isArray(state.buyResumo && state.buyResumo.tokenCatalog) ? state.buyResumo.tokenCatalog : [];
    return [...catalog, ...(state.customTokens || [])];
}

function renderTokens() {
    const tbody = byId('tokensBody');
    const rows = getCombinedTokens();

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6">Sem tokens monitorados.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item, index) => {
        const status = String(item.status || 'Ativo');
        const image = item.imagemBuy || '-';
        const isCustom = Boolean(item.__custom === true);
        return `
            <tr>
                <td><strong>${escapeHtml(item.nome || item.simbolo || '-')}</strong><br><small>${escapeHtml(item.tokenAddress || '-')}</small></td>
                <td>${escapeHtml(item.rede || '-')}</td>
                <td><span class="${statusChipClass(status === 'Ativo' ? 'ativo' : 'off')}">${escapeHtml(status)}</span></td>
                <td>${escapeHtml(shortHash(item.pairAddress || '-', 10, 8))}</td>
                <td>${escapeHtml(shortHash(image, 18, 10))}</td>
                <td>
                    <div class="action-inline">
                        <button class="btn-soft" type="button" disabled>Pausar</button>
                        <button class="btn-soft" type="button" disabled>Upload</button>
                        <button class="btn-soft" type="button" disabled>Limpar</button>
                        ${isCustom ? `<button class="btn-danger" type="button" data-remove-custom="${index}">Excluir</button>` : '<button class="btn-danger" type="button" disabled>Excluir</button>'}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function renderAtividade() {
    const tbody = byId('atividadeBody');
    const rows = Array.isArray(state.buyResumo && state.buyResumo.recentBuys) ? state.buyResumo.recentBuys.slice(0, 40) : [];

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7">Sem compras recentes no periodo.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item) => `
        <tr>
            <td>${formatDateTime(item.timestamp)}</td>
            <td>${escapeHtml(item.token || '-')}</td>
            <td>${escapeHtml(item.network || 'BSC')}</td>
            <td>${escapeHtml(shortHash(item.buyer || '-', 8, 6))}</td>
            <td>${escapeHtml(formatAmount(item.amount || 0))}</td>
            <td>${formatUsd(item.usd || 0)}</td>
            <td>${escapeHtml(shortHash(item.tx || '-', 12, 10))}</td>
        </tr>
    `).join('');
}

function renderConfiguracoes() {
    const apiConnected = Boolean(state.botStatus && state.botStatus.ok);
    const networks = Array.isArray(state.buyResumo && state.buyResumo.networkDistribution)
        ? state.buyResumo.networkDistribution.filter((item) => Number(item.total || 0) > 0).map((item) => String(item.network || '').toLowerCase())
        : [];
    const ag = state.agendamentosStatus && state.agendamentosStatus.summary ? state.agendamentosStatus.summary : {};
    const buyMeta = state.buyResumo && state.buyResumo.meta ? state.buyResumo.meta : {};

    const minInput = byId('configMinUsd');
    if (document.activeElement !== minInput) minInput.value = String(Number(buyMeta.minUsdAlert || 0));

    const imgInput = byId('configImagemPadrao');
    if (document.activeElement !== imgInput) imgInput.value = getDefaultImageValue();

    byId('cfgApiStatus').textContent = apiConnected ? `${window.location.origin}` : 'Sem conexao';
    byId('cfgRedesAtivas').textContent = (networks.length ? networks : ['ethereum', 'bsc', 'base', 'polygon', 'solana']).join(', ');
    byId('cfgFilas').textContent = `Process ${Number(ag.totalMensagensAgendadas || 0)} | Telegram ${Number(ag.totalLembretes || 0)}`;
}

function renderAll() {
    renderBotBadge();
    renderMetaLine();
    renderSummaryCards();
    renderRelatorios();
    renderGrupos();
    renderMembros();
    renderComandos();
    renderAgendamentos();
    renderAutomacoes();
    renderModeracao();
    renderIncidentes();
    renderBroadcast();
    renderTokens();
    renderAtividade();
    renderConfiguracoes();
}
function setPageTitle(section) {
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
        tokens: 'Tokens Monitorados',
        atividade: 'Atividade',
        configuracoes: 'Configuracoes'
    };
    byId('pageTitle').textContent = titleMap[section] || 'Painel';
}

function attachMenu() {
    const nav = byId('menuNav');
    nav.addEventListener('click', (event) => {
        const btn = event.target.closest('.menu-item');
        if (!btn) return;

        const section = String(btn.getAttribute('data-section') || '').trim();
        if (!section) return;
        state.activeSection = section;

        for (const node of nav.querySelectorAll('.menu-item')) {
            node.classList.toggle('is-active', node === btn);
        }

        for (const panel of document.querySelectorAll('.section')) {
            panel.classList.remove('is-active');
        }

        const target = byId(`section-${section}`);
        if (target) target.classList.add('is-active');
        setPageTitle(section);
    });
}

async function fetchRankingByGroup(groupName, range) {
    const safe = String(groupName || '').trim();
    if (!safe) return { rankingCompleto: [] };

    const names = state.grupos.map((item) => normalizeText(getGroupName(item)));
    if (!names.includes(normalizeText(safe))) return { rankingCompleto: [] };

    try {
        return await fetchJsonComAuth('/api/ranking-texto', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dataInicio: range.dataInicio,
                dataFim: range.dataFim,
                grupoSelecionado: safe,
                usarSupabase: true
            })
        });
    } catch (_) {
        return { rankingCompleto: [] };
    }
}

async function carregarDados() {
    const range = getPeriodoRange(state.periodoDias);

    const requests = await Promise.allSettled([
        fetchJsonComAuth('/api/grupos-texto', { method: 'GET' }),
        fetchJsonComAuth('/api/ranking-texto', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataInicio: range.dataInicio, dataFim: range.dataFim, usarSupabase: true })
        }),
        fetchJsonComAuth('/api/ops-resumo', { method: 'GET' }),
        fetchJsonComAuth('/api/agendamentos-status', { method: 'GET' }),
        fetchJsonComAuth('/api/dashboard/intel-events?limit=120', { method: 'GET' }),
        fetchJsonComAuth('/api/dashboard/bot-control', { method: 'GET' }),
        fetchJsonComAuth(`/api/buy-alerts-resumo?dias=${range.dias}&limit=80`, { method: 'GET' })
    ]);

    state.grupos = requests[0].status === 'fulfilled' ? (requests[0].value.grupos || []) : [];
    state.ranking = requests[1].status === 'fulfilled'
        ? requests[1].value
        : { resumo: { totalGeral: 0, totalParticipantes: 0, mediaPorParticipante: 0 }, rankingCompleto: [] };
    state.opsResumo = requests[2].status === 'fulfilled' ? requests[2].value : {};
    state.agendamentosStatus = requests[3].status === 'fulfilled' ? requests[3].value : null;

    if (requests[4].status === 'fulfilled') {
        state.intelEvents = requests[4].value.events || [];
        state.intelSummary = requests[4].value.summary || {};
    } else {
        state.intelEvents = [];
        state.intelSummary = {};
    }

    if (requests[5].status === 'fulfilled') {
        const status = requests[5].value.botStatus || {};
        state.botStatus = status && status.body ? { ok: status.ok, ...status.body, statusCode: status.status } : status;
    } else {
        state.botStatus = { ok: false, skipped: true, reason: 'unavailable' };
    }

    if (requests[6].status === 'fulfilled') {
        state.buyResumo = requests[6].value || null;
    } else {
        state.buyResumo = {
            summary: { totalBuys: 0, totalUsd: 0, tokensAtivos: 0, alertasEnviados: 0 },
            tokenTrends: [],
            networkDistribution: [
                { network: 'ETHEREUM', total: 0 },
                { network: 'BSC', total: 0 },
                { network: 'BASE', total: 0 },
                { network: 'POLYGON', total: 0 },
                { network: 'SOLANA', total: 0 }
            ],
            topBuys: [],
            recentBuys: [],
            tokenCatalog: [],
            meta: { minUsdAlert: 0, uptimeSec: 0 }
        };
    }

    const [group1, group2] = resolveTopGroups();
    const uniqueGroups = Array.from(new Set([group1, group2].filter(Boolean)));
    const groupRequests = await Promise.all(uniqueGroups.map(async (name) => ({
        name,
        payload: await fetchRankingByGroup(name, range)
    })));

    const map = {};
    for (const item of groupRequests) {
        map[item.name] = item.payload;
    }
    state.groupRankings = map;
}

async function atualizarPainel(options = {}) {
    const silent = options && options.silent === true;
    if (refreshInFlight) {
        refreshQueued = true;
        return;
    }

    refreshInFlight = true;
    const atualizarBtn = byId('atualizarBtn');
    if (atualizarBtn && !silent) atualizarBtn.disabled = true;

    try {
        await carregarDados();
        renderAll();
    } finally {
        refreshInFlight = false;
        if (atualizarBtn) atualizarBtn.disabled = false;
    }

    if (refreshQueued) {
        refreshQueued = false;
        await atualizarPainel({ silent: true });
    }
}

async function applyRuntimePatch(patch, statusElementId = 'comandosStatus') {
    const statusEl = byId(statusElementId);
    if (statusEl) statusEl.textContent = 'Aplicando patch em tempo real...';

    try {
        const body = await fetchJsonComAuth('/api/dashboard/bot-control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patch })
        });

        const syncOk = body && body.botSync && body.botSync.ok;
        if (statusEl) {
            statusEl.textContent = syncOk
                ? 'Patch aplicado no bot com sucesso.'
                : 'Patch enviado, mas o bot nao confirmou aplicacao.';
        }

        await atualizarPainel({ silent: true });
    } catch (error) {
        if (statusEl) statusEl.textContent = error.message || 'Erro ao aplicar patch.';
    }
}

async function salvarComandosRuntime() {
    const patch = {};
    for (const input of document.querySelectorAll('#comandosToggles [data-flag]')) {
        const key = String(input.getAttribute('data-flag') || '').trim();
        if (!key) continue;
        patch[key] = Boolean(input.checked);
    }
    await applyRuntimePatch(patch, 'comandosStatus');
}

function onAddToken() {
    const nome = String(byId('tokenNome').value || '').trim();
    const simbolo = String(byId('tokenSimbolo').value || '').trim().toUpperCase();
    const rede = String(byId('tokenRede').value || '').trim() || 'BSC';
    const tokenAddress = String(byId('tokenAddress').value || '').trim();
    const pairAddress = String(byId('tokenPair').value || '').trim();
    const decimals = Number(byId('tokenDecimals').value || 18);
    const imagemBuy = String(byId('tokenImagem').value || '').trim();

    if (!simbolo || !tokenAddress || !pairAddress) {
        byId('cfgStatusMsg').textContent = 'Preencha simbolo, token address e pair address para adicionar token.';
        return;
    }

    state.customTokens.push({
        __custom: true,
        nome: nome || simbolo,
        simbolo,
        rede,
        tokenAddress,
        pairAddress,
        decimals,
        imagemBuy,
        status: 'Ativo'
    });
    saveCustomTokens();
    renderTokens();
    byId('cfgStatusMsg').textContent = `Token ${simbolo} adicionado no painel (persistencia local).`;
}

function onSaveConfiguracoes() {
    const defaultImage = String(byId('configImagemPadrao').value || '').trim();
    setDefaultImageValue(defaultImage);
    byId('cfgStatusMsg').textContent = 'Configuracoes salvas no dashboard.';
}

function onSendBroadcast() {
    const titulo = String(byId('broadcastTitulo').value || '').trim();
    const mensagem = String(byId('broadcastMensagem').value || '').trim();
    const gruposSelecionados = Array.from(byId('broadcastGroupList').querySelectorAll('input[type="checkbox"]:checked'))
        .map((input) => String(input.value || '').trim())
        .filter(Boolean);

    const status = byId('broadcastStatus');
    if (!mensagem) {
        status.textContent = 'Digite uma mensagem para enviar broadcast.';
        return;
    }

    if (!gruposSelecionados.length) {
        status.textContent = 'Selecione ao menos um grupo.';
        return;
    }

    status.textContent = `Broadcast preparado (${gruposSelecionados.length} grupo(s)): ${titulo || 'Sem titulo'}.`;
}
function attachActions() {
    byId('periodoSelect').addEventListener('change', async (event) => {
        state.periodoDias = Number(event.target.value) || 30;
        await atualizarPainel({ silent: true });
    });

    byId('atualizarBtn').addEventListener('click', async () => {
        await atualizarPainel();
    });

    byId('acoesBtn').addEventListener('click', () => {
        const targetBtn = document.querySelector('.menu-item[data-section="comandos"]');
        if (targetBtn) targetBtn.click();
    });

    byId('salvarComandosBtn').addEventListener('click', salvarComandosRuntime);
    byId('agendamentosSearch').addEventListener('input', renderAgendamentos);
    byId('adicionarTokenBtn').addEventListener('click', onAddToken);
    byId('salvarConfigBtn').addEventListener('click', onSaveConfiguracoes);
    byId('enviarBroadcastBtn').addEventListener('click', onSendBroadcast);

    byId('automacoesRows').addEventListener('change', async (event) => {
        const input = event.target;
        if (!input || !input.classList || !input.classList.contains('runtime-flag')) return;

        const key = String(input.getAttribute('data-flag') || '').trim();
        if (!key) return;
        await applyRuntimePatch({ [key]: Boolean(input.checked) }, 'comandosStatus');
    });

    byId('tokensBody').addEventListener('click', (event) => {
        const btn = event.target.closest('[data-remove-custom]');
        if (!btn) return;

        const index = Number(btn.getAttribute('data-remove-custom'));
        if (!Number.isFinite(index)) return;

        const rows = getCombinedTokens();
        const row = rows[index];
        if (!row || !row.__custom) return;

        const customIndex = state.customTokens.findIndex((item) => item === row);
        if (customIndex >= 0) {
            state.customTokens.splice(customIndex, 1);
            saveCustomTokens();
            renderTokens();
            byId('cfgStatusMsg').textContent = 'Token custom removido.';
        }
    });

    byId('agendarNovaBtn').addEventListener('click', () => {
        byId('broadcastStatus').textContent = 'Use a aba Broadcast para montar uma nova mensagem.';
    });
}

function stopPolling() {
    if (state.pollingTimerId) {
        clearInterval(state.pollingTimerId);
        state.pollingTimerId = null;
    }
}

function startPolling() {
    stopPolling();
    state.pollingTimerId = setInterval(() => {
        if (document.hidden) return;
        atualizarPainel({ silent: true }).catch(() => {});
    }, Math.max(5000, Number(state.pollingIntervalMs) || 10000));
}

async function boot() {
    const payload = garantirSessao();
    if (!payload) return;

    state.tokenPayload = payload;
    state.customTokens = loadCustomTokens();

    attachMenu();
    attachActions();
    setPageTitle(state.activeSection);
    await atualizarPainel({ silent: true });
    startPolling();
    window.addEventListener('beforeunload', stopPolling);
}

boot().catch((error) => {
    byId('metaLinha').textContent = error.message || 'Falha ao iniciar painel.';
});
