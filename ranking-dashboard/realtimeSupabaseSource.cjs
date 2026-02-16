const DEFAULT_TABLE = 'interacoes_texto';

function getSupabaseConfig() {
    const url = process.env.IMAVY_SUPABASE_URL || process.env.SUPABASE_URL || '';
    const key =
        process.env.IMAVY_SUPABASE_SERVICE_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.IMAVY_SUPABASE_ANON_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        process.env.IMAVY_SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_KEY ||
        '';
    const tableName = process.env.IMAVY_REALTIME_TABLE || DEFAULT_TABLE;

    return { url, key, tableName };
}

function assertSupabaseConfig({ url, key }) {
    if (!url || !key) {
        throw new Error(
            'Supabase nao configurado. Defina IMAVY_SUPABASE_URL e IMAVY_SUPABASE_ANON_KEY (ou SUPABASE_URL e SUPABASE_KEY).'
        );
    }
}

function buildHeaders(key) {
    return {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
    };
}

function normalizeGroupFilter(grupoSelecionado) {
    if (grupoSelecionado === undefined || grupoSelecionado === null) {
        return '';
    }

    return String(grupoSelecionado).trim();
}

function normalizeGroupsFilter(grupos) {
    const out = [];
    const seen = new Set();

    for (const groupName of Array.isArray(grupos) ? grupos : []) {
        const safeName = String(groupName || '').trim();
        if (!safeName || seen.has(safeName)) {
            continue;
        }
        seen.add(safeName);
        out.push(safeName);
    }

    return out;
}

function buildInFilterFromGroups(grupos) {
    const names = normalizeGroupsFilter(grupos);
    if (names.length === 0) {
        return null;
    }

    const encodedValues = names.map((name) => `"${name.replace(/"/g, '\\"')}"`);
    return `(${encodedValues.join(',')})`;
}

async function fetchInteractionsFromSupabase(params) {
    const { dataInicio, dataFim } = params || {};
    const grupoSelecionado = normalizeGroupFilter(params && params.grupoSelecionado);
    const gruposPermitidos = normalizeGroupsFilter(params && params.gruposPermitidos);
    const limit = Number((params && params.limit) || 50000);

    if (!dataInicio || !dataFim) {
        throw new Error('dataInicio e dataFim sao obrigatorios para carregar do Supabase.');
    }

    const { url, key, tableName } = getSupabaseConfig();
    assertSupabaseConfig({ url, key });
    const endpoint = new URL(`${url}/rest/v1/${tableName}`);

    endpoint.searchParams.set('select', 'nome,data,grupo');
    endpoint.searchParams.append('data', `gte.${dataInicio}`);
    endpoint.searchParams.append('data', `lte.${dataFim}`);
    endpoint.searchParams.set('order', 'data.asc,created_at.asc');
    endpoint.searchParams.set('limit', String(limit));

    if (grupoSelecionado) {
        endpoint.searchParams.set('grupo', `eq.${grupoSelecionado}`);
    } else {
        const inFilter = buildInFilterFromGroups(gruposPermitidos);
        if (inFilter) {
            endpoint.searchParams.set('grupo', `in.${inFilter}`);
        }
    }

    const response = await fetch(endpoint.toString(), {
        method: 'GET',
        headers: buildHeaders(key)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Falha ao carregar interacoes do Supabase (${response.status}): ${text}`);
    }

    const rows = await response.json();

    return rows.map((row) => ({
        nome: row.nome,
        data: row.data,
        grupo: row.grupo || ''
    }));
}

async function fetchGroupsFromSupabase(limit = 5000) {
    const { url, key, tableName } = getSupabaseConfig();
    assertSupabaseConfig({ url, key });
    const endpoint = new URL(`${url}/rest/v1/${tableName}`);

    endpoint.searchParams.set('select', 'grupo');
    endpoint.searchParams.set('grupo', 'not.is.null');
    endpoint.searchParams.set('order', 'grupo.asc');
    endpoint.searchParams.set('limit', String(Number(limit) || 5000));

    const response = await fetch(endpoint.toString(), {
        method: 'GET',
        headers: buildHeaders(key)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Falha ao carregar grupos do Supabase (${response.status}): ${text}`);
    }

    const rows = await response.json();
    const groups = new Set();

    for (const row of rows) {
        if (typeof row.grupo !== 'string') {
            continue;
        }

        const nome = row.grupo.trim();
        if (nome) {
            groups.add(nome);
        }
    }

    return Array.from(groups).sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
}

module.exports = {
    fetchInteractionsFromSupabase,
    fetchGroupsFromSupabase,
    getSupabaseConfig
};
