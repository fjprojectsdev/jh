const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const STRIKES_FILE = path.join(ROOT_DIR, 'strikes.json');
const LEMBRETES_FILE = path.join(ROOT_DIR, 'lembretes.json');

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

function getOpsResumo() {
    const strikesData = readJsonFile(STRIKES_FILE, {});
    const lembretesData = readJsonFile(LEMBRETES_FILE, {});

    const linksBloqueados = countLinksBloqueados(strikesData);
    const lembretesAtivos = countLembretesAtivos(lembretesData);
    const ameacasBloqueadas = linksBloqueados > 0 ? linksBloqueados : 0;

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

    return {
        atualizacao: new Date().toISOString(),
        linksBloqueados,
        ameacasBloqueadas,
        lembretesAtivos,
        itens
    };
}

module.exports = {
    getOpsResumo
};
