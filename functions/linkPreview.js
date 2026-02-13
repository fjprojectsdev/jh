import { getLinkPreview } from 'link-preview-js';

const TITLE_TAG_REGEX = /(?:titulo|title)\s*=\s*"([^"]+)"/i;
const URL_REGEX = /https?:\/\/[^\s<>"'`]+/i;

function sanitizeUrlCandidate(url) {
    if (!url) return '';
    return String(url).replace(/[)\],.!?]+$/, '').trim();
}

function isWhatsAppInviteUrl(url) {
    return /^https?:\/\/chat\.whatsapp\.com\//i.test(String(url || ''));
}

function getDefaultTitle(url) {
    return isWhatsAppInviteUrl(url)
        ? 'Convite para grupo do WhatsApp'
        : 'Confira este link';
}

function getCustomTitle(text) {
    const m = String(text || '').match(TITLE_TAG_REGEX);
    return m?.[1]?.trim() || '';
}

function stripTitleTag(text) {
    return String(text || '')
        .replace(TITLE_TAG_REGEX, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

export function extractFirstUrl(text) {
    const m = String(text || '').match(URL_REGEX);
    return m ? sanitizeUrlCandidate(m[0]) : null;
}

export async function buildLinkPreview(url) {
    const normalizedUrl = sanitizeUrlCandidate(url);
    if (!normalizedUrl) return null;

    try {
        const meta = await getLinkPreview(normalizedUrl, { timeout: 5000 });
        const image = Array.isArray(meta?.images) && meta.images.length > 0
            ? meta.images[0]
            : Array.isArray(meta?.favicons) && meta.favicons.length > 0
                ? meta.favicons[0]
                : null;

        return {
            title: meta?.title || null,
            description: meta?.description || null,
            siteName: meta?.siteName || null,
            url: meta?.url || normalizedUrl,
            image,
            jpegThumbnail: null
        };
    } catch (error) {
        return {
            title: null,
            description: null,
            siteName: null,
            url: normalizedUrl,
            image: null,
            jpegThumbnail: null
        };
    }
}

export async function buildReminderPayload(text) {
    const rawText = String(text || '').trim();
    const url = extractFirstUrl(rawText);
    if (!url) return { text: rawText };

    const customTitle = getCustomTitle(rawText);
    const preview = await buildLinkPreview(url);

    const title = customTitle || getDefaultTitle(url);
    const body = preview?.description || (isWhatsAppInviteUrl(url) ? 'Toque para entrar no grupo.' : 'Abra o link para saber mais.');
    const messageText = stripTitleTag(rawText);

    return {
        text: messageText,
        contextInfo: {
            externalAdReply: {
                showAdAttribution: false,
                title,
                body,
                sourceUrl: url,
                thumbnailUrl: preview?.image || undefined,
                mediaType: 1,
                renderLargerThumbnail: false
            }
        }
    };
}
