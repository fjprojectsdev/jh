const { requestJson, sanitizeText } = require('../services/supabaseTenantClient.js');
const fs = require('fs');
const path = require('path');

const TABLE = process.env.IMAVY_ALLOWED_GROUPS_TABLE || 'allowed_groups';

function mapAllowedGroupRow(row) {
    if (!row) {
        return null;
    }

    return {
        nome: sanitizeText(row.name || row.nome, 180)
    };
}

function getAllowedGroupsJsonPath() {
    return path.resolve(__dirname, '..', '..', 'allowed_groups.json');
}

function readAllowedGroupsFromJsonFile() {
    try {
        const filePath = getAllowedGroupsJsonPath();
        if (!fs.existsSync(filePath)) {
            return [];
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .map((item) => ({ nome: sanitizeText(item, 180) }))
            .filter((item) => Boolean(item.nome));
    } catch (_) {
        return [];
    }
}

async function listAllowedGroupsFromBot(limit = 10000) {
    const uniques = new Set();
    const result = [];
    const limitNumber = Number(limit) || 10000;

    const appendUnique = (items) => {
        for (const row of items || []) {
            const mapped = mapAllowedGroupRow(row);
            if (!mapped || !mapped.nome || uniques.has(mapped.nome)) {
                continue;
            }

            uniques.add(mapped.nome);
            result.push(mapped);
        }
    };

    try {
        const query = `${TABLE}?select=name&order=name.asc&limit=${limitNumber}`;
        const rows = await requestJson('GET', query);
        appendUnique(rows);
    } catch (_) {
        // Fallback em arquivo local para manter compatibilidade com o bot legado.
    }

    if (result.length === 0) {
        appendUnique(readAllowedGroupsFromJsonFile());
    }

    return result.slice(0, limitNumber);
}

module.exports = {
    listAllowedGroupsFromBot
};
