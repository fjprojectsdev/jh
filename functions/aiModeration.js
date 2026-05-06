// IA para Moderação de Mensagens
import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { logger } from './logger.js';

const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY || 'your-groq-api-key-here'
});

const openrouter = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || 'your-openrouter-api-key-here'
});

export async function analyzeMessage(text) {
    const startedAt = Date.now();
    try {
        const response = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [{
                role: "system",
                content: `Você é um moderador de grupos do WhatsApp. Analise se a mensagem contém:
- Toxicidade ou agressividade
- Spam ou propaganda excessiva
- Discurso de ódio ou preconceito
- Conteúdo sexual explícito
- Violência ou ameaças
- Golpes ou fraudes

Responda APENAS no formato:
SAFE - se a mensagem é apropriada
UNSAFE: [motivo] - se viola alguma regra`
            }, {
                role: "user",
                content: text
            }],
            max_tokens: 100,
            temperature: 0.3
        });
        
        const result = response.choices[0].message.content.trim();
        const safe = result.startsWith('SAFE');
        logger.debug('ai_moderation', {
            ms: Date.now() - startedAt,
            ok: true,
            safe
        });
        
        return {
            safe,
            reason: safe ? 'Mensagem apropriada' : result.replace('UNSAFE:', '').trim(),
            rawResponse: result
        };
    } catch (error) {
        logger.warn('ai_moderation_failed', {
            ms: Date.now() - startedAt,
            error: error.message
        });
        console.error('❌ Erro na análise de IA:', error.message);
        return { safe: true, reason: 'Erro na IA', error: error.message };
    }
}

// Análise em lote (mais eficiente)
export async function analyzeMessages(messages) {
    const results = await Promise.all(
        messages.map(msg => analyzeMessage(msg))
    );
    return results;
}

export function isAIEnabled() {
    return true;
}
