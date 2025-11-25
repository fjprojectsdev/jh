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
  "intent": "interested" | "question" | "casual" | "spam",
  "confidence": 0-100,
  "response": "sua resposta amigável e profissional",
  "needsHuman": true/false
}

Serviços da iMavy:
- Desenvolvimento de bots WhatsApp
- Automação de atendimento
- Dashboards personalizados
- Integração com APIs

Seja cordial, identifique interesse real e qualifique o lead.`
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
