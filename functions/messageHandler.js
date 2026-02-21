import { logger } from './logger.js';

const INVISIBLE_CHAR_REGEX = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

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

export function sanitizeText(text) {
    if (typeof text !== 'string') return '';
    return text
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
