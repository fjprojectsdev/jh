import OpenAI from 'openai';

import { logger } from './logger.js';
import { sanitizeText } from './messageHandler.js';
import {
    buildJobCompatibilityPrompt,
    buildJobExtractionPrompt,
    buildJobFilteringPrompt
} from './jobPrompts.js';

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const GROQ_MODEL = String(process.env.IMAVY_GROQ_MODEL || 'llama-3.3-70b-versatile').trim();

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function normalizeSpace(value) {
    return sanitizeText(String(value || ''))
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

function extractSalaryInfo(value) {
    const safe = normalizeSpace(String(value || ''));
    if (!safe) return '';
    const match = safe.match(/(?:sal[aá]rio|faixa salarial|sal[aá]rio e benef[íi]cios|benef[íi]cios)\s*:\s*([^|]+)$/i);
    return match ? truncate(stripNoise(match[1]), 120) : '';
}

function removeSalaryInfo(value) {
    return normalizeSpace(String(value || '')
        .replace(/(?:sal[aá]rio|faixa salarial|sal[aá]rio e benef[íi]cios|benef[íi]cios)\s*:\s*[^|]+/gi, ' ')
        .replace(/\s+[|,;]\s*$/g, ' '));
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
    const salaryInfo = extractSalaryInfo(`${job.salaryInfo || ''} | ${job.requirements || ''} | ${job.summary || ''}`);

    const summary = truncate(
        cutAtSuspiciousMarker(cleanSummary) || `${job.title} em ${job.location}.`,
        420
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
        420
    );
    const applyInfo = truncate(cleanApply || `A candidatura deve ser feita pelo link da vaga.`, 220);

    return {
        publish: true,
        title: truncate(stripNoise(job.title), 120),
        company: truncate(stripNoise(job.company || 'Empresa nao informada'), 80),
        location: truncate(stripNoise(job.location || 'Porto Velho/RO'), 60),
        area: truncate(stripNoise(job.area || ''), 80),
        role: truncate(stripNoise(job.role || job.title), 120),
        summary,
        requirements: compactList(removeSalaryInfo(requirements), 420),
        salaryInfo,
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
    const rawScrapedText = JSON.stringify({
        title: job.title,
        company: job.company,
        location: job.location,
        area: job.area,
        role: job.role,
        summary: job.summary,
        requirements: job.requirements,
        salaryInfo: job.salaryInfo,
        applyInfo: job.applyInfo,
        sourceLabel: job.sourceLabel,
        url: job.url
    });

    return [
        {
            role: 'system',
            content: [
                'Voce analisa vagas de emprego para publicar em um grupo de WhatsApp.',
                'Responda somente JSON valido com as chaves:',
                'publish (boolean),',
                'reason (string curta),',
                'title, company, location, area, role, summary, requirements, salaryInfo, applyInfo,',
                'workType, technologies, seniority, shortDescription.',
                'Objetivo: enviar vagas de Porto Velho/RO em portugues claro, sem HTML, sem codigo, sem lixo visual.',
                'Regras:',
                '- Rejeite vagas em ingles, internacionais, europeias, claramente remotas ou sem relacao real com Porto Velho/RO.',
                '- Reescreva em portugues objetivo.',
                '- Summary: 1 a 2 frases curtas.',
                '- Requirements: itens principais em uma frase curta.',
                '- ApplyInfo: explique como se candidatar com base no texto; se nao houver detalhes, diga para acessar o link da vaga.',
                '- WorkType deve ser remoto, hibrido, presencial ou null.',
                '- Technologies deve ser array JSON de tecnologias principais ou array vazio.',
                '- Seniority deve ser junior, pleno, senior, estagio/aprendiz ou null.',
                '- ShortDescription deve ter no maximo 200 caracteres.',
                '- Nao invente dados ausentes.',
                '- Remova HTML, CSS, JS, nomes de classes, hashtags, rastros de codigo e termos quebrados.',
                '- Se houver texto confuso ou sujo, limpe antes de resumir.'
            ].join('\n')
        },
        {
            role: 'user',
            content: buildJobExtractionPrompt(rawScrapedText)
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
        area: truncate(stripNoise(result?.area || job.area || ''), 80),
        role: truncate(stripNoise(result?.role || job.role || job.title), 120),
        summary: truncate(stripNoise(result?.summary || job.summary), 420),
        requirements: compactList(removeSalaryInfo(result?.requirements || job.requirements), 420),
        salaryInfo: truncate(stripNoise(result?.salaryInfo || job.salaryInfo || extractSalaryInfo(job.requirements || '')), 120),
        applyInfo: truncate(stripNoise(result?.applyInfo || job.applyInfo || 'Acesse o link da vaga para se candidatar.'), 220),
        workType: normalizeSpace(result?.workType || result?.tipo_de_trabalho || ''),
        technologies: Array.isArray(result?.technologies)
            ? result.technologies.map((item) => truncate(stripNoise(item), 40)).filter(Boolean).slice(0, 8)
            : Array.isArray(result?.tecnologias_principais)
                ? result.tecnologias_principais.map((item) => truncate(stripNoise(item), 40)).filter(Boolean).slice(0, 8)
                : [],
        seniority: truncate(stripNoise(result?.seniority || result?.senioridade || ''), 40) || null,
        shortDescription: truncate(stripNoise(result?.shortDescription || result?.descricao_resumida || result?.summary || job.summary), 200),
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

export function buildStructuredJobExtractionPrompt(scrapedText) {
    return buildJobExtractionPrompt(scrapedText);
}

export function buildStructuredJobFilteringPrompt(jobs) {
    return buildJobFilteringPrompt(jobs);
}

export function buildStructuredJobCompatibilityPrompt(profile, job) {
    return buildJobCompatibilityPrompt(profile, job);
}

export async function evaluateJobCompatibility(job, profile = {}) {
    const startedAt = Date.now();
    const messages = [
        {
            role: 'system',
            content: [
                'Voce avalia compatibilidade entre perfil e vaga.',
                'Responda somente JSON valido com as chaves: score, motivo.',
                'Score deve ser inteiro de 0 a 100.',
                'Motivo deve ser uma frase curta.'
            ].join('\n')
        },
        {
            role: 'user',
            content: buildJobCompatibilityPrompt({
                area: profile.jobType || profile.area || 'geral',
                interesse: Array.isArray(profile.keywords) && profile.keywords.length
                    ? profile.keywords.join(', ')
                    : profile.jobType || 'geral',
                experiencia: profile.experiencePreference || profile.seniority || 'qualquer',
                nivel: profile.experiencePreference || profile.seniority || 'qualquer'
            }, {
                title: job?.title || '',
                company: job?.company || '',
                location: job?.location || '',
                workType: job?.workType || '',
                technologies: Array.isArray(job?.technologies) ? job.technologies : [],
                seniority: job?.seniority || '',
                summary: job?.summary || '',
                requirements: job?.requirements || '',
                url: job?.url || ''
            })
        }
    ];

    try {
        const result = GROQ_API_KEY
            ? await callGroqJson(messages)
            : openai
                ? await callOpenAiJson(messages)
                : null;

        if (!result || typeof result !== 'object') {
            return null;
        }

        const parsedScore = Number.parseInt(result.score ?? result.score_de_compatibilidade, 10);
        const score = Number.isFinite(parsedScore)
            ? Math.max(0, Math.min(100, parsedScore))
            : null;

        logger.debug('job_compatibility_analyzer', {
            provider: GROQ_API_KEY ? 'groq' : 'openai',
            ms: Date.now() - startedAt,
            score
        });

        return {
            score,
            motivo: normalizeSpace(result.motivo || result.motivo_da_classificacao || '')
        };
    } catch (error) {
        logger.warn('job_compatibility_analyzer_failed', {
            ms: Date.now() - startedAt,
            error: error?.message || String(error)
        });
        return null;
    }
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
