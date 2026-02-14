const { URL } = require('url');

function buildResponse(statusCode, body, methods) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': methods || 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        },
        body: JSON.stringify(body)
    };
}

function normalizeSuffix(rawPath, functionName, apiBase) {
    const candidates = [
        `/.netlify/functions/${functionName}`,
        `/${functionName}`,
        apiBase
    ];

    for (const candidate of candidates) {
        if (rawPath.startsWith(candidate)) {
            const suffix = rawPath.slice(candidate.length);
            return suffix || '/';
        }
    }

    return '/';
}

function createRouteContext(event, config) {
    const rawPath = String(event.path || '/');
    const originalUrl = new URL(event.rawUrl || `https://netlify.local${rawPath}`);
    const suffix = normalizeSuffix(rawPath, config.functionName, config.apiBase);
    const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
    const mappedPath = `${config.apiBase}${normalizedSuffix === '/' ? '' : normalizedSuffix}`;

    const parsedUrl = new URL(originalUrl.toString());
    parsedUrl.pathname = mappedPath;

    let captured = null;
    const req = {
        method: event.httpMethod,
        headers: event.headers || {}
    };
    const res = {};

    const helpers = {
        sendJson(_res, statusCode, payload) {
            captured = buildResponse(statusCode, payload, config.allowedMethods);
        },
        async readJsonBody() {
            if (!event.body) {
                return {};
            }

            const raw = event.isBase64Encoded
                ? Buffer.from(event.body, 'base64').toString('utf8')
                : event.body;

            return raw ? JSON.parse(raw) : {};
        }
    };

    return {
        req,
        res,
        parsedUrl,
        helpers,
        getResponse() {
            return captured;
        }
    };
}

module.exports = {
    buildResponse,
    createRouteContext
};

