import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', 'job_channel_cache.json');
const MAX_CACHE_ITEMS = Math.max(200, Number.parseInt(process.env.IMAVY_JOB_CHANNEL_CACHE_LIMIT || '2000', 10) || 2000);

const SOURCE_CHANNEL_IDS = Array.from(new Set(
    String(process.env.IMAVY_JOB_SOURCE_CHANNEL_IDS || process.env.IMAVY_JOB_SOURCE_CHANNEL_ID || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
));

const SOURCE_CHANNEL_NAMES = Array.from(new Set(
    String(process.env.IMAVY_JOB_SOURCE_CHANNEL_NAMES || process.env.IMAVY_JOB_SOURCE_CHANNEL_NAME || 'diario de empregos porto velho regiao')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
));

function normalizeSpace(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeComparable(value) {
    return normalizeSpace(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function stripFormatting(value) {
    return normalizeSpace(String(value || ''))
        .replace(/[*_`~]/g, '')
        .replace(/[ðŸ“ŒðŸ¢ðŸ“ðŸ“âœ…ðŸ’°ðŸ”—]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanLine(value, maxLen = 320) {
    const safe = stripFormatting(value);
    if (!safe) return '';
    return safe.length > maxLen ? `${safe.slice(0, maxLen - 3).trim()}...` : safe;
}

function normalizeUrl(value) {
    const safe = String(value || '').trim();
    if (!safe) return '';
    try {
        const parsed = new URL(safe);
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return safe;
    }
}

function getDefaultCache() {
    return {
        items: []
    };
}

function loadCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return getDefaultCache();
        const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        return {
            items: Array.isArray(parsed?.items) ? parsed.items : []
        };
    } catch (_) {
        return getDefaultCache();
    }
}

function saveCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        items: Array.isArray(cache?.items) ? cache.items.slice(-MAX_CACHE_ITEMS) : []
    }, null, 2), 'utf8');
}

function extractUrls(text) {
    return Array.from(new Set(
        String(text || '').match(/https?:\/\/[^\s]+/gi) || []
    )).map((item) => normalizeUrl(item));
}

function isLikelyJobPost(text) {
    const normalized = normalizeComparable(text);
    if (!normalized) return false;
    return /\b(vaga|vagas|emprego|empregos|oportunidade|contrata-se|contratando|curriculo|currÃ­culo|sele[cÃ§][aÃ£]o)\b/.test(normalized);
}

function extractNamedField(text, patterns) {
    for (const pattern of patterns) {
        const match = String(text || '').match(pattern);
        if (match?.[1]) {
            return cleanLine(match[1], 220);
        }
    }
    return '';
}

function pickTitle(lines) {
    for (const line of lines) {
        const safe = cleanLine(line, 120);
        if (!safe) continue;
        if (/^https?:\/\//i.test(safe)) continue;
        if (/^(empresa|local|cidade|bairro|salario|salÃ¡rio|requisitos|benef[iÃ­]cios|contato|curr[iÃ­]culo|telefone|whatsapp|email|cargo)\s*:/i.test(safe)) continue;
        if (safe.length < 4) continue;
        const match = safe.match(/(?:vaga|oportunidade|cargo|fun[cÃ§][aÃ£]o)\s*[:\-]\s*(.+)$/i);
        if (match?.[1]) return cleanLine(match[1], 120);
        return safe;
    }
    return '';
}

function extractRequirementBullets(lines) {
    const bullets = [];
    let collecting = false;

    for (const rawLine of lines) {
        const line = normalizeSpace(rawLine);
        if (!line) {
            if (collecting && bullets.length > 0) break;
            continue;
        }

        if (/^requisitos?\s*:?\s*$/i.test(line) || /^exig[eÃª]ncias?\s*:?\s*$/i.test(line)) {
            collecting = true;
            continue;
        }

        if (collecting) {
            if (/^(salario|salÃ¡rio|benef[iÃ­]cios|empresa|local|contato|curr[iÃ­]culo|email|telefone|whatsapp)\s*:/i.test(line)) {
                break;
            }
            bullets.push(line.replace(/^[â€¢*\-]\s*/, ''));
            continue;
        }

        if (/^[â€¢*\-]\s+/.test(line)) {
            bullets.push(line.replace(/^[â€¢*\-]\s*/, ''));
        }
    }

    return cleanLine(bullets.join(' | '), 320);
}

function buildSummary(text, title, company, location, salary, requirements) {
    let summary = String(text || '');
    const formattedDescription = summary.match(/(?:ðŸ“\s*)?\*?Descri(?:Ã§|c)[aÃ£]o:?\*?\s*([\s\S]*?)(?=(?:âœ…\s*\*?Requisitos|\u2705\s*\*?Requisitos|ðŸ’°|ðŸ”—|$))/i);
    if (formattedDescription?.[1]) {
        summary = formattedDescription[1];
    }
    for (const chunk of [title, company, location, salary, requirements]) {
        const safe = String(chunk || '').trim();
        if (!safe) continue;
        summary = summary.replace(safe, ' ');
    }

    summary = cleanLine(
        summary
            .replace(/(?:ðŸ“Œ\s*)?\*?VAGA:?\*?/gi, ' ')
            .replace(/(?:ðŸ¢\s*)?Empresa\s*:/gi, ' ')
            .replace(/(?:ðŸ“\s*)?Local\s*:/gi, ' ')
            .replace(/(?:ðŸ“\s*)?\*?Descri(?:Ã§|c)[aÃ£]o:?\*?/gi, ' ')
            .replace(/(?:âœ…\s*)?\*?Requisitos?:?\*?/gi, ' ')
            .replace(/(?:ðŸ’°\s*)?Sal[aÃ¡]rio(?:\s+e\s+benef[iÃ­]cios)?\s*:/gi, ' ')
            .replace(/(?:ðŸ”—\s*)?\*?Candidatura:?\*?/gi, ' ')
            .replace(/https?:\/\/[^\s]+/gi, ' ')
            .replace(/\s+/g, ' '),
        520
    );
    return summary || 'Vaga captada de canal do WhatsApp.';
}

function parseJobFromChannelMessage({ chatId, channelName, text, messageId, receivedAt }) {
    const safeText = normalizeSpace(text);
    if (!isLikelyJobPost(safeText)) return null;

    const lines = String(text || '')
        .split('\n')
        .map((line) => normalizeSpace(line))
        .filter(Boolean);
    const urls = extractUrls(text);
    const title = extractNamedField(text, [
        /(?:📌\s*)?\*?(?:vaga|cargo|fun[cÃ§][aÃ£]o|oportunidade)\*?\s*[:\-]\s*(.+)/i
    ]) || pickTitle(lines);

    if (!title) return null;

    const company = extractNamedField(text, [
        /(?:🏢\s*)?empresa\s*[:\-]\s*(.+)/i,
        /contratante\s*[:\-]\s*(.+)/i,
        /loja\s*[:\-]\s*(.+)/i
    ]) || cleanLine(channelName, 80) || 'Empresa divulgada no canal';

    const location = extractNamedField(text, [
        /(?:📍\s*)?local\s*[:\-]\s*(.+)/i,
        /cidade\s*[:\-]\s*(.+)/i,
        /bairro\s*[:\-]\s*(.+)/i
    ]) || (/porto velho/i.test(text) ? 'Porto Velho/RO' : 'Porto Velho/RO');

    const salaryInfo = extractNamedField(text, [
        /(?:💰\s*)?sal[aÃ¡]rio(?:\s+e\s+benef[iÃ­]cios)?\s*[:\-]\s*(.+)/i,
        /remunera[cÃ§][aÃ£]o\s*[:\-]\s*(.+)/i,
        /benef[iÃ­]cios?\s*[:\-]\s*(.+)/i
    ]);
    const requirements = extractRequirementBullets(lines);
    const applyInfo = extractNamedField(text, [
        /(?:🔗\s*)?\*?candidatura:?\*?\s*(.+)/i,
        /(?:contato|curr[iÃ­]culo|email|whatsapp|telefone)\s*[:\-]\s*(.+)/i
    ]) || (urls[0] ? `Mais detalhes e candidatura: ${urls[0]}` : 'Entre em contato conforme orientacao do post no canal.');
    const url = urls[0] || `https://whatsapp.com/channel-post/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId || Date.now())}`;

    return {
        sourceId: `channel_${chatId}`,
        sourceLabel: cleanLine(channelName || chatId, 80) || chatId,
        title: cleanLine(title, 120),
        company,
        location,
        area: '',
        summary: buildSummary(text, title, company, location, salaryInfo, requirements),
        requirements,
        salaryInfo,
        role: cleanLine(title, 120),
        applyInfo: cleanLine(applyInfo, 220),
        url,
        publishedAt: receivedAt || Date.now(),
        rawText: cleanLine(text, 4000)
    };
}

export function matchesConfiguredJobSourceChannel({ chatId, channelName = '' }) {
    const safeChatId = String(chatId || '').trim();
    const safeName = String(channelName || '').trim();

    if (SOURCE_CHANNEL_IDS.includes(safeChatId)) return true;
    if (!safeName) return false;

    const normalizedName = normalizeComparable(safeName);
    return SOURCE_CHANNEL_NAMES.some((item) => {
        const normalizedTarget = normalizeComparable(item);
        return normalizedTarget && (normalizedName.includes(normalizedTarget) || normalizedTarget.includes(normalizedName));
    });
}

export function registerIncomingJobChannelMessage({ chatId, channelName, text, messageId, receivedAt }) {
    const parsedJob = parseJobFromChannelMessage({ chatId, channelName, text, messageId, receivedAt });
    if (!parsedJob) return null;

    const cache = loadCache();
    const dedupeKey = `${String(chatId || '').trim()}:${String(messageId || '').trim()}`;
    if (cache.items.some((item) => item?.dedupeKey === dedupeKey)) {
        return null;
    }

    cache.items.push({
        dedupeKey,
        chatId: String(chatId || '').trim(),
        channelName: String(channelName || '').trim(),
        messageId: String(messageId || '').trim(),
        receivedAt: receivedAt || Date.now(),
        job: parsedJob
    });
    saveCache(cache);
    return parsedJob;
}

export function collectJobChannelJobs() {
    const cache = loadCache();
    return cache.items
        .map((item) => item?.job)
        .filter(Boolean)
        .slice(-MAX_CACHE_ITEMS);
}

