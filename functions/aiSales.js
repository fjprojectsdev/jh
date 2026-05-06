import * as db from './database.js';
import { logger } from './logger.js';

const salesState = new Map();

// Sessão expira após 2h de inatividade — força nova conversa
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// Planos de grupos (usados apenas quando o cliente QUER grupos)
const SALES_PLANS = {
    fundador: { name: 'Fundador', price: 'R$ 100/mes', groups: '1 grupo' },
    pro: { name: 'Pro', price: 'R$ 200/mes', groups: 'ate 2 grupos' },
    business: { name: 'Business', price: 'R$ 250/mes', groups: 'ate 3 grupos' }
};

function now() {
    return Date.now();
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function createFreshState() {
    return {
        step: 'start',       // start | choose_type | awaiting_group_count | awaiting_objective | custom_bot_discovery | handoff
        type: null,          // 'group' | 'custom_bot'
        groupCount: null,
        objective: '',
        wantsCustomAI: null,
        customBotDescription: '',
        lastUserText: '',
        lastUserAt: 0,
        lastBotReply: '',
        lastBotAt: 0,
        notifiedAt: 0
    };
}

function getState(senderId) {
    const key = String(senderId || '').trim();
    const existing = salesState.get(key);

    // Expirar sessão inativa
    if (existing && existing.lastUserAt > 0 && (Date.now() - existing.lastUserAt) > SESSION_TTL_MS) {
        salesState.delete(key);
    }

    if (!salesState.has(key)) {
        salesState.set(key, createFreshState());
    }
    return salesState.get(key);
}

function resetState(senderId) {
    const key = String(senderId || '').trim();
    salesState.set(key, createFreshState());
    return salesState.get(key);
}

function saveState(senderId, state) {
    salesState.set(String(senderId || '').trim(), state);
}

function rememberTurn(state, userText, botReply) {
    state.lastUserText = normalizeText(userText);
    state.lastUserAt = now();
    state.lastBotReply = String(botReply || '').trim();
    state.lastBotAt = now();
}

function isGreeting(text) {
    return /^(oi|ola|opa|e ai|eae|bom dia|boa tarde|boa noite|tudo bem|fala|oii+|olaa+)[!. ]*$/.test(normalizeText(text));
}

function looksCommercial(text) {
    return /\b(bot|grupo|grupos|plano|planos|preco|valor|quanto custa|contratar|assinatura|automatizacao|automacao|ia|atendimento|moderacao|modera[cç][aã]o|avisos|comunidade|vendas|suporte|personalizado|agendamento|pedido|notificacao|integracao)\b/.test(normalizeText(text));
}

// Detecta se o cliente quer um bot personalizado (não apenas grupos)
function isCustomBotRequest(text) {
    const normalized = normalizeText(text);
    return /\b(bot personalizado|bot para|sistema|app|aplicativo|loja|ecommerce|agenda|pedido|delivery|hospital|clinica|escola|curso|site|negocio|empresa|atendimento automatico|sac automatizado|outro|outra|outros|nao e grupo|nao e para grupo|diferente)\b/.test(normalized);
}

// Detecta se o cliente quer plano de grupo
function isGroupRequest(text) {
    const normalized = normalizeText(text);
    return /\b(grupo|grupos|whatsapp|comunidade|moderacao|lembrete|anti[-\s]?spam)\b/.test(normalized);
}

// Detecta qual tipo o cliente escolheu quando perguntamos "grupo ou personalizado?"
function detectTypeChoice(text) {
    const normalized = normalizeText(text);
    if (/\b(grupo|grupos|1|primeiro|plano)\b/.test(normalized)) return 'group';
    if (/\b(personalizado|custom|bot para|outro|outra|2|segundo|especifico|especifica|diferente|nao grupo|minha empresa|meu negocio)\b/.test(normalized)) return 'custom_bot';
    return null;
}

function extractGroupCount(text) {
    const normalized = normalizeText(text);
    if (/\b(um|1)\b/.test(normalized)) return 1;
    if (/\b(dois|duas|2)\b/.test(normalized)) return 2;
    if (/\b(tres|3)\b/.test(normalized)) return 3;
    if (/\b(quatro|4)\b/.test(normalized)) return 4;
    if (/\b(cinco|5)\b/.test(normalized)) return 5;
    const numeric = normalized.match(/\b(\d{1,2})\b/);
    if (numeric) {
        const value = Number.parseInt(numeric[1], 10);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
}

function extractObjective(text) {
    const normalized = normalizeText(text);
    if (!normalized) return '';
    if (/\b(venda|vendas|captar cliente|captacao|comercial)\b/.test(normalized)) return 'vendas';
    if (/\b(suporte|atendimento|sac)\b/.test(normalized)) return 'suporte';
    if (/\b(comunidade|engajamento|membros|membro)\b/.test(normalized)) return 'comunidade';
    if (/\b(moderacao|moderar|organizar|avisos|regras|anti[- ]?spam)\b/.test(normalized)) return 'moderacao e organizacao';
    if (normalized.length >= 8) return String(text || '').trim().slice(0, 120);
    return '';
}

function isPricingQuestion(text) {
    return /\b(preco|precos|valor|valores|quanto custa|quanto fica|plano|planos|orcamento|orçamento)\b/.test(normalizeText(text));
}

function choosePlan(groupCount) {
    if (!groupCount || groupCount <= 1) return SALES_PLANS.fundador;
    if (groupCount <= 2) return SALES_PLANS.pro;
    return SALES_PLANS.business;
}

function buildGroupPlansText() {
    return [
        '📦 *Planos para Grupos WhatsApp:*',
        `• ${SALES_PLANS.fundador.name}: ${SALES_PLANS.fundador.price} (${SALES_PLANS.fundador.groups})`,
        `• ${SALES_PLANS.pro.name}: ${SALES_PLANS.pro.price} (${SALES_PLANS.pro.groups})`,
        `• ${SALES_PLANS.business.name}: ${SALES_PLANS.business.price} (${SALES_PLANS.business.groups})`
    ].join('\n');
}

function buildCustomBotText() {
    return [
        '🤖 *Bot Personalizado:*',
        '• Atendimento comercial, pedidos, SAC, agendamentos...',
        '• Integracoes com sistemas, APIs e muito mais',
        '• *Preco a combinar* conforme o projeto',
        '• Orcamento gratuito e sem compromisso'
    ].join('\n');
}

export async function saveLeadToDB(senderId, data) {
    try {
        const existing = await db.getLeadByUserId(senderId);
        await db.saveLead({
            id: senderId,
            phone: senderId.split('@')[0],
            lastMessage: data.message,
            intent: data.intent,
            confidence: data.confidence,
            conversationCount: existing ? existing.conversation_count + 1 : 1
        });
    } catch (error) {
        console.error('Erro ao salvar lead:', error.message);
    }
}

export async function getLeads() {
    try {
        return await db.getLeads(50);
    } catch {
        return [];
    }
}

export function registerSalesTurn(senderId, userText, assistantReply) {
    const state = getState(senderId);
    rememberTurn(state, userText, assistantReply);
    saveState(senderId, state);
}

export function wasRecentSalesReply(senderId, reply, cooldownMs = 90_000) {
    return false;
}

// Resposta imediata sem IA — para primeiros contatos simples
export function getInstantSalesReply(text, senderId) {
    const state = getState(senderId);

    // Saudação em qualquer etapa reinicia a conversa
    if (isGreeting(text)) {
        resetState(senderId);
        return 'Ola! Tudo bem? 😊 Trabalho com dois tipos de solucao:\n\n📦 *1. Planos para grupos WhatsApp* — moderacao, lembretes, anti-spam e mais\n🤖 *2. Bots personalizados* — qualquer finalidade: atendimento, loja, pedidos, agendamentos...\n\nQual das opcoes te interessa?';
    }

    if (state.step !== 'start') return null;

    const normalized = normalizeText(text);

    // Cliente pediu bot personalizado já de cara
    if (isCustomBotRequest(text) && !isGroupRequest(text)) {
        return 'Perfeito! Desenvolvemos bots personalizados para qualquer finalidade. Me conta um pouco mais: qual e o seu negocio e o que o bot deveria fazer?';
    }

    // Cliente pediu info geral
    if (normalized.length <= 50 && (looksCommercial(text) || /^(quero saber|tenho interesse|me explica|me fala|preciso de)/.test(normalized))) {
        return 'Consigo te orientar! Voce quer um plano para gerenciar grupos no WhatsApp, ou um bot personalizado para alguma finalidade especifica (atendimento, loja, agendamentos, etc.)?';
    }

    return null;
}

export async function analyzeLeadIntent(text, senderId) {
    const startedAt = now();
    const state = getState(senderId);
    const safeText = String(text || '').trim();
    const normalized = normalizeText(safeText);

    if (!safeText) {
        return { intent: 'question', confidence: 0, response: null, needsHuman: false };
    }

    let response = '';
    let intent = 'question';
    let confidence = 70;
    let needsHuman = false;

    // ── ETAPA: start ──────────────────────────────────────────────
    if (state.step === 'start') {

        // Saudação no analyzeLeadIntent (safety net)
        if (isGreeting(safeText)) {
            state.step = 'choose_type';
            intent = 'greeting';
            confidence = 70;
            response = 'Ola! 😊 Trabalho com dois tipos de solucao:\n\n📦 *1. Planos para grupos WhatsApp* — moderacao, lembretes, anti-spam\n🤖 *2. Bots personalizados* — atendimento, loja, pedidos, agendamentos...\n\nQual te interessa?';
        }
        // Cliente deixou claro que quer bot personalizado
        else if (isCustomBotRequest(safeText) && !isGroupRequest(safeText)) {
            state.type = 'custom_bot';
            state.step = 'custom_bot_discovery';
            intent = 'interested';
            confidence = 85;
            response = 'Entendido! Desenvolvemos bots sob medida para qualquer finalidade. Para te passar um orcamento, me conta: qual e o seu negocio e o que o bot precisa fazer?';
        }
        // Cliente deixou claro que quer grupos
        else if (isGroupRequest(safeText) && !isCustomBotRequest(safeText)) {
            state.type = 'group';
            const groupCount = extractGroupCount(safeText);
            state.groupCount = groupCount;
            if (groupCount) {
                state.step = 'awaiting_objective';
                intent = 'interested';
                confidence = 80;
                response = `Otimo! Para ${groupCount} grupo(s), qual seria o principal objetivo: vendas, suporte, comunidade ou moderacao?`;
            } else {
                state.step = 'awaiting_group_count';
                intent = 'interested';
                confidence = 75;
                response = 'Certo! Voce pretende usar em quantos grupos?';
            }
        }
        // Ambíguo — pergunta qual tipo
        else {
            state.step = 'choose_type';
            intent = isGreeting(safeText) ? 'greeting' : 'interested';
            confidence = 70;
            response = 'Trabalho com dois tipos de solucao:\n\n📦 *1. Planos para grupos WhatsApp* — moderacao, lembretes, comandos (a partir de R$ 100/mes)\n🤖 *2. Bot personalizado* — qualquer finalidade: atendimento, loja, SAC, agendamentos (preco a combinar)\n\nQual te interessa?';
        }
    }

    // ── ETAPA: choose_type ────────────────────────────────────────
    else if (state.step === 'choose_type') {
        const choice = detectTypeChoice(safeText);
        if (choice === 'group') {
            state.type = 'group';
            state.step = 'awaiting_group_count';
            intent = 'interested';
            confidence = 80;
            response = 'Otimo! Voce pretende usar em quantos grupos?';
        } else if (choice === 'custom_bot') {
            state.type = 'custom_bot';
            state.step = 'custom_bot_discovery';
            intent = 'interested';
            confidence = 85;
            response = 'Perfeito! Me conta mais: qual e o seu negocio e o que o bot precisa fazer?';
        } else if (isPricingQuestion(safeText)) {
            intent = 'question';
            confidence = 72;
            response = `${buildGroupPlansText()}\n\n${buildCustomBotText()}\n\nQual das opcoes faz mais sentido para voce?`;
        } else {
            intent = 'question';
            confidence = 65;
            response = 'Voce prefere a opcao 1 (grupos WhatsApp) ou a opcao 2 (bot personalizado para outra finalidade)?';
        }
    }

    // ── ETAPA: custom_bot_discovery ───────────────────────────────
    else if (state.step === 'custom_bot_discovery') {
        state.customBotDescription = safeText.slice(0, 300);
        state.step = 'handoff';
        intent = 'interested';
        confidence = 92;
        needsHuman = true;
        response = 'Entendi bem o que voce precisa! O desenvolvedor vai entrar em contato com voce aqui no PV para apresentar a proposta e o orcamento. Em breve!';
    }

    // ── ETAPA: awaiting_group_count ───────────────────────────────
    else if (state.step === 'awaiting_group_count') {
        const groupCount = extractGroupCount(safeText);
        if (groupCount) {
            state.groupCount = groupCount;
            state.step = 'awaiting_objective';
            intent = 'interested';
            confidence = 78;
            response = `Perfeito, ${groupCount} grupo(s). Qual seria o principal objetivo do bot: vendas, suporte, comunidade ou moderacao?`;
        } else if (isPricingQuestion(safeText)) {
            intent = 'question';
            confidence = 75;
            response = `${buildGroupPlansText()}\n\nPara indicar o melhor plano, me diga tambem quantos grupos voce pretende usar.`;
        } else {
            intent = 'question';
            confidence = 65;
            response = 'Me diga a quantidade de grupos, por exemplo: 1, 2 ou 3 grupos.';
        }
    }

    // ── ETAPA: awaiting_objective ─────────────────────────────────
    else if (state.step === 'awaiting_objective') {
        const objective = extractObjective(safeText);
        if (objective) {
            state.objective = objective;
            state.step = 'handoff';
            intent = 'interested';
            confidence = 88;
            needsHuman = true;
            const recommended = choosePlan(state.groupCount);
            response = `Entendido! Para ${state.groupCount || 'o(s)'} grupo(s) com foco em ${objective}, o plano mais indicado e o *${recommended.name}* (${recommended.price}).\n\nVou sinalizar o desenvolvedor para continuar com voce aqui no PV!`;
        } else if (isPricingQuestion(safeText)) {
            intent = 'question';
            confidence = 75;
            response = `${buildGroupPlansText()}\n\nQual e o principal objetivo do bot no seu caso?`;
        } else {
            intent = 'question';
            confidence = 65;
            response = 'Me diga em uma frase o objetivo principal: vendas, suporte, comunidade ou moderacao.';
        }
    }

    // ── ETAPA: handoff ────────────────────────────────────────────
    else if (state.step === 'handoff') {
        intent = 'interested';
        confidence = 95;
        needsHuman = true;
        if (isGreeting(safeText)) {
            // Reinicia conversa mesmo no handoff
            const fresh = resetState(senderId);
            fresh.step = 'choose_type';
            saveState(senderId, fresh);
            response = 'Ola de novo! 😊 Posso te ajudar com:\n\n📦 *1. Planos para grupos WhatsApp*\n🤖 *2. Bot personalizado*\n\nQual te interessa?';
            intent = 'greeting';
            confidence = 70;
            needsHuman = false;
        } else if (isPricingQuestion(safeText)) {
            if (state.type === 'custom_bot') {
                response = `${buildCustomBotText()}\n\nO preco e definido conforme o projeto. O desenvolvedor vai te passar o orcamento em breve!`;
            } else {
                response = `${buildGroupPlansText()}\n\nO desenvolvedor vai continuar com voce aqui no PV. Em breve!`;
            }
        } else {
            response = 'O desenvolvedor vai entrar em contato com voce aqui no PV em breve!';
        }
    }

    // ── Fallback ──────────────────────────────────────────────────
    if (!response) {
        intent = 'question';
        confidence = 60;
        response = 'Voce quer um plano para grupos WhatsApp ou um bot personalizado para outra finalidade?';
    }

    rememberTurn(state, safeText, response);
    saveState(senderId, state);

    await saveLeadToDB(senderId, {
        message: safeText,
        intent,
        confidence
    });

    logger.debug('ai_sales_deterministic', {
        ms: now() - startedAt,
        senderId,
        step: state.step,
        type: state.type,
        intent,
        confidence,
        needsHuman
    });

    return {
        intent,
        confidence,
        response,
        needsHuman,
        state: {
            step: state.step,
            type: state.type,
            groupCount: state.groupCount,
            objective: state.objective,
            customBotDescription: state.customBotDescription,
            wantsCustomAI: state.wantsCustomAI
        }
    };
}

export function isAISalesEnabled() {
    return true;
}
