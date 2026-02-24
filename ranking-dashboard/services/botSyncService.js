const crypto = require('crypto');

function sanitizeText(value, maxLen = 2000) {
    return String(value || '').trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLen);
}

function toPositiveInt(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBotSyncConfig() {
    const webhookUrl = sanitizeText(
        process.env.BOT_SYNC_WEBHOOK_URL ||
        process.env.DASHBOARD_BOT_SYNC_WEBHOOK_URL ||
        '',
        600
    );
    const secret = sanitizeText(
        process.env.DASHBOARD_SYNC_SECRET ||
        process.env.BOT_SYNC_SECRET ||
        '',
        240
    );
    const timeoutMs = toPositiveInt(process.env.BOT_SYNC_TIMEOUT_MS || '5000', 5000);

    return {
        webhookUrl,
        secret,
        timeoutMs
    };
}

function buildEventPayload(eventPayload) {
    const basePayload = eventPayload && typeof eventPayload === 'object' ? eventPayload : {};
    return {
        ...basePayload,
        eventId: basePayload.eventId || crypto.randomUUID(),
        source: 'ranking-dashboard',
        sentAt: Date.now()
    };
}

function buildSyncHeaders(config) {
    const headers = {
        'Content-Type': 'application/json'
    };

    if (config.secret) {
        headers['X-Dashboard-Sync-Key'] = config.secret;
        headers.Authorization = `Bearer ${config.secret}`;
    }

    return headers;
}

async function notifyBotSync(eventPayload, options = {}) {
    const config = getBotSyncConfig();
    if (!config.webhookUrl) {
        return { ok: false, skipped: true, reason: 'bot_sync_webhook_not_configured' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    if (typeof timeout.unref === 'function') {
        timeout.unref();
    }

    const payload = buildEventPayload(eventPayload);
    const headers = buildSyncHeaders(config);

    try {
        const response = await fetch(config.webhookUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        const rawBody = await response.text();
        let body = null;
        try {
            body = rawBody ? JSON.parse(rawBody) : null;
        } catch (_) {
            body = rawBody || null;
        }

        if (!response.ok) {
            const result = {
                ok: false,
                status: response.status,
                error: typeof body === 'string' ? body : body && body.error,
                body
            };
            if (options.throwOnError) {
                const error = new Error(result.error || `Bot sync falhou com status ${response.status}.`);
                error.statusCode = response.status;
                throw error;
            }
            return result;
        }

        return {
            ok: true,
            status: response.status,
            body
        };
    } catch (error) {
        const aborted = String(error && error.name) === 'AbortError';
        const result = {
            ok: false,
            error: aborted ? `Timeout ao notificar bot (${config.timeoutMs}ms).` : (error && error.message) || 'Falha ao notificar bot.'
        };
        if (options.throwOnError) {
            throw error;
        }
        return result;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchBotSyncStatus(options = {}) {
    const config = getBotSyncConfig();
    if (!config.webhookUrl) {
        return { ok: false, skipped: true, reason: 'bot_sync_webhook_not_configured' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    if (typeof timeout.unref === 'function') {
        timeout.unref();
    }

    try {
        const response = await fetch(config.webhookUrl, {
            method: 'GET',
            headers: buildSyncHeaders(config),
            signal: controller.signal
        });

        const rawBody = await response.text();
        let body = null;
        try {
            body = rawBody ? JSON.parse(rawBody) : null;
        } catch (_) {
            body = rawBody || null;
        }

        if (!response.ok) {
            const result = {
                ok: false,
                status: response.status,
                error: typeof body === 'string' ? body : body && body.error,
                body
            };
            if (options.throwOnError) {
                const error = new Error(result.error || `Bot sync status falhou com status ${response.status}.`);
                error.statusCode = response.status;
                throw error;
            }
            return result;
        }

        return {
            ok: true,
            status: response.status,
            body
        };
    } catch (error) {
        const aborted = String(error && error.name) === 'AbortError';
        const result = {
            ok: false,
            error: aborted ? `Timeout ao consultar status do bot (${config.timeoutMs}ms).` : (error && error.message) || 'Falha ao consultar status do bot.'
        };
        if (options.throwOnError) {
            throw error;
        }
        return result;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    getBotSyncConfig,
    notifyBotSync,
    fetchBotSyncStatus
};
