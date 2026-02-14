function getSupabaseConfig() {
    return {
        url: process.env.IMAVY_SUPABASE_URL || process.env.SUPABASE_URL || '',
        key:
            process.env.IMAVY_SUPABASE_SERVICE_KEY ||
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.IMAVY_SUPABASE_ANON_KEY ||
            process.env.SUPABASE_ANON_KEY ||
            process.env.IMAVY_SUPABASE_PUBLISHABLE_KEY ||
            process.env.SUPABASE_PUBLISHABLE_KEY ||
            process.env.SUPABASE_KEY ||
            ''
    };
}

function assertSupabaseConfig() {
    const { url, key } = getSupabaseConfig();

    if (!url || !key) {
        throw new Error(
            'Supabase nao configurado. Defina IMAVY_SUPABASE_URL e IMAVY_SUPABASE_ANON_KEY (ou SUPABASE_URL e SUPABASE_KEY).'
        );
    }
}

function buildHeaders(extra = {}) {
    assertSupabaseConfig();
    const { key } = getSupabaseConfig();

    return {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...extra
    };
}

function buildUrl(pathWithQuery) {
    assertSupabaseConfig();
    const { url } = getSupabaseConfig();
    return `${url}/rest/v1/${pathWithQuery}`;
}

function sanitizeText(value, maxLen = 250) {
    return String(value || '').trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLen);
}

function sanitizeEmail(email) {
    return sanitizeText(email, 180).toLowerCase();
}

function parseContentRangeCount(contentRange) {
    if (!contentRange || typeof contentRange !== 'string') {
        return 0;
    }

    const parts = contentRange.split('/');
    if (parts.length !== 2) {
        return 0;
    }

    const count = Number(parts[1]);
    return Number.isFinite(count) ? count : 0;
}

async function requestJson(method, pathWithQuery, body, options = {}) {
    const response = await fetch(buildUrl(pathWithQuery), {
        method,
        headers: buildHeaders(options.headers || {}),
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        const message = errorText || `Supabase HTTP ${response.status}`;
        const error = new Error(message);
        error.statusCode = response.status;
        throw error;
    }

    if (response.status === 204 || options.noBody) {
        return null;
    }

    return response.json();
}

async function requestCount(pathWithQuery) {
    const response = await fetch(buildUrl(pathWithQuery), {
        method: 'GET',
        headers: buildHeaders({
            Prefer: 'count=exact'
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        const message = errorText || `Supabase HTTP ${response.status}`;
        const error = new Error(message);
        error.statusCode = response.status;
        throw error;
    }

    return parseContentRangeCount(response.headers.get('content-range'));
}

module.exports = {
    getSupabaseConfig,
    requestJson,
    requestCount,
    sanitizeText,
    sanitizeEmail
};
