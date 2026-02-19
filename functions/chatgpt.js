import 'dotenv/config';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import { getMemory, addToMemory } from './memory.js';
import { getRealtimeContext } from './realtime.js';

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();
const OPENROUTER_API_KEY = String(process.env.OPENROUTER_API_KEY || '').trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const GROQ_MODEL = String(process.env.IMAVY_GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const OPENROUTER_MODEL = String(process.env.IMAVY_OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free').trim();
const AI_PROVIDER = String(process.env.IMAVY_AI_PROVIDER || 'openai,groq,openrouter')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log('[AI] Providers ativos:', AI_PROVIDER.join(', ') || 'nenhum');
console.log('[AI] OPENAI_API_KEY:', OPENAI_API_KEY ? 'OK' : 'AUSENTE');
console.log('[AI] GROQ_API_KEY:', GROQ_API_KEY ? 'OK' : 'AUSENTE');
console.log('[AI] OPENROUTER_API_KEY:', OPENROUTER_API_KEY ? 'OK' : 'AUSENTE');

async function callGroq(messages, apiKey = GROQ_API_KEY) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            max_tokens: 1000,
            temperature: 0.7
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Groq API error (${response.status}): ${errorData.error?.message || response.statusText}`);
    }

    return response.json();
}

async function callOpenRouter(messages, apiKey = OPENROUTER_API_KEY) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/imavybot',
            'X-Title': 'iMavyBot'
        },
        body: JSON.stringify({
            model: OPENROUTER_MODEL,
            messages,
            max_tokens: 1000,
            temperature: 0.7
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`OpenRouter API error (${response.status}): ${errorData.error?.message || response.statusText}`);
    }

    return response.json();
}

export async function askChatGPT(question, userId = 'default') {
    const safeQuestion = String(question || '').trim();
    if (!safeQuestion) return null;

    const realtimeInfo = await getRealtimeContext(safeQuestion);
    const messages = [
        {
            role: 'system',
            content: `Voce e o iMavyBot, um assistente util e amigavel de um grupo do WhatsApp. Responda de forma concisa e objetiva em portugues. Voce tem memoria das conversas anteriores.

INFORMACOES EM TEMPO REAL:
${realtimeInfo}`
        },
        ...getMemory(userId),
        {
            role: 'user',
            content: safeQuestion
        }
    ];

    const providers = AI_PROVIDER.length ? AI_PROVIDER : ['openai', 'groq', 'openrouter'];

    for (const provider of providers) {
        if (provider === 'openai' && openai) {
            try {
                const data = await openai.chat.completions.create({
                    model: OPENAI_MODEL,
                    messages,
                    max_tokens: 1000,
                    temperature: 0.7
                });
                const response = data?.choices?.[0]?.message?.content?.trim();
                if (response) {
                    addToMemory(userId, 'user', safeQuestion);
                    addToMemory(userId, 'assistant', response);
                    return response;
                }
            } catch (error) {
                console.log(`[AI] OpenAI falhou: ${error.message}`);
            }
        }

        if (provider === 'groq' && GROQ_API_KEY) {
            try {
                const data = await callGroq(messages, GROQ_API_KEY);
                const response = data?.choices?.[0]?.message?.content?.trim();
                if (response) {
                    addToMemory(userId, 'user', safeQuestion);
                    addToMemory(userId, 'assistant', response);
                    return response;
                }
            } catch (error) {
                console.log(`[AI] Groq falhou: ${error.message}`);
            }
        }

        if (provider === 'openrouter' && OPENROUTER_API_KEY) {
            try {
                const data = await callOpenRouter(messages, OPENROUTER_API_KEY);
                const response = data?.choices?.[0]?.message?.content?.trim();
                if (response) {
                    addToMemory(userId, 'user', safeQuestion);
                    addToMemory(userId, 'assistant', response);
                    return response;
                }
            } catch (error) {
                console.log(`[AI] OpenRouter falhou: ${error.message}`);
            }
        }
    }

    return null;
}
