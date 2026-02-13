import 'dotenv/config';
import fetch from 'node-fetch';
import { getMemory, addToMemory } from './memory.js';
import { getRealtimeContext } from './realtime.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// Debug detalhado
console.log('🔍 DEBUG - Todas as variáveis .env:', Object.keys(process.env).filter(k => k.includes('API')));
console.log('🔑 GROQ_API_KEY:', GROQ_API_KEY ? `Carregada (${GROQ_API_KEY.substring(0, 10)}...)` : 'NÃO ENCONTRADA');
console.log('🔑 OPENROUTER_API_KEY:', OPENROUTER_API_KEY ? `Carregada (${OPENROUTER_API_KEY.substring(0, 10)}...)` : 'NÃO ENCONTRADA');

// Tentar Groq primeiro, depois OpenRouter
async function callGroq(messages, apiKey = GROQ_API_KEY) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: messages,
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
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/imavybot',
            'X-Title': 'iMavyBot'
        },
        body: JSON.stringify({
            model: 'google/gemini-2.0-flash-exp:free',
            messages: messages,
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
    // Função desabilitada - não responde mais
    return null;
}

// Função original desabilitada
async function askChatGPT_DISABLED(question, userId = 'default') {
    console.log('🤖 askChatGPT chamada com:', { question: question.substring(0, 50), userId });
    
    // Verificar APIs novamente na execução
    const groqKey = process.env.GROQ_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    console.log('🔍 Verificando APIs na execução:');
    console.log('- GROQ:', groqKey ? 'OK' : 'FALTANDO');
    console.log('- OPENROUTER:', openrouterKey ? 'OK' : 'FALTANDO');
    
    if (!groqKey && !openrouterKey) {
        console.error('❌ Nenhuma API disponível no momento da execução');
        return 'Desculpe, não posso responder no momento.';
    }
    
    // Obter contexto em tempo real
    const realtimeInfo = await getRealtimeContext(question);
    
    const messages = [
        {
            role: 'system',
            content: `Você é o iMavyBot, um assistente útil e amigável de um grupo do WhatsApp. Responda de forma concisa e objetiva em português. Você tem memória das conversas anteriores.

INFORMAÇÕES EM TEMPO REAL:
${realtimeInfo}`
        },
        ...getMemory(userId),
        {
            role: 'user',
            content: question
        }
    ];

    try {
        // Tentar Groq primeiro
        if (groqKey) {
            try {
                const data = await callGroq(messages, groqKey);
                if (data.choices && data.choices[0]) {
                    const resposta = data.choices[0].message.content.trim();
                    addToMemory(userId, 'user', question);
                    addToMemory(userId, 'assistant', resposta);
                    console.log('✅ Resposta via Groq');
                    return resposta;
                }
            } catch (error) {
                console.log(`⚠️ Groq falhou: ${error.message}, tentando OpenRouter...`);
            }
        }

        // Fallback para OpenRouter
        if (openrouterKey) {
            try {
                const data = await callOpenRouter(messages, openrouterKey);
                if (data.choices && data.choices[0]) {
                    const resposta = data.choices[0].message.content.trim();
                    addToMemory(userId, 'user', question);
                    addToMemory(userId, 'assistant', resposta);
                    console.log('✅ Resposta via OpenRouter (Gemini 2.0)');
                    return resposta;
                } else if (data.error) {
                    console.error('❌ OpenRouter retornou erro:', data.error);
                    throw new Error(data.error.message || 'Erro na API OpenRouter');
                }
            } catch (error) {
                console.error(`❌ OpenRouter também falhou: ${error.message}`);
                throw error; // Re-throw para ser capturado pelo catch externo
            }
        }

        return 'Desculpe, não posso responder no momento.';

    } catch (error) {
        console.error('❌ Erro ao chamar IA:', error);
        return 'Desculpe, não posso responder no momento.';
    }
}
