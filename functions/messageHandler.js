import { logger } from './logger.js';

const INVISIBLE_CHAR_REGEX = /[\u200B\u200C\u200D\u2060\uFEFF]/g;
const MOJIBAKE_HINT_REGEX = /(?:\u00C3.|\u00C2.|\u00E2.|\u00F0\u0178|\uFFFD)/;
const C1_CONTROL_REGEX = /[\u0080-\u009F]/;
const CP1252_FORWARD_MAP = new Map([
    [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85],
    [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A],
    [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92],
    [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
    [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C],
    [0x017E, 0x9E], [0x0178, 0x9F]
]);

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function isMediaOrActionPayload(content) {
    return Boolean(
        content
        && typeof content === 'object'
        && (
            'image' in content
            || 'video' in content
            || 'document' in content
            || 'sticker' in content
            || 'audio' in content
            || 'delete' in content
            || 'edit' in content
            || 'react' in content
        )
    );
}

function mojibakeScore(text) {
    if (typeof text !== 'string' || !text) return 0;
    const matches = text.match(/(?:\u00C3.|\u00C2.|\u00E2.|\u00F0\u0178|\uFFFD)/g);
    const controlChars = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g);
    return (matches ? matches.length * 3 : 0) + (controlChars ? controlChars.length * 5 : 0);
}

function decodeUtf8FromCp1252(text) {
    const bytes = [];
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code <= 0xFF) {
            bytes.push(code);
            continue;
        }
        const mapped = CP1252_FORWARD_MAP.get(code);
        if (typeof mapped !== 'number') {
            return null;
        }
        bytes.push(mapped);
    }
    return Buffer.from(bytes).toString('utf8');
}

function tryRepairMojibake(text) {
    if (typeof text !== 'string' || !text) return text;
    if (!MOJIBAKE_HINT_REGEX.test(text) && !C1_CONTROL_REGEX.test(text)) return text;

    let best = text;
    let bestScore = mojibakeScore(text);
    let current = text;

    for (let i = 0; i < 3; i += 1) {
        const candidates = [
            Buffer.from(current, 'latin1').toString('utf8'),
            decodeUtf8FromCp1252(current)
        ].filter((v) => typeof v === 'string' && v.length > 0);

        let improved = false;
        for (const repaired of candidates) {
            const repairedScore = mojibakeScore(repaired);
            if (repairedScore < bestScore) {
                best = repaired;
                bestScore = repairedScore;
                current = repaired;
                improved = true;
            }
        }
        if (!improved) break;
    }

    return best;
}

export function sanitizeText(text) {
    if (typeof text !== 'string') return '';
    return tryRepairMojibake(text)
        .replace(INVISIBLE_CHAR_REGEX, '')
        .replace(/\r/g, '')
        .trim();
}

export async function sendSafeMessage(sock, chatId, content, options = {}) {
    try {
        if (!sock || typeof sock.sendMessage !== 'function') {
            logger.error('sendSafeMessage: Socket invalido/nulo', { chatId });
            return null;
        }

        if (!chatId || String(chatId).trim().length === 0) {
            logger.warn('sendSafeMessage: chatId invalido', { chatId });
            return null;
        }

        if (typeof content === 'string') {
            if (!content || !content.trim()) return null;
            const cleanText = sanitizeText(content);
            if (!cleanText) return null;
            return await sock.sendMessage(chatId, { text: cleanText }, options);
        }

        if (!content || typeof content !== 'object') {
            logger.warn('sendSafeMessage: Tipo de conteudo invalido', { chatId, type: typeof content });
            return null;
        }

        const finalContent = { ...content };
        const hasMediaOrAction = isMediaOrActionPayload(finalContent);

        if (hasOwn(finalContent, 'text')) {
            const rawText = typeof finalContent.text === 'string' ? finalContent.text : '';
            if (!rawText || !rawText.trim()) {
                if (!hasMediaOrAction) return null;
                delete finalContent.text;
            } else {
                const cleanText = sanitizeText(rawText);
                if (!cleanText) {
                    if (!hasMediaOrAction) return null;
                    delete finalContent.text;
                } else {
                    finalContent.text = cleanText;
                }
            }
        }

        if (hasOwn(finalContent, 'conversation')) {
            const cleanConversation = sanitizeText(
                typeof finalContent.conversation === 'string' ? finalContent.conversation : ''
            );
            if (!cleanConversation) {
                if (!hasMediaOrAction) return null;
                delete finalContent.conversation;
            } else {
                finalContent.conversation = cleanConversation;
            }
        }

        if (hasOwn(finalContent, 'caption')) {
            const cleanCaption = sanitizeText(
                typeof finalContent.caption === 'string' ? finalContent.caption : ''
            );
            if (cleanCaption) {
                finalContent.caption = cleanCaption;
            } else {
                delete finalContent.caption;
                if (!hasMediaOrAction && !hasOwn(finalContent, 'text') && !hasOwn(finalContent, 'conversation')) {
                    return null;
                }
            }
        }

        const textToValidate = sanitizeText(
            typeof finalContent.text === 'string'
                ? finalContent.text
                : (typeof finalContent.conversation === 'string'
                    ? finalContent.conversation
                    : '')
        );

        if (!hasMediaOrAction && !textToValidate) {
            return null;
        }

        if (!hasMediaOrAction && Object.keys(finalContent).length === 0) {
            return null;
        }

        return await sock.sendMessage(chatId, finalContent, options);
    } catch (error) {
        logger.error('sendSafeMessage: Erro ao enviar', { chatId, error: error.message });
        return null;
    }
}

export async function sendPlainText(sock, chatId, text) {
    return sendSafeMessage(sock, chatId, { text });
}

