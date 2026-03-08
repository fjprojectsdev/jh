import 'dotenv/config';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import { getMemory, addToMemory } from './memory.js';
import { getRealtimeContext } from './realtime.js';
import { logger } from './logger.js';

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

function stripHtml(value) {
    return String(value || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

async function getWebSearchContext(question) {
    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(question)}`;
        const response = await fetch(url, {
            headers: {
                'user-agent': 'Mozilla/5.0 (compatible; iMavyBot/1.0; +https://github.com/fjprojectsdev/jh)'
            }
        });

        if (!response.ok) {
            throw new Error(`DuckDuckGo HTTP ${response.status}`);
        }

        const html = await response.text();
        const matches = Array.from(html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi))
            .slice(0, 5)
            .map((match, index) => {
                const link = stripHtml(match[1]);
                const title = stripHtml(match[2]);
                return `${index + 1}. ${title}\nURL: ${link}`;
            })
            .filter(Boolean);

        return matches.length
            ? `BUSCA WEB RECENTE:\n${matches.join('\n\n')}`
            : '';
    } catch (error) {
        logger.warn('ai_web_search_failed', {
            error: error.message || String(error)
        });
        return '';
    }
}

console.log('[AI] Providers ativos:', AI_PROVIDER.join(', ') || 'nenhum');
console.log('[AI] OPENAI_API_KEY:', OPENAI_API_KEY ? 'OK' : 'AUSENTE');
console.log('[AI] GROQ_API_KEY:', GROQ_API_KEY ? 'OK' : 'AUSENTE');
console.log('[AI] OPENROUTER_API_KEY:', OPENROUTER_API_KEY ? 'OK' : 'AUSENTE');

async function callGroq(messages, apiKey = GROQ_API_KEY) {
    const startedAt = Date.now();
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

    logger.debug('ai_http', {
        provider: 'groq',
        ms: Date.now() - startedAt,
        status: response.status,
        ok: response.ok
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Groq API error (${response.status}): ${errorData.error?.message || response.statusText}`);
    }

    return response.json();
}

async function callOpenRouter(messages, apiKey = OPENROUTER_API_KEY) {
    const startedAt = Date.now();
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

    logger.debug('ai_http', {
        provider: 'openrouter',
        ms: Date.now() - startedAt,
        status: response.status,
        ok: response.ok
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`OpenRouter API error (${response.status}): ${errorData.error?.message || response.statusText}`);
    }

    return response.json();
}

export async function askChatGPT(question, userId = 'default', options = {}) {
    const safeQuestion = String(question || '').trim();
    if (!safeQuestion) return null;
    const safeUserId = String(userId || 'default').trim() || 'default';
    const sharedMemoryKey = String(options?.sharedMemoryKey || '').trim();
    const extraSystemContext = String(options?.extraSystemContext || '').trim();
    const allowWebSearch = options?.allowWebSearch === true;

    const startedAt = Date.now();
    const realtimeInfo = await getRealtimeContext(safeQuestion);
    const webSearchInfo = allowWebSearch ? await getWebSearchContext(safeQuestion) : '';
    const systemContext = [
        'Voce e o iMavyBot, um assistente util e amigavel de um grupo do WhatsApp.',
        'Responda de forma concisa e objetiva em portugues.',
        'Voce pode usar memoria das conversas anteriores e materiais internos quando disponiveis.',
        'Se houver materiais internos do grupo, priorize compartilhar links concretos em vez de dizer que nao pode lembrar.',
        '',
        'INFORMACOES EM TEMPO REAL:',
        realtimeInfo
    ];

    if (webSearchInfo) {
        systemContext.push('', webSearchInfo);
    }

    if (extraSystemContext) {
        systemContext.push('', 'CONTEXTO INTERNO DO GRUPO:', extraSystemContext);
    }

    const userMemory = getMemory(safeUserId).slice(-16);
    const sharedMemory = sharedMemoryKey ? getMemory(sharedMemoryKey).slice(-16) : [];

    const messages = [
        {
            role: 'system',
            content: systemContext.join('\n')
        },
        ...sharedMemory,
        ...userMemory,
        {
            role: 'user',
            content: safeQuestion
        }
    ];

    const providers = AI_PROVIDER.length ? AI_PROVIDER : ['openai', 'groq', 'openrouter'];

    for (const provider of providers) {
        if (provider === 'openai' && openai) {
            const providerStart = Date.now();
            try {
                const data = await openai.chat.completions.create({
                    model: OPENAI_MODEL,
                    messages,
                    max_tokens: 1000,
                    temperature: 0.7
                });
                const response = data?.choices?.[0]?.message?.content?.trim();
                if (response) {
                    logger.debug('ai_provider', {
                        provider: 'openai',
                        ms: Date.now() - providerStart,
                        ok: true
                    });
                    addToMemory(safeUserId, 'user', safeQuestion);
                    addToMemory(safeUserId, 'assistant', response);
                    if (sharedMemoryKey) {
                        addToMemory(sharedMemoryKey, 'user', safeQuestion);
                        addToMemory(sharedMemoryKey, 'assistant', response);
                    }
                    return response;
                }
                logger.warn('ai_provider_empty', {
                    provider: 'openai',
                    ms: Date.now() - providerStart
                });
            } catch (error) {
                logger.warn('ai_provider_failed', {
                    provider: 'openai',
                    ms: Date.now() - providerStart,
                    error: error.message
                });
                console.log(`[AI] OpenAI falhou: ${error.message}`);
            }
        }

        if (provider === 'groq' && GROQ_API_KEY) {
            const providerStart = Date.now();
            try {
                const data = await callGroq(messages, GROQ_API_KEY);
                const response = data?.choices?.[0]?.message?.content?.trim();
                if (response) {
                    logger.debug('ai_provider', {
                        provider: 'groq',
                        ms: Date.now() - providerStart,
                        ok: true
                    });
                    addToMemory(safeUserId, 'user', safeQuestion);
                    addToMemory(safeUserId, 'assistant', response);
                    if (sharedMemoryKey) {
                        addToMemory(sharedMemoryKey, 'user', safeQuestion);
                        addToMemory(sharedMemoryKey, 'assistant', response);
                    }
                    return response;
                }
                logger.warn('ai_provider_empty', {
                    provider: 'groq',
                    ms: Date.now() - providerStart
                });
            } catch (error) {
                logger.warn('ai_provider_failed', {
                    provider: 'groq',
                    ms: Date.now() - providerStart,
                    error: error.message
                });
                console.log(`[AI] Groq falhou: ${error.message}`);
            }
        }

        if (provider === 'openrouter' && OPENROUTER_API_KEY) {
            const providerStart = Date.now();
            try {
                const data = await callOpenRouter(messages, OPENROUTER_API_KEY);
                const response = data?.choices?.[0]?.message?.content?.trim();
                if (response) {
                    logger.debug('ai_provider', {
                        provider: 'openrouter',
                        ms: Date.now() - providerStart,
                        ok: true
                    });
                    addToMemory(safeUserId, 'user', safeQuestion);
                    addToMemory(safeUserId, 'assistant', response);
                    if (sharedMemoryKey) {
                        addToMemory(sharedMemoryKey, 'user', safeQuestion);
                        addToMemory(sharedMemoryKey, 'assistant', response);
                    }
                    return response;
                }
                logger.warn('ai_provider_empty', {
                    provider: 'openrouter',
                    ms: Date.now() - providerStart
                });
            } catch (error) {
                logger.warn('ai_provider_failed', {
                    provider: 'openrouter',
                    ms: Date.now() - providerStart,
                    error: error.message
                });
                console.log(`[AI] OpenRouter falhou: ${error.message}`);
            }
        }
    }

    logger.warn('ai_all_failed', { ms: Date.now() - startedAt });
    return null;
}
