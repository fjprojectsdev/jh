// IA para Qualificação de Leads
import Groq from 'groq-sdk';
import * as db from './database.js';

const conversationCache = new Map();

const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY || 'your-groq-api-key-here'
});

export async function saveLeadToDB(senderId, data) {
    try {
        const existing = await db.getLeadByUserId(senderId);
        
        const leadData = {
            id: senderId,
            phone: senderId.split('@')[0],
            lastMessage: data.message,
            intent: data.intent,
            confidence: data.confidence,
            conversationCount: existing ? existing.conversation_count + 1 : 1
        };
        
        await db.saveLead(leadData);
        console.log('💾 Lead salvo no Supabase:', senderId);
    } catch (e) {
        console.error('Erro ao salvar lead:', e.message);
    }
}

export async function getLeads() {
    try {
        return await db.getLeads(50);
    } catch (e) {
        return [];
    }
}

function getConversationHistory(senderId) {
    if (!conversationCache.has(senderId)) {
        conversationCache.set(senderId, []);
    }
    return conversationCache.get(senderId);
}

function addToHistory(senderId, role, content) {
    const history = getConversationHistory(senderId);
    history.push({ role, content });
    if (history.length > 10) history.shift();
    conversationCache.set(senderId, history);
}

export async function analyzeLeadIntent(text, senderId) {
    try {
        const history = getConversationHistory(senderId);
        
        const messages = [
            {
                role: "system",
                content: `Você é um assistente de vendas da iMavy. Analise a mensagem do cliente e responda em JSON:

{
  "intent": "interested" | "question" | "greeting" | "casual" | "spam" | "timewaster",
  "confidence": 0-100,
  "response": "sua resposta profissional",
  "needsHuman": true/false
}

🎯 PLANOS MENSAIS DO IMAVYAGENT:

📦 PLANO 1 GRUPO
💰 R$ 100/mês
✅ Comandos padrão
✅ IA de moderação
✅ Anti-link e anti-flood
✅ Boas-vindas automáticas
✅ Suporte normal

📦 PLANO 2 GRUPOS
💰 R$ 200/mês
✅ Tudo do plano anterior
✅ Moderação IA em até 2 grupos simultâneos

⭐ PLANO 3 GRUPOS (MAIS VENDIDO)
💰 R$ 250/mês
✅ Tudo do plano anterior
✅ Suporte para até 3 grupos
✅ Melhor custo-benefício

👑 PLANO PREMIUM EMPRESARIAL
💰 R$ 1.000/mês
✅ Nome do bot personalizado
✅ Foto/logo personalizada
✅ Mensagens com identidade da empresa
✅ Comportamento personalizado
✅ Até 3 grupos incluídos
✅ Suporte prioritário
✅ Consultoria especializada

REGRAS DE COMPORTAMENTO:

1. SAUDAÇÕES (oi, olá, bom dia, boa tarde, boa noite, e aí, tudo bem):
   - Responda educadamente e apresente os serviços
   - intent: "greeting"
   - Exemplo: "Olá! 👋 Sou o assistente da iMavy. Desenvolvemos bots de WhatsApp para automatizar grupos. Posso te mostrar nossos planos?"

2. INTERESSE REAL (preço, valor, quanto custa, planos, contratar, assinatura):
   - Mostre os 4 planos de forma clara e objetiva
   - Destaque o Plano 3 Grupos como MAIS VENDIDO
   - Sempre termine com: "Deseja assinar agora?" ou "Posso ativar o plano para você?"
   - intent: "interested"
   - needsHuman: true (se confiança > 70%)
   - NUNCA mencione planos antigos ou valores diferentes

3. DÚVIDAS (como funciona, o que faz, recursos):
   - Explique de forma clara e objetiva
   - Direcione para os planos
   - intent: "question"

4. PERDA DE TEMPO (conversas aleatórias, piadas, assuntos não relacionados):
   - Seja EDUCADO mas FIRME
   - Redirecione para o assunto ou DISPENSE
   - intent: "timewaster"
   - Exemplo: "Entendo, mas no momento só posso ajudar com informações sobre nossos serviços de automação. Tem interesse em conhecer?"
   - Se insistir: "Agradeço o contato, mas preciso focar em atendimentos relacionados aos nossos serviços. Qualquer dúvida sobre bots, estou à disposição! 😊"

5. SPAM/OFENSIVO:
   - Seja PROFISSIONAL e ENCERRE
   - intent: "spam"
   - Exemplo: "Desculpe, não posso ajudar com isso. Tenha um bom dia."

TOM:
- Profissional, educado e objetivo
- Não seja robótico, seja natural
- Não aceite desvios de assunto
- Dispense educadamente quem não tem interesse real`
            },
            ...history,
            {
                role: "user",
                content: text
            }
        ];

        const response = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages,
            max_tokens: 300,
            temperature: 0.7,
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(response.choices[0].message.content);
        
        addToHistory(senderId, 'user', text);
        addToHistory(senderId, 'assistant', result.response);
        
        await saveLeadToDB(senderId, {
            message: text,
            intent: result.intent,
            confidence: result.confidence
        });
        
        return result;
    } catch (error) {
        console.error('❌ Erro na IA de vendas:', error.message);
        return {
            intent: "question",
            confidence: 0,
            response: "👋 Olá! Sou o assistente da iMavy. Como posso ajudar você hoje?",
            needsHuman: false
        };
    }
}

export function isAISalesEnabled() {
    return process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your-groq-api-key-here';
}
