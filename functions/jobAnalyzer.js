import OpenAI from 'openai';

import { logger } from './logger.js';

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const GROQ_MODEL = String(process.env.IMAVY_GROQ_MODEL || 'llama-3.3-70b-versatile').trim();

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function normalizeSpace(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripNoise(value) {
    const cleaned = String(value || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/<[A-Za-z/][^>]*>/g, ' ')
        .replace(/\b(class|style|function|const|var|let|return|import|export)\b\s*[=:]/gi, ' ')
        .replace(/[{}[\];<>]{2,}/g, ' ')
        .replace(/[#@][A-Za-z0-9_-]{4,}/g, ' ')
        .replace(/\bsc-[A-Za-z0-9-]{5,}\b/g, ' ')
        .replace(/\b[a-zA-Z0-9_-]{18,}\b/g, ' ')
        .replace(/\b[gG][A-Za-z0-9]{5,}\b/g, ' ')
        .replace(/["'`]/g, ' ')
        .replace(/\?{2,}/g, ' ')
        .replace(/\s[-|/]\s/g, ' ')
        .replace(/\b(title|subtitle|qualifica(?:coes|ções)|requisitos)\s*[-:"]?\s*class\b/gi, ' ')
        .replace(/\b(css|javascript|html)\b/gi, ' ');

    return normalizeSpace(cleaned);
}

function cutAtSuspiciousMarker(value) {
    const safe = String(value || '');
    const markers = ['class=', ' sc-', ' gDozGp', ' title"', ' function ', ' const '];
    let result = safe;
    for (const marker of markers) {
        const idx = result.toLowerCase().indexOf(marker.toLowerCase());
        if (idx >= 0) {
            result = result.slice(0, idx);
        }
    }
    return normalizeSpace(result);
}

function extractAfterLabel(value, labelRegex) {
    const match = String(value || '').match(labelRegex);
    return match ? normalizeSpace(match[1]) : '';
}

function truncate(value, maxLen) {
    const text = normalizeSpace(value);
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 3).trim()}...`;
}

function compactList(value, maxLen) {
    const cleaned = normalizeSpace(String(value || '')
        .replace(/\s*[|•·]\s*/g, ', ')
        .replace(/\s*-\s*/g, ', ')
        .replace(/\s*;\s*/g, ', ')
        .replace(/,+/g, ', ')
        .replace(/\s*,\s*/g, ', '));

    if (!cleaned) return '';

    const parts = cleaned
        .split(',')
        .map((item) => normalizeSpace(item))
        .filter(Boolean);

    return truncate(Array.from(new Set(parts)).join(', '), maxLen);
}

function looksRemoteOrForeign(text) {
    const safe = normalizeSpace(text).toLowerCase();
    if (!safe) return false;
    return [
        'remote',
        'full-time europe',
        'europe',
        'english',
        'working at',
        'smart working',
        'worldwide',
        'global team',
        'home office',
        'remoto'
    ].some((term) => safe.includes(term));
}

function looksCodePolluted(text) {
    const safe = String(text || '');
    return /class=|function\s*\(|const\s+[a-z_]|return\s+|<\/?[a-z][^>]*>|sc-[a-z0-9-]{5,}/i.test(safe);
}

function mostlyEnglish(text) {
    const safe = normalizeSpace(text);
    if (!safe) return false;
    const englishHits = (safe.match(/\b(the|and|with|your|about|working|remote|full-time|team|experience|requirements|day|growth|opportunity)\b/gi) || []).length;
    return englishHits >= 4;
}

function deterministicAnalysis(job) {
    const rawText = [
        job.title,
        job.company,
        job.location,
        job.summary,
        job.requirements,
        job.applyInfo
    ].join(' ');

    if (looksRemoteOrForeign(rawText) || mostlyEnglish(rawText)) {
        return { publish: false, reason: 'vaga_remota_ou_estrangeira' };
    }

    const cleanSummary = stripNoise(job.summary);
    const cleanRequirements = stripNoise(job.requirements);
    const cleanApply = stripNoise(job.applyInfo);

    const summary = truncate(
        cutAtSuspiciousMarker(cleanSummary) || `${job.title} em ${job.location}.`,
        160
    );
    const extractedRequirements = extractAfterLabel(
        `${job.requirements || ''} ${job.summary || ''}`,
        /Requisitos?(?:\s+e\s+qualificações)?\s*[-:]\s*([\s\S]+)/i
    );
    const requirements = truncate(
        extractedRequirements
            ? stripNoise(cutAtSuspiciousMarker(extractedRequirements))
            : cleanRequirements && !looksCodePolluted(cleanRequirements)
                ? cutAtSuspiciousMarker(cleanRequirements)
                : summary,
        140
    );
    const applyInfo = truncate(cleanApply || `A candidatura deve ser feita pelo link da vaga.`, 120);

    return {
        publish: true,
        title: truncate(stripNoise(job.title), 120),
        company: truncate(stripNoise(job.company || 'Empresa nao informada'), 80),
        location: truncate(stripNoise(job.location || 'Porto Velho/RO'), 60),
        role: truncate(stripNoise(job.role || job.title), 120),
        summary,
        requirements: compactList(requirements, 140),
        applyInfo,
        sourceLabel: job.sourceLabel,
        url: job.url
    };
}

async function callGroqJson(messages) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            max_tokens: 500,
            temperature: 0.2,
            response_format: { type: 'json_object' }
        })
    });

    if (!response.ok) {
        const error = await response.text().catch(() => response.statusText);
        throw new Error(`Groq API error (${response.status}): ${error}`);
    }

    const data = await response.json();
    return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
}

async function callOpenAiJson(messages) {
    if (!openai) {
        throw new Error('OpenAI indisponivel');
    }

    const data = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages,
        max_tokens: 500,
        temperature: 0.2,
        response_format: { type: 'json_object' }
    });

    return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
}

function buildMessages(job) {
    return [
        {
            role: 'system',
            content: [
                'Voce analisa vagas de emprego para publicar em um grupo de WhatsApp.',
                'Responda somente JSON valido com as chaves:',
                'publish (boolean),',
                'reason (string curta),',
                'title, company, location, role, summary, requirements, applyInfo.',
                'Objetivo: enviar vagas de Porto Velho/RO em portugues claro, sem HTML, sem codigo, sem lixo visual.',
                'Regras:',
                '- Rejeite vagas em ingles, internacionais, europeias, claramente remotas ou sem relacao real com Porto Velho/RO.',
                '- Reescreva em portugues objetivo.',
                '- Summary: 1 a 2 frases curtas.',
                '- Requirements: itens principais em uma frase curta.',
                '- ApplyInfo: explique como se candidatar com base no texto; se nao houver detalhes, diga para acessar o link da vaga.',
                '- Nao invente dados ausentes.',
                '- Remova HTML, CSS, JS, nomes de classes, hashtags, rastros de codigo e termos quebrados.',
                '- Se houver texto confuso ou sujo, limpe antes de resumir.'
            ].join('\n')
        },
        {
            role: 'user',
            content: JSON.stringify({
                title: job.title,
                company: job.company,
                location: job.location,
                role: job.role,
                summary: job.summary,
                requirements: job.requirements,
                applyInfo: job.applyInfo,
                sourceLabel: job.sourceLabel,
                url: job.url
            })
        }
    ];
}

function normalizeAiResult(result, job) {
    const merged = {
        publish: result?.publish !== false,
        reason: normalizeSpace(result?.reason),
        title: truncate(stripNoise(result?.title || job.title), 120),
        company: truncate(stripNoise(result?.company || job.company || 'Empresa nao informada'), 80),
        location: truncate(stripNoise(result?.location || job.location || 'Porto Velho/RO'), 60),
        role: truncate(stripNoise(result?.role || job.role || job.title), 120),
        summary: truncate(stripNoise(result?.summary || job.summary), 160),
        requirements: compactList(result?.requirements || job.requirements, 140),
        applyInfo: truncate(stripNoise(result?.applyInfo || job.applyInfo || 'Acesse o link da vaga para se candidatar.'), 120),
        sourceLabel: job.sourceLabel,
        url: job.url
    };

    if (!merged.publish) return merged;
    const joined = [merged.title, merged.company, merged.location, merged.summary, merged.requirements].join(' ');
    if (looksRemoteOrForeign(joined) || mostlyEnglish(joined)) {
        return { publish: false, reason: 'vaga_filtrada_pos_analise' };
    }
    return merged;
}

export async function analyzeJobForPublishing(job) {
    const fallback = deterministicAnalysis(job);
    if (!fallback.publish) return fallback;

    const messages = buildMessages(job);
    const startedAt = Date.now();

    try {
        const result = GROQ_API_KEY
            ? await callGroqJson(messages)
            : openai
                ? await callOpenAiJson(messages)
                : null;

        if (!result || typeof result !== 'object') {
            return fallback;
        }

        logger.debug('job_analyzer', {
            provider: GROQ_API_KEY ? 'groq' : 'openai',
            ms: Date.now() - startedAt,
            publish: result.publish !== false
        });

        return normalizeAiResult(result, fallback);
    } catch (error) {
        logger.warn('job_analyzer_failed', {
            ms: Date.now() - startedAt,
            error: error?.message || String(error)
        });
        return fallback;
    }
}
