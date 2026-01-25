import { getLinkPreview } from 'link-preview-js';
import axios from 'axios';
import { Jimp } from 'jimp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache em memória (URL -> {previewData, timestamp})
const previewCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 horas

// Configuração
const TIMEOUT_MS = 5000;
const THUMBNAIL_WIDTH = 100;
const THUMBNAIL_QUALITY = 60;

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
                mediaType: 1, // 1 = THUMBNAIL_IMAGE_TYPE (geralmente funciona melhor pra link)
                renderLargerThumbnail: true,
                showAdAttribution: false
            }
        }
    };
}

/**
 * Gera o preview do link (título, descrição, thumbnail).
 * @deprecated Use buildReminderPayload para cards garantidos via externalAdReply.
 * @param {string} url 
 * @returns {Promise<Object|null>} Objeto { canonicalUrl, matchedText, title, description, jpegThumbnail } ou null
 */
export async function buildLinkPreview(url) {
    if (!url) return null;

    // Verificar Cache
    if (previewCache.has(url)) {
        const cached = previewCache.get(url);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        }
        previewCache.delete(url);
    }

    const start = Date.now();
    let result = null;

    try {
        const urlObj = new URL(url);

        // Regra Especial: chat.whatsapp.com
        if (urlObj.hostname === 'chat.whatsapp.com') {
            result = await getWhatsAppInvitePreview(url);
        } else {
            // Preview Genérico
            result = await getGenericLinkPreview(url);
        }

        if (result) {
            // Salvar no Cache
            previewCache.set(url, {
                timestamp: Date.now(),
                data: result
            });
            const duration = Date.now() - start;
            console.log(`[LinkPreview] Sucesso para ${url} (${duration}ms)`);
        }

    } catch (error) {
        console.error(`[LinkPreview] Falha para ${url}: ${error.message}`);
    }

    return result;
}

async function getWhatsAppInvitePreview(url) {
    const thumbPath = path.join(__dirname, '..', 'assets', 'whatsapp-invite-thumb.jpg');
    let jpegThumbnail = null;

    try {
        if (fs.existsSync(thumbPath)) {
            jpegThumbnail = fs.readFileSync(thumbPath);
        } else {
            // Fallback se não existir arquivo: criar um buffer simples ou null
            console.warn('[LinkPreview] Asset whatsapp-invite-thumb.jpg não encontrado.');
        }
    } catch (e) {
        console.error('[LinkPreview] Erro lendo asset:', e);
    }

    return {
        canonicalUrl: url,
        matchedText: url,
        title: 'Convite para grupo do WhatsApp',
        description: 'Toque para entrar no grupo',
        jpegThumbnail: jpegThumbnail
    };
}

async function getGenericLinkPreview(url) {
    try {
        // Fetch metadata com timeout manual (link-preview-js tem timeout, mas às vezes trava)
        // Usando Promise.race para timeout forçado
        const fetchPromise = getLinkPreview(url, {
            timeout: TIMEOUT_MS,
            followRedirects: 'follow',
            headers: {
                'User-Agent': 'WhatsApp/2.21.0.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.150 Safari/537.36'
            }
        });

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout fetching metadata')), TIMEOUT_MS)
        );

        const data = await Promise.race([fetchPromise, timeoutPromise]);

        if (!data) return null;

        // Extrair imagem
        let imageUrl = null;
        if (data.images && data.images.length > 0) {
            imageUrl = data.images[0];
        } else if (data.url && (data.contentType?.startsWith('image/') || data.mediaType === 'image')) {
            imageUrl = data.url;
        }

        let jpegThumbnail = null;
        if (imageUrl) {
            jpegThumbnail = await fetchAndResizeImage(imageUrl);
        }

        return {
            canonicalUrl: data.url || url,
            matchedText: url,
            title: data.title || '',
            description: data.description || '',
            jpegThumbnail: jpegThumbnail
        };

    } catch (e) {
        if (e.message !== 'Timeout fetching metadata') {
            console.warn(`[LinkPreview] Erro fetch metadata: ${e.message}`);
        }
        return null;
    }
}

async function fetchAndResizeImage(imageUrl) {
    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: TIMEOUT_MS
        });

        const buffer = Buffer.from(response.data);

        // Resize com JJimp
        const image = await Jimp.read(buffer);
        image.resize({ w: THUMBNAIL_WIDTH, h: Jimp.AUTO });
        image.quality(THUMBNAIL_QUALITY);

        return await image.getBuffer('image/jpeg');
    } catch (e) {
        console.warn(`[LinkPreview] Erro processando imagem ${imageUrl}: ${e.message}`);
        return null; // Retorna null para enviar sem thumb se falhar a imagem
    }
}
