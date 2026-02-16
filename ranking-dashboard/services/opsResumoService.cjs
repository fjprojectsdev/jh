const fs = require('fs');
const path = require('path');
const { getIntelOpsSummary } = require('./intelEventsService.js');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const STRIKES_FILE = path.join(ROOT_DIR, 'strikes.json');
const LEMBRETES_FILE = path.join(ROOT_DIR, 'lembretes.json');
const COMANDOS_ACEITOS_FILE = path.join(ROOT_DIR, 'comandos_aceitos.json');

function readJsonFile(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) {
            return fallbackValue;
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        return raw ? JSON.parse(raw) : fallbackValue;
    } catch (_) {
        return fallbackValue;
    }
}

function countLinksBloqueados(strikesData) {
    if (!strikesData || typeof strikesData !== 'object') {
        return 0;
    }

    let total = 0;

    for (const item of Object.values(strikesData)) {
        if (!item || !Array.isArray(item.violations)) {
            continue;
        }

        for (const violation of item.violations) {
            const rule = String(violation && violation.rule || '').toUpperCase();
            if (rule.includes('LINK')) {
                total += 1;
            }
        }
    }

    return total;
}

function countLembretesAtivos(lembretesData) {
    if (!lembretesData || typeof lembretesData !== 'object') {
        return 0;
    }

    const hasBuckets = Object.prototype.hasOwnProperty.call(lembretesData, 'interval')
        || Object.prototype.hasOwnProperty.call(lembretesData, 'daily');

    if (!hasBuckets) {
        return Object.keys(lembretesData).length;
    }

    const interval = lembretesData.interval && typeof lembretesData.interval === 'object'
        ? Object.keys(lembretesData.interval).length
        : 0;

    const daily = lembretesData.daily && typeof lembretesData.daily === 'object'
        ? Object.keys(lembretesData.daily).length
        : 0;

    return interval + daily;
}

function countComandosAceitos24h(comandosData) {
    if (!comandosData || typeof comandosData !== 'object' || !Array.isArray(comandosData.eventos)) {
        return 0;
    }

    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    let total = 0;

    for (const evento of comandosData.eventos) {
        const ts = Number(evento && evento.timestamp || 0);
        if (Number.isFinite(ts) && ts >= cutoff) {
            total += 1;
        }
    }

    return total;
}

function getOpsResumo() {
    const strikesData = readJsonFile(STRIKES_FILE, {});
    const lembretesData = readJsonFile(LEMBRETES_FILE, {});
    const comandosData = readJsonFile(COMANDOS_ACEITOS_FILE, { eventos: [] });

    const linksBloqueados = countLinksBloqueados(strikesData);
    const lembretesAtivos = countLembretesAtivos(lembretesData);
    const comandosAceitos24h = countComandosAceitos24h(comandosData);
    const ameacasBloqueadas = linksBloqueados > 0 ? linksBloqueados : 0;
    const intelSummary = getIntelOpsSummary();
    const socialSpike24h = Number(intelSummary.socialSpike24h || 0);
    const tokenDominance24h = Number(intelSummary.tokenDominance24h || 0);
    const socialOnchainConfirm24h = Number(intelSummary.socialOnchainConfirm24h || 0);
    const totalIntel24h = Number(intelSummary.totalIntel24h || 0);

    const itens = [];

    // Regra: mostrar links apenas quando > 0.
    if (linksBloqueados > 0) {
        itens.push({
            id: 'links_bloqueados',
            label: 'Links bloqueados',
            valor: linksBloqueados
        });
    }

    // Regra: mostrar ameacas apenas quando houver link bloqueado.
    if (ameacasBloqueadas > 0) {
        itens.push({
            id: 'ameacas_bloqueadas',
            label: 'Ameacas bloqueadas',
            valor: ameacasBloqueadas
        });
    }

    // Regra: mostrar lembretes ativos apenas quando > 0.
    if (lembretesAtivos > 0) {
        itens.push({
            id: 'lembretes_ativos',
            label: 'Lembretes ativos',
            valor: lembretesAtivos
        });
    }

    if (totalIntel24h > 0) {
        itens.push({
            id: 'intel_eventos_24h',
            label: 'Eventos inteligentes (24h)',
            valor: totalIntel24h
        });
    }

    if (socialOnchainConfirm24h > 0) {
        itens.push({
            id: 'social_onchain_confirm_24h',
            label: 'Confirmacoes social/onchain (24h)',
            valor: socialOnchainConfirm24h
        });
    }

    return {
        atualizacao: new Date().toISOString(),
        linksBloqueados,
        ameacasBloqueadas,
        lembretesAtivos,
        comandosAceitos24h,
        socialSpike24h,
        tokenDominance24h,
        socialOnchainConfirm24h,
        totalIntel24h,
        itens
    };
}

module.exports = {
    getOpsResumo
};
