/**
 * Outgoing guard for Baileys sendMessage.
 * Blocks empty text payloads and logs what is being sent.
 */

function sanitizeText(input) {
    if (input === null || input === undefined) return '';
    let text = String(input);
    text = text.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '');
    text = text.replace(/\r/g, '');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasMediaOrAction(content) {
    return Boolean(
        content
        && typeof content === 'object'
        && (
            hasOwn(content, 'image')
            || hasOwn(content, 'video')
            || hasOwn(content, 'audio')
            || hasOwn(content, 'document')
            || hasOwn(content, 'sticker')
            || hasOwn(content, 'contacts')
            || hasOwn(content, 'location')
            || hasOwn(content, 'delete')
            || hasOwn(content, 'edit')
            || hasOwn(content, 'react')
        )
    );
}

function extractTextCandidate(content) {
    if (!content || typeof content !== 'object') return '';
    if (typeof content.text === 'string') return content.text;
    if (typeof content.caption === 'string') return content.caption;
    if (typeof content.conversation === 'string') return content.conversation;
    return '';
}

function isEmptyBaileysContent(content) {
    if (!content || typeof content !== 'object') return true;

    const textLike =
        hasOwn(content, 'text')
        || hasOwn(content, 'caption')
        || hasOwn(content, 'conversation');
    const mediaOrAction = hasMediaOrAction(content);

    if (textLike) {
        const cleaned = sanitizeText(
            typeof content.text === 'string'
                ? content.text
                : (typeof content.caption === 'string' ? content.caption : content.conversation)
        );
        if (!mediaOrAction && cleaned.length === 0) {
            return true;
        }
        return false;
    }

    return !mediaOrAction;
}

export function attachOutgoingGuard(sock) {
    const original = sock.sendMessage.bind(sock);

    sock.sendMessage = async (jid, content, options) => {
        try {
            let finalContent = content;
            if (typeof finalContent === 'string') {
                finalContent = { text: finalContent };
            }

            if (isEmptyBaileysContent(finalContent)) {
                console.warn(`[OUTGOING BLOCK] Bloqueado envio vazio para ${jid}. Content keys: ${finalContent ? Object.keys(finalContent) : 'null'}`);
                return null;
            }

            if (finalContent && typeof finalContent === 'object') {
                if (hasOwn(finalContent, 'text')) {
                    const cleanText = sanitizeText(typeof finalContent.text === 'string' ? finalContent.text : '');
                    if (!cleanText && !hasMediaOrAction(finalContent)) return null;
                    if (cleanText) {
                        finalContent.text = cleanText;
                    } else {
                        delete finalContent.text;
                    }
                }

                if (hasOwn(finalContent, 'caption')) {
                    const cleanCaption = sanitizeText(typeof finalContent.caption === 'string' ? finalContent.caption : '');
                    if (cleanCaption) {
                        finalContent.caption = cleanCaption;
                    } else {
                        delete finalContent.caption;
                    }
                }

                if (hasOwn(finalContent, 'conversation')) {
                    const cleanConversation = sanitizeText(typeof finalContent.conversation === 'string' ? finalContent.conversation : '');
                    if (cleanConversation) {
                        finalContent.conversation = cleanConversation;
                    } else {
                        delete finalContent.conversation;
                    }
                }
            }

            const debugText = sanitizeText(extractTextCandidate(finalContent));
            if (debugText) {
                console.log('Enviando:', JSON.stringify(debugText));
            } else {
                const keys = finalContent && typeof finalContent === 'object' ? Object.keys(finalContent) : [];
                console.log('[DEBUG] Enviando payload sem texto:', JSON.stringify({ jid, keys }));
            }

            return await original(jid, finalContent, options);
        } catch (error) {
            console.error(`[OUTGOING ERROR] Falha ao enviar para ${jid}: ${error.message}`);
            throw error;
        }
    };

    console.log('[DEBUG] Outgoing Guard ativado: socket protegido contra mensagens vazias.');
    return sock;
}
