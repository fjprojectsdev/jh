import { logger } from './logger.js';

/**
 * Remove caracteres invisíveis e espaços extras.
 * @param {string} text 
 * @returns {string} Texto limpo ou string vazia se inválido
 */
export function sanitizeText(text) {
    if (!text) return '';
    if (typeof text !== 'string') return '';

    // Remove caracteres invisíveis comuns:
    // \u200B (Zero width space)
    // \u200C (Zero width non-joiner)
    // \u200D (Zero width joiner)
    // \uFEFF (Zero width no-break space)
    // \u00A0 (Non-breaking space) - opcional, às vezes útil, mas vou normalizar para espaço
    // \r (Carriage return) - manter ou remover? Geralmente \n é suficiente.
    let clean = text
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, '') // Remove invisíveis
        .trim();

    return clean;
}

/**
 * Envia uma mensagem de forma segura, evitando envios vazios.
 * @param {Object} sock Instância do socket do Baileys
 * @param {string} chatId JID do destino
 * @param {string|Object} content Texto ou objeto de mensagem (ex: { text: '...', mentions: [] })
 * @param {Object} options Opções adicionais do Baileys (quoted, etc)
 * @returns {Promise<Object|null>} Retorna a mensagem enviada ou null se bloqueado/erro
 */
export async function sendSafeMessage(sock, chatId, content, options = {}) {
    try {
        if (!sock) {
            logger.error('sendSafeMessage: Socket inválido/nulo', { chatId });
            return null;
        }

        let finalContent = content;
        let textToCheck = '';

        // Normaliza o conteúdo para validação
        if (typeof content === 'string') {
            textToCheck = content;
            finalContent = { text: content }; // Converter para objeto padrão
        } else if (typeof content === 'object' && content !== null) {
            // Se for objeto, tenta extrair o texto/caption para validar
            if (content.text) textToCheck = content.text;
            else if (content.caption) textToCheck = content.caption;
            // Se for imagem/video sem caption, ou delete, ou sticker, textToCheck fica vazio mas pode ser válido.
            // Precisamos distinguir "texto vazio inválido" de "mídia válida sem texto".
            
            const isMedia = content.image || content.video || content.document || content.sticker || content.audio;
            const isAction = content.delete || content.edit;

            if (isMedia || isAction) {
                // Se for mídia ou ação (delete/edit), permitimos passar sem texto
                // Mas se tiver caption, sanitizamos a caption
                if (content.caption) {
                    content.caption = sanitizeText(content.caption);
                }
                // Mídia/Ação é válido por si só
            } else {
                // Se NÃO for mídia/ação, assumimos que é mensagem de texto
                // Se não tem 'text', é inválido (ex: objeto vazio)
                if (!content.text) {
                     // Verifica se tem outras chaves válidas que não conhecemos? 
                     // Por segurança, se não tem text e não é mídia conhecida, bloqueia se for vazio.
                     // Mas o Baileys suporta outros tipos. 
                     // Foco: Bloquear MENSAGENS DE TEXTO vazias.
                     if (!textToCheck) {
                        // Pode ser um botão, template, etc. Vamos logar aviso mas permitir se tiver keys
                        if (Object.keys(content).length > 0) {
                            // ok, deixa passar estruturas complexas se não conseguimos validar texto
                        } else {
                            logger.warn('sendSafeMessage: Bloqueado envio de objeto vazio', { chatId });
                            return null;
                        }
                     }
                }
            }
        } else {
            logger.warn('sendSafeMessage: Tipo de conteúdo inválido', { chatId, type: typeof content });
            return null;
        }

        // Validação de TEXTO (se houver texto para validar)
        if (textToCheck) {
            const cleanText = sanitizeText(textToCheck);
            if (!cleanText) {
                logger.warn('sendSafeMessage: Bloqueado envio de texto vazio/invisível', { chatId, original: textToCheck });
                return null;
            }
            
            // Atualiza o conteúdo sanitizado se for string pura ou objeto text
            if (typeof content === 'string') {
                finalContent = { text: cleanText };
            } else if (content.text) {
                finalContent.text = cleanText;
            }
        } else {
             // Se textToCheck é vazio, mas não era mídia/ação e chegou aqui:
             // Se tiver content.text estritamente igual a "" ou null, bloqueia
             if (content && typeof content === 'object' && 'text' in content && !content.text) {
                 logger.warn('sendSafeMessage: Bloqueado content.text vazio', { chatId });
                 return null;
             }
        }

        // Envio real
        return await sock.sendMessage(chatId, finalContent, options);

    } catch (error) {
        logger.error('sendSafeMessage: Erro ao enviar', { chatId, error: error.message });
        return null;
    }
}
