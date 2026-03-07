import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import cron from 'node-cron';

import { sendSafeMessage } from './messageHandler.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'job_forwarder_state.json');

const TARGET_GROUP = String(process.env.IMAVY_JOB_TARGET_GROUP || 'DESENVOLVIMENTO IA').trim();
const JOB_TIMEZONE = String(process.env.IMAVY_JOB_TIMEZONE || 'America/Porto_Velho').trim();
const JOB_CRON = String(process.env.IMAVY_JOB_CRON || '0 */3 * * *').trim();
const MAX_JOBS_PER_RUN = Math.max(1, Number.parseInt(process.env.IMAVY_JOB_MAX_PER_RUN || '3', 10) || 3);
const MAX_TRACKED_ITEMS = 2000;
const MAX_SUMMARY_LENGTH = 320;
const MAX_REQUIREMENTS_LENGTH = 320;

const SOURCES = [
    {
        id: 'sine_pvh',
        label: 'SINE Porto Velho',
        listUrl: 'https://www.portovelho.ro.gov.br/sine/vagas',
        async collect() {
            const html = await fetchHtml(this.listUrl);
            const cards = matchBlocks(html, /<div class="card">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi);
            const jobs = [];

            for (const card of cards) {
                const title = stripHtml(readFirst(card, /<h3>([\s\S]*?)<\/h3>/i));
                const experience = stripHtml(readFirst(card, /<p class="text-danger">([\s\S]*?)<\/p>/i));
                const paragraphs = Array.from(card.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
                    .map((match) => stripHtml(match[1]))
                    .filter(Boolean);
                const observation = stripHtml(readFirst(card, /<footer class="blockquote-footer">([\s\S]*?)<\/footer>/i));
                const applyPath = stripHtml(readFirst(card, /<a href="([^"]+)" class="btnEnviarCurr">Enviar curriculum<\/a>/i));
                const url = absoluteUrl(this.listUrl, applyPath);

                if (!title || !url) continue;

                const meta = paragraphs.filter((item) => item !== experience).join(' | ');
                const requirements = observation || meta;
                jobs.push({
                    sourceId: this.id,
                    sourceLabel: this.label,
                    title,
                    company: 'SINE Porto Velho',
                    location: 'Porto Velho/RO',
                    summary: meta || observation || 'Vaga publicada pelo SINE Porto Velho.',
                    requirements,
                    role: title,
                    applyInfo: `Encaminhamento pelo SINE Porto Velho: ${url}`,
                    url,
                    publishedAt: null
                });
            }

            return uniqueJobs(jobs).slice(0, 30);
        }
    },
    {
        id: 'rondoniaovivo',
        label: 'Rondônia ao Vivo Empregos',
        listUrl: 'https://empregos.rondoniaovivo.com/vagas/',
        async collect() {
            const html = await fetchHtml(this.listUrl);
            const links = extractUniqueLinks(html, this.listUrl)
                .filter((item) => /\/vaga\/[^/]+\/[^/]+\/\d+\/$/i.test(item.url));
            const jobs = [];

            for (const item of links.slice(0, 12)) {
                const detailHtml = await fetchHtml(item.url);
                const details = parseDefinitionList(detailHtml);
                const title = stripHtml(details['Função'] || item.label);
                const company = stripHtml(readMeta(detailHtml, 'og:title'))
                    .replace(/^Vaga para .*? - Empresa\s*/i, '')
                    .replace(/\s+-\s+Empregos[\s\S]*$/i, '')
                    .trim();
                const salary = stripHtml(details['Informações sobre o salário']);
                const summary = [
                    stripHtml(details['Detalhes de Vaga']),
                    stripHtml(details['Informações Adicionais']),
                    stripHtml(details['Horário de Trabalho'])
                ].filter(Boolean).join(' ');
                const applyInfo = `Candidate-se no portal Rondônia ao Vivo pelo link da vaga: ${item.url}`;

                if (!title) continue;

                jobs.push({
                    sourceId: this.id,
                    sourceLabel: this.label,
                    title,
                    company: company || 'Empresa anunciada no portal',
                    location: 'Porto Velho/RO',
                    summary: summary || 'Vaga publicada no portal Rondônia ao Vivo Empregos.',
                    requirements: [
                        stripHtml(details['Detalhes de Vaga']),
                        stripHtml(details['Nível de Escolaridade']),
                        salary ? `Salário e benefícios: ${salary}` : ''
                    ].filter(Boolean).join(' '),
                    role: title,
                    applyInfo,
                    url: item.url,
                    publishedAt: parseBrazilianDate(details['Cadastrado em'])
                });
            }

            return uniqueJobs(jobs);
        }
    },
    {
        id: 'melhores_empregos',
        label: 'Melhores Empregos',
        listUrl: 'https://www.melhoresempregos.com/vagas-em-porto-velho-ro/',
        async collect() {
            const html = await fetchHtml(this.listUrl);
            const baseHref = readFirst(html, /<base href="([^"]+)"/i) || this.listUrl;
            const links = extractUniqueLinks(html, baseHref)
                .filter((item) => /\/vaga\//i.test(item.url) && /porto-velho-ro/i.test(item.url));
            const jobs = [];

            for (const item of links.slice(0, 12)) {
                const detailHtml = await fetchHtml(item.url);
                const schema = readJobPostingSchema(detailHtml);
                const title = schema?.title || item.label;
                const description = stripHtml(schema?.description || '');
                const responsibilities = stripHtml(readSectionBlock(detailHtml, 'Responsabilidades', 'Requisitos'));
                const requirements = stripHtml(readSectionBlock(detailHtml, 'Requisitos', '</div></div></article>'));
                const salary = readMeta(detailHtml, 'description').match(/Salário de ([^.]+)\./i)?.[1] || '';
                const applyInfo = /Me candidatar à esta vaga/i.test(detailHtml)
                    ? `Candidatura no portal Melhores Empregos: ${item.url}`
                    : `Acesse a vaga para candidatura: ${item.url}`;

                if (!title) continue;

                jobs.push({
                    sourceId: this.id,
                    sourceLabel: this.label,
                    title: stripHtml(title),
                    company: 'Empresa anunciada no Melhores Empregos',
                    location: 'Porto Velho/RO',
                    summary: [description, responsibilities].filter(Boolean).join(' '),
                    requirements: [requirements, salary ? `Salário: ${salary}` : ''].filter(Boolean).join(' '),
                    role: stripHtml(title),
                    applyInfo,
                    url: item.url,
                    publishedAt: parseIsoDate(schema?.datePosted)
                });
            }

            return uniqueJobs(jobs);
        }
    },
    {
        id: 'bne',
        label: 'BNE',
        listUrl: 'https://www.bne.com.br/vagas-de-emprego-em-porto-velho-ro',
        async collect() {
            const html = await fetchHtml(this.listUrl);
            const links = extractUniqueLinks(html, this.listUrl)
                .filter((item) => /\/vaga-de-emprego-/i.test(item.url) && /porto-velho-ro/i.test(item.url));
            const jobs = [];

            for (const item of links.slice(0, 15)) {
                const detailHtml = await fetchHtml(item.url);
                const schema = readJobPostingSchema(detailHtml);
                if (!schema?.title) continue;

                const salary = schema?.baseSalary?.value
                    ? formatSalaryRange(schema.baseSalary.value.minValue, schema.baseSalary.value.maxValue)
                    : '';

                jobs.push({
                    sourceId: this.id,
                    sourceLabel: this.label,
                    title: stripHtml(schema.title),
                    company: stripHtml(schema?.hiringOrganization?.name || 'Empresa anunciada no BNE'),
                    location: `${stripHtml(schema?.jobLocation?.address?.addressLocality || 'Porto Velho')}/${stripHtml(schema?.jobLocation?.address?.addressRegion || 'RO')}`,
                    summary: stripHtml(schema?.description || ''),
                    requirements: [stripHtml(schema?.description || ''), salary ? `Faixa salarial: ${salary}` : ''].filter(Boolean).join(' '),
                    role: stripHtml(schema.title),
                    applyInfo: `Candidate-se pelo BNE no link da vaga: ${item.url}`,
                    url: item.url,
                    publishedAt: parseIsoDate(schema?.datePosted)
                });
            }

            return uniqueJobs(jobs);
        }
    }
];

let cronTask = null;
let pollingInFlight = false;

function normalizeSpace(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeGroupName(value) {
    return normalizeSpace(value).toLowerCase();
}

function decodeHtml(value) {
    const namedEntities = {
        agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
        egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
        igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
        ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
        ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
        ccedil: 'ç', ntilde: 'ñ',
        Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
        Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
        Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
        Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
        Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
        Ccedil: 'Ç', Ntilde: 'Ñ',
        ordm: 'º', ordf: 'ª', deg: '°', mdash: '-', ndash: '-', hellip: '...',
        rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '•'
    };

    return String(value || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&nbsp;/gi, ' ')
        .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => namedEntities[entity] ?? match)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function stripHtml(value) {
    return normalizeSpace(
        decodeHtml(String(value || ''))
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/li>/gi, '\n')
            .replace(/<li[^>]*>/gi, '- ')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
    );
}

function truncate(value, maxLen) {
    const text = normalizeSpace(value);
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 3).trim()}...`;
}

function matchBlocks(value, regex) {
    return Array.from(String(value || '').matchAll(regex)).map((match) => match[1]).filter(Boolean);
}

function readFirst(value, regex) {
    const match = String(value || '').match(regex);
    return match ? match[1] : '';
}

function readMeta(html, property) {
    return decodeHtml(readFirst(html, new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["']`, 'i')));
}

function absoluteUrl(baseUrl, rawUrl) {
    const safe = String(rawUrl || '').trim();
    if (!safe) return '';
    try {
        return new URL(safe, baseUrl).toString();
    } catch (_) {
        return '';
    }
}

function extractUniqueLinks(html, baseUrl) {
    const seen = new Set();
    const result = [];
    for (const match of String(html || '').matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const url = absoluteUrl(baseUrl, decodeHtml(match[1]));
        const label = stripHtml(match[2]);
        if (!url || !label || seen.has(url)) continue;
        seen.add(url);
        result.push({ url, label });
    }
    return result;
}

function parseDefinitionList(html) {
    const result = {};
    const regex = /<dt[^>]*>\s*(?:<strong>)?([\s\S]*?)(?:<\/strong>)?\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
    for (const match of html.matchAll(regex)) {
        const key = stripHtml(match[1]);
        const value = stripHtml(match[2]);
        if (key) result[key] = value;
    }
    return result;
}

function readSectionBlock(html, startLabel, endMarker) {
    const startIdx = String(html || '').indexOf(startLabel);
    if (startIdx < 0) return '';
    const tail = String(html || '').slice(startIdx + startLabel.length);
    let raw = tail;
    if (endMarker.startsWith('</')) {
        const endIdx = tail.indexOf(endMarker);
        raw = endIdx >= 0 ? tail.slice(0, endIdx) : tail;
    } else {
        const endIdx = tail.indexOf(endMarker);
        raw = endIdx >= 0 ? tail.slice(0, endIdx) : tail;
    }
    return raw;
}

function readJobPostingSchema(html) {
    for (const match of String(html || '').matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/gi)) {
        try {
            const parsed = JSON.parse(decodeHtml(match[1]));
            if (parsed?.['@type'] === 'JobPosting') return parsed;
        } catch (_) {
            continue;
        }
    }
    return null;
}

function parseIsoDate(value) {
    const safe = String(value || '').trim();
    if (!safe) return null;
    const timestamp = Date.parse(safe);
    return Number.isNaN(timestamp) ? null : timestamp;
}

function parseBrazilianDate(value) {
    const safe = String(value || '').trim();
    const match = safe.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return null;
    const [, dd, mm, yyyy] = match;
    const timestamp = Date.parse(`${yyyy}-${mm}-${dd}T00:00:00-04:00`);
    return Number.isNaN(timestamp) ? null : timestamp;
}

function formatSalaryRange(minValue, maxValue) {
    const min = Number(minValue);
    const max = Number(maxValue);
    if (Number.isFinite(min) && Number.isFinite(max)) {
        return `R$ ${min.toFixed(2)} a R$ ${max.toFixed(2)}`.replace(/\./g, ',');
    }
    if (Number.isFinite(min)) {
        return `A partir de R$ ${min.toFixed(2)}`.replace(/\./g, ',');
    }
    return '';
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeUrl(value) {
    const safe = String(value || '').trim();
    if (!safe) return '';
    try {
        const parsed = new URL(safe);
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return safe;
    }
}

function jobFingerprint(job) {
    return [
        normalizeSpace(job?.title).toLowerCase(),
        normalizeSpace(job?.company).toLowerCase(),
        normalizeSpace(job?.location).toLowerCase()
    ].join('|');
}

function uniqueJobs(jobs) {
    const seen = new Set();
    return (Array.isArray(jobs) ? jobs : []).filter((job) => {
        const key = `${normalizeUrl(job?.url)}|${jobFingerprint(job)}`;
        if (!job?.url || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function getDefaultState() {
    return {
        initialized: false,
        seenUrls: [],
        seenFingerprints: [],
        lastRunAt: null
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return getDefaultState();
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            initialized: parsed?.initialized === true,
            seenUrls: Array.isArray(parsed?.seenUrls) ? parsed.seenUrls : [],
            seenFingerprints: Array.isArray(parsed?.seenFingerprints) ? parsed.seenFingerprints : [],
            lastRunAt: parsed?.lastRunAt || null
        };
    } catch (_) {
        return getDefaultState();
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        initialized: state?.initialized === true,
        seenUrls: Array.isArray(state?.seenUrls) ? state.seenUrls.slice(-MAX_TRACKED_ITEMS) : [],
        seenFingerprints: Array.isArray(state?.seenFingerprints) ? state.seenFingerprints.slice(-MAX_TRACKED_ITEMS) : [],
        lastRunAt: state?.lastRunAt || null
    }, null, 2), 'utf8');
}

async function fetchHtml(url) {
    const response = await fetch(url, {
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; iMavyBot/1.0; +https://github.com/fjprojectsdev/jh)'
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} em ${url}`);
    }
    return response.text();
}

function resolveTargetGroup(groups) {
    const byName = normalizeGroupName(TARGET_GROUP);
    for (const [id, group] of Object.entries(groups || {})) {
        if (normalizeGroupName(group?.subject) === byName) {
            return { id, subject: String(group?.subject || id).trim() || id };
        }
    }
    return null;
}

function buildJobPayload(job) {
    const lines = [
        `💼 *${job.title}*`,
        job.company ? `🏢 Empresa: ${job.company}` : '',
        job.location ? `📍 Local: ${job.location}` : '',
        `🧭 Fonte: ${job.sourceLabel}`,
        job.role ? `📌 Funcao: ${truncate(job.role, 120)}` : '',
        job.summary ? `📝 Resumo: ${truncate(job.summary, MAX_SUMMARY_LENGTH)}` : '',
        job.requirements ? `✅ Requisitos: ${truncate(job.requirements, MAX_REQUIREMENTS_LENGTH)}` : '',
        job.applyInfo ? `📨 Como se candidatar: ${truncate(job.applyInfo, 260)}` : '',
        `🔗 ${job.url}`
    ].filter(Boolean);

    return { text: lines.join('\n') };
}

async function collectJobs() {
    const jobs = [];
    for (const source of SOURCES) {
        try {
            const sourceJobs = await source.collect();
            jobs.push(...sourceJobs);
        } catch (error) {
            logger.error('job_forwarder_source_failed', {
                source: source.label,
                error: error?.message || String(error)
            });
        }
    }

    return uniqueJobs(jobs).sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0));
}

function mergeStateEntries(current = [], extra = []) {
    return Array.from(new Set([...(Array.isArray(current) ? current : []), ...(Array.isArray(extra) ? extra : [])]))
        .slice(-MAX_TRACKED_ITEMS);
}

async function pollJobs(sock) {
    if (pollingInFlight) return;
    pollingInFlight = true;

    try {
        const groups = await sock.groupFetchAllParticipating();
        const targetGroup = resolveTargetGroup(groups);
        if (!targetGroup) {
            logger.warn('job_forwarder_group_not_found', { targetGroup: TARGET_GROUP });
            return;
        }

        const state = loadState();
        const jobs = await collectJobs();
        const urlsSnapshot = jobs.map((job) => normalizeUrl(job.url));
        const fingerprintSnapshot = jobs.map((job) => jobFingerprint(job));

        if (!state.initialized) {
            state.initialized = true;
            state.seenUrls = mergeStateEntries(state.seenUrls, urlsSnapshot);
            state.seenFingerprints = mergeStateEntries(state.seenFingerprints, fingerprintSnapshot);
            state.lastRunAt = new Date().toISOString();
            saveState(state);
            logger.info('job_forwarder_initialized', {
                targetGroup: targetGroup.subject,
                trackedJobs: jobs.length
            });
            return;
        }

        const seenUrls = new Set(state.seenUrls || []);
        const seenFingerprints = new Set(state.seenFingerprints || []);
        const freshJobs = jobs.filter((job) => {
            const url = normalizeUrl(job.url);
            const fingerprint = jobFingerprint(job);
            return !seenUrls.has(url) && !seenFingerprints.has(fingerprint);
        });

        if (freshJobs.length === 0) {
            state.seenUrls = mergeStateEntries(state.seenUrls, urlsSnapshot);
            state.seenFingerprints = mergeStateEntries(state.seenFingerprints, fingerprintSnapshot);
            state.lastRunAt = new Date().toISOString();
            saveState(state);
            return;
        }

        const jobsToSend = freshJobs.slice(0, MAX_JOBS_PER_RUN);
        for (const job of jobsToSend) {
            const sent = await sendSafeMessage(sock, targetGroup.id, buildJobPayload(job));
            if (sent) {
                logger.info('job_forwarder_sent', {
                    group: targetGroup.subject,
                    source: job.sourceLabel,
                    title: job.title,
                    url: job.url
                });
            }
            await new Promise((resolve) => setTimeout(resolve, 1200));
        }

        state.initialized = true;
        state.seenUrls = mergeStateEntries(state.seenUrls, [...urlsSnapshot, ...freshJobs.map((job) => normalizeUrl(job.url))]);
        state.seenFingerprints = mergeStateEntries(state.seenFingerprints, [...fingerprintSnapshot, ...freshJobs.map((job) => jobFingerprint(job))]);
        state.lastRunAt = new Date().toISOString();
        saveState(state);
    } catch (error) {
        logger.error('job_forwarder_poll_failed', {
            error: error?.message || String(error)
        });
    } finally {
        pollingInFlight = false;
    }
}

export async function startJobForwarder(sock) {
    if (cronTask) return;

    logger.info('job_forwarder_started', {
        cron: JOB_CRON,
        timezone: JOB_TIMEZONE,
        maxJobsPerRun: MAX_JOBS_PER_RUN,
        sources: SOURCES.map((source) => source.label)
    });

    await pollJobs(sock);

    cronTask = cron.schedule(JOB_CRON, () => {
        pollJobs(sock).catch((error) => {
            logger.error('job_forwarder_schedule_failed', {
                error: error?.message || String(error)
            });
        });
    }, {
        timezone: JOB_TIMEZONE
    });
}

export function stopJobForwarder() {
    if (!cronTask) return;
    cronTask.stop();
    cronTask = null;
}

export async function runJobForwarderNow(sock) {
    await pollJobs(sock);
}
