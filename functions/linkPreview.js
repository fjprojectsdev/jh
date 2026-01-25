
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extrai a primeira URL encontrada no texto.
 * @param {string} text 
 * @returns {string|null} URL ou null
 */
export function extractFirstUrl(text) {
    if (!text) return null;
    const regex = /(https?:\/\/[^\s]+)/i;
    const match = text.match(regex);
    return match ? match[0] : null;
}

/**
 * Constrói o payload da mensagem de lembrete.
 * Se houver URL, força o uso de contextInfo.externalAdReply para garantir o card.
 * @param {string} text Texto da mensagem
 * @returns {Promise<Object>} Payload para sendMessage ({ text, contextInfo? })
 */
export async function buildReminderPayload(text) {
    const url = extractFirstUrl(text);
    if (!url) {
        return { text };
    }

    // Carregar thumbnail padrão
    const thumbPath = path.join(__dirname, '..', 'assets', 'whatsapp-invite-thumb.jpg');
    let thumbnailBuffer = null;
    try {
        if (fs.existsSync(thumbPath)) {
            thumbnailBuffer = fs.readFileSync(thumbPath);
        } else {
            console.warn('[LinkPreview] Asset whatsapp-invite-thumb.jpg não encontrado.');
        }
    } catch (e) {
        console.error('[LinkPreview] Erro lendo asset:', e);
    }

    // 1. Extrair título personalizado do texto: titulo="Meu Titulo"
    let customTitle = null;
    const titleMatch = text.match(/(?:titulo|title)=["']([^"']+)["']/i);
    if (titleMatch) {
        customTitle = titleMatch[1];
    }

    // 2. Definir conteúdo do card
    const isWhatsAppGroup = url.includes('chat.whatsapp.com');
    let title = 'Confira este link';
    let body = 'Toque para acessar';

    if (isWhatsAppGroup) {
        title = 'Convite para grupo do WhatsApp';
        body = 'Toque para entrar no grupo';
    }

    // Override se houver custom title
    if (customTitle) {
        title = customTitle;
    }

    // Log de observabilidade
    console.log(`[LinkPreview] Gerando ExternalAdReply para ${url} (Title: "${title}")`);

    return {
        text: text,
        contextInfo: {
            externalAdReply: {
                title: title,
                body: body,
                thumbnail: thumbnailBuffer, // Buffer direto
                sourceUrl: url,
                mediaType: 1, // 1 = THUMBNAIL_IMAGE_TYPE 
                renderLargerThumbnail: true,
                showAdAttribution: false
            }
        }
    };
}
