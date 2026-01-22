/**
 * Módulo de Segurança de Saída (Outgoing Guard)
 * Intercepta todas as chamadas sock.sendMessage para garantir que nada vazio saia.
 */

function sanitizeText(input) {
    if (input === null || input === undefined) return "";
    let t = String(input);

    // remove invisíveis comuns + normaliza espaços
    t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
    t = t.replace(/\r/g, "");
    t = t.replace(/[ \t]+/g, " ");
    t = t.replace(/\n{3,}/g, "\n\n"); // Máximo 2 quebras de linha seguidas

    return t.trim();
}

function isEmptyBaileysContent(content) {
    if (!content || typeof content !== "object") return true;

    // Principais formas de texto/caption
    const text = content.text ?? content.caption ?? content.conversation ?? "";
    const cleaned = sanitizeText(text);

    // Se for mensagem puramente de texto/caption e ficar vazia => bloqueia
    const isTextLike = ("text" in content) || ("caption" in content) || ("conversation" in content);

    // Se não for "text-like", pode ser imagem, doc, sticker etc. Aí checa se tem mídia
    const hasMedia =
        "image" in content ||
        "video" in content ||
        "audio" in content ||
        "document" in content ||
        "sticker" in content ||
        "contacts" in content ||
        "location" in content ||
        "delete" in content || // Permite apagar mensagens
        "edit" in content;     // Permite editar

    if (isTextLike) {
        // Se for text-like E não tiver mídia/ação associada, vale o texto limpo
        if (!hasMedia && cleaned.length === 0) return true;

        // Se tiver mídia/ação, o texto (caption) pode ser vazio, mas se tiver texto, ele deve ser limpo depois
        return false;
    }

    // Se não é texto e não tem mídia, é payload “fantasma”
    if (!hasMedia) return true;

    // Se tem mídia, ok mesmo sem caption
    return false;
}

export function attachOutgoingGuard(sock) {
    const original = sock.sendMessage.bind(sock);

    sock.sendMessage = async (jid, content, options) => {
        try {
            if (isEmptyBaileysContent(content)) {
                console.warn(`[OUTGOING BLOCK] Bloqueado envio vazio para ${jid}. Content keys: ${content ? Object.keys(content) : 'null'}`);
                return; // não envia
            }

            // Se for texto/caption, substitui pelo sanitizado (evita invisíveis escaparem no payload final)
            if (content) {
                if ("text" in content && typeof content.text === 'string') {
                    const clean = sanitizeText(content.text);
                    if (!clean && !content.delete && !content.edit) return; // Bloqueia se a limpeza resultou em vazio e não é ação
                    content.text = clean;
                }
                if ("caption" in content && typeof content.caption === 'string') {
                    content.caption = sanitizeText(content.caption);
                }
                if ("conversation" in content && typeof content.conversation === 'string') {
                    content.conversation = sanitizeText(content.conversation);
                }
            }

            return await original(jid, content, options);
        } catch (e) {
            console.error(`[OUTGOING ERROR] Falha ao enviar para ${jid}: ${e.message}`);
            throw e;
        }
    };

    console.log('🛡️ Outgoing Guard ativado: Socket protegido contra mensagens vazias.');
    return sock;
}
