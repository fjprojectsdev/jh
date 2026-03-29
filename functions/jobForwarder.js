import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import cron from 'node-cron';

import { sendSafeMessage } from './messageHandler.js';
import { analyzeJobForPublishing } from './jobAnalyzer.js';
import { collectJobChannelJobs } from './jobChannelSource.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'job_forwarder_config.json');
const STATE_FILE = path.join(__dirname, '..', 'job_forwarder_state.json');
const INSTAGRAM_CACHE_FILE = path.join(__dirname, '..', 'job_forwarder_instagram_cache.json');
const NEWSLETTER_CACHE_TTL_MS = Math.max(5 * 60 * 1000, Number.parseInt(process.env.IMAVY_JOB_NEWSLETTER_CACHE_TTL_MS || String(60 * 60 * 1000), 10) || (60 * 60 * 1000));

const TARGET_GROUPS = Array.from(new Set(
    String(process.env.IMAVY_JOB_TARGET_GROUPS || process.env.IMAVY_JOB_TARGET_GROUP || 'DESENVOLVIMENTO IA,EMPREGOS PVH 2.0,EMPREGOS PVH')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
));
const JOB_CHANNEL_JIDS = Array.from(new Set(
    String(process.env.IMAVY_JOB_CHANNEL_JIDS || process.env.IMAVY_JOB_CHANNEL_JID || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
));
const JOB_CHANNEL_INVITE_CODES = Array.from(new Set(
    String(process.env.IMAVY_JOB_CHANNEL_INVITE_CODES || process.env.IMAVY_JOB_CHANNEL_INVITE_CODE || '')
        .split(',')
        .map((item) => normalizeNewsletterInviteCode(item))
        .filter(Boolean)
));
const EMPREGOS_PVH_API_URL = String(process.env.IMAVY_EMPREGOSPVH_API_URL || 'https://api.empregospvh.com.br').trim().replace(/\/+$/, '');
const EMPREGOS_PVH_INGESTION_TOKEN = String(process.env.IMAVY_EMPREGOSPVH_INGESTION_TOKEN || '').trim();
const EMPREGOS_PVH_AUTO_POST = String(process.env.IMAVY_EMPREGOSPVH_AUTO_POST || 'true').trim().toLowerCase() !== 'false';
const JOB_DISABLE_GROUPS = String(process.env.IMAVY_JOB_DISABLE_GROUPS || 'false').trim().toLowerCase() === 'true';
const JOB_TIMEZONE = String(process.env.IMAVY_JOB_TIMEZONE || 'America/Porto_Velho').trim();
const JOB_CRON = String(process.env.IMAVY_JOB_CRON || '0 */3 * * *').trim();
const MAX_JOBS_PER_RUN = Math.max(1, Number.parseInt(process.env.IMAVY_JOB_MAX_PER_RUN || '3', 10) || 3);
const JOB_DELAY_BETWEEN_POSTS_MS = Math.max(1000, Number.parseInt(process.env.IMAVY_JOB_DELAY_BETWEEN_POSTS_MS || '60000', 10) || 60000);
const MAX_TRACKED_ITEMS = 2000;
const MAX_SUMMARY_LENGTH = 320;
const MAX_REQUIREMENTS_LENGTH = 320;
const OLX_RESULT_LIMIT = Math.max(1, Number.parseInt(process.env.IMAVY_JOB_OLX_RESULT_LIMIT || '8', 10) || 8);
const SEARCH_SOURCE_RESULT_LIMIT = Math.max(1, Number.parseInt(process.env.IMAVY_JOB_SEARCH_SOURCE_RESULT_LIMIT || '6', 10) || 6);
const MARIANA_RESULT_LIMIT = Math.max(1, Number.parseInt(process.env.IMAVY_JOB_MARIANA_RESULT_LIMIT || '12', 10) || 12);
const OLX_SEARCH_QUERIES = Array.from(new Set(
    String(process.env.IMAVY_JOB_OLX_SEARCH_QUERIES || 'site:ro.olx.com.br/rondonia/vagas-de-emprego \"Porto Velho\"')
        .split('||')
        .map((item) => item.trim())
        .filter(Boolean)
));
const GERACAO_EMPREGO_API_URL = String(process.env.IMAVY_JOB_GERACAO_API_URL || 'https://api.geracaoemprego.ro.gov.br').trim().replace(/\/+$/, '');
const MARIANA_BASE_URL = String(process.env.IMAVY_JOB_MARIANA_BASE_URL || 'https://vagas2.marianagoedert.com.br').trim().replace(/\/+$/, '');
const INSTAGRAM_APP_ID = String(process.env.IMAVY_JOB_INSTAGRAM_APP_ID || '936619743392459').trim();
const INSTAGRAM_PUBLIC_PROFILES = Array.from(new Set(
    String(process.env.IMAVY_JOB_INSTAGRAM_PROFILES || 'empregos_portovelho,vagaspvh,empregospvh,vagasrondonia,empregosrondonia,sinerondoniaoficial,institutochance')
        .split(',')
        .map((item) => item.trim().replace(/^@+/, '').toLowerCase())
        .filter(Boolean)
));
const INSTAGRAM_RETRY_AFTER_401_MS = 24 * 60 * 60 * 1000;
const INSTAGRAM_RETRY_AFTER_429_MS = 3 * 60 * 60 * 1000;
const INSTAGRAM_CACHE_WARN_INTERVAL_MS = Math.max(15 * 60 * 1000, Number.parseInt(process.env.IMAVY_JOB_INSTAGRAM_CACHE_WARN_INTERVAL_MS || String(3 * 60 * 60 * 1000), 10) || (3 * 60 * 60 * 1000));
const BRAVE_RETRY_AFTER_429_MS = Math.max(15 * 60 * 1000, Number.parseInt(process.env.IMAVY_JOB_BRAVE_RETRY_AFTER_429_MS || String(3 * 60 * 60 * 1000), 10) || (3 * 60 * 60 * 1000));
const SOURCE_FAILURE_COOLDOWN_MS = Math.max(10 * 60 * 1000, Number.parseInt(process.env.IMAVY_JOB_SOURCE_FAILURE_COOLDOWN_MS || String(45 * 60 * 1000), 10) || (45 * 60 * 1000));
const WEB_SEARCH_SOURCES = [
    {
        id: 'empregos_com_br',
        label: 'Empregos.com.br Porto Velho',
        listUrl: 'https://www.empregos.com.br/vagas/em-porto-velho-ro',
        sitePattern: /(?:^|\.)empregos\.com\.br$/i,
        company: 'Empresa anunciada no Empregos.com.br',
        applyInfoPrefix: 'Candidate-se no Empregos.com.br'
    },
    {
        id: 'catho_pvh',
        label: 'Catho Porto Velho',
        listUrl: 'https://www.catho.com.br/vagas/ro/porto-velho/',
        sitePattern: /(?:^|\.)catho\.com\.br$/i,
        company: 'Empresa anunciada na Catho',
        applyInfoPrefix: 'Candidate-se na Catho'
    },
    {
        id: 'infojobs_pvh',
        label: 'InfoJobs Porto Velho',
        listUrl: 'https://www.infojobs.com.br/empregos-em-porto-velho%2C-ro.aspx',
        sitePattern: /(?:^|\.)infojobs\.com\.br$/i,
        company: 'Empresa anunciada no InfoJobs',
        applyInfoPrefix: 'Candidate-se no InfoJobs'
    },
    {
        id: 'indeed_pvh',
        label: 'Indeed Porto Velho',
        listUrl: 'https://br.indeed.com/empregos-de-Trabalho-em-Porto-Velho%2C-RO',
        sitePattern: /(?:^|\.)indeed\.com(?:\.[a-z.]+)?$/i,
        company: 'Empresa anunciada no Indeed',
        applyInfoPrefix: 'Candidate-se no Indeed'
    },
    {
        id: 'glassdoor_pvh',
        label: 'Glassdoor Porto Velho',
        listUrl: 'https://www.glassdoor.com.br/Vaga/porto-velho-vagas-SRCH_IL.0,11_IC2421750.htm',
        sitePattern: /(?:^|\.)glassdoor\.com\.br$/i,
        company: 'Empresa anunciada no Glassdoor',
        applyInfoPrefix: 'Candidate-se no Glassdoor'
    },
    {
        id: 'trabalha_brasil_pvh',
        label: 'Trabalha Brasil Porto Velho',
        listUrl: 'https://www.trabalhabrasil.com.br/vagas-de-emprego-em-porto-velho-ro',
        sitePattern: /(?:^|\.)trabalhabrasil\.com\.br$/i,
        company: 'Empresa anunciada no Trabalha Brasil',
        applyInfoPrefix: 'Candidate-se no Trabalha Brasil'
    },
    {
        id: 'solides_pvh',
        label: 'Solides Porto Velho',
        listUrl: 'https://vagas.solides.com.br/vagas/porto-velho-ro',
        sitePattern: /(?:^|\.)solides\.com\.br$/i,
        company: 'Empresa anunciada na Solides',
        applyInfoPrefix: 'Candidate-se pela Solides'
    },
    {
        id: 'solides_eucatur',
        label: 'Eucatur Solides',
        listUrl: 'https://eucatur.vagas.solides.com.br/',
        sitePattern: /(?:^|\.)solides\.com\.br$/i,
        company: 'Eucatur',
        applyInfoPrefix: 'Candidate-se pela Solides da Eucatur'
    },
    {
        id: 'gupy_energisa',
        label: 'Grupo Energisa Gupy',
        listUrl: 'https://grupoenergisa.gupy.io/',
        sitePattern: /(?:^|\.)gupy\.io$/i,
        company: 'Grupo Energisa',
        applyInfoPrefix: 'Candidate-se pela Gupy da Energisa'
    },
    {
        id: 'energisa_carreiras',
        label: 'Energisa Carreiras',
        listUrl: 'https://www.energisa.com.br/carreiras/carreiras',
        sitePattern: /(?:^|\.)energisa\.com\.br$/i,
        company: 'Energisa',
        applyInfoPrefix: 'Candidate-se pela pagina de carreiras da Energisa'
    },
    {
        id: 'gupy_jirau',
        label: 'Jirau Energia Gupy',
        listUrl: 'https://jirauenergia.gupy.io/',
        sitePattern: /(?:^|\.)gupy\.io$/i,
        company: 'Jirau Energia',
        applyInfoPrefix: 'Candidate-se pela Gupy da Jirau Energia'
    },
    {
        id: 'adzuna_pvh',
        label: 'Adzuna Porto Velho',
        listUrl: 'https://www.adzuna.com.br/porto-velho/publicado',
        sitePattern: /(?:^|\.)adzuna\.com\.br$/i,
        company: 'Empresa anunciada no Adzuna',
        applyInfoPrefix: 'Candidate-se no Adzuna'
    },
    {
        id: 'jooble_pvh',
        label: 'Jooble Porto Velho',
        listUrl: 'https://br.jooble.org/vagas-de-emprego/Porto-Velho%2C-RO',
        sitePattern: /(?:^|\.)jooble\.org$/i,
        company: 'Empresa anunciada no Jooble',
        applyInfoPrefix: 'Candidate-se no Jooble'
    }
];

const SOURCES = [
    {
        id: 'job_channels_cache',
        label: 'Canais de vagas do WhatsApp',
        listUrl: 'whatsapp://newsletter/jobs',
        async collect() {
            return collectJobChannelJobs();
        }
    },
    {
        id: 'geracao_emprego',
        label: 'Geracao Emprego RO',
        listUrl: 'https://geracaoemprego.ro.gov.br/vagas-de-emprego?order_by=newest&application=geracaoemprego&page=1',
        async collect() {
            return collectGeracaoEmpregoJobs();
        }
    },
    {
        id: 'mariana_goedert',
        label: 'Mariana Goedert',
        listUrl: 'https://vagas2.marianagoedert.com.br/index.php?class=VagasListPublica&method=onReload',
        async collect() {
            return collectMarianaGoedertJobs();
        }
    },
    {
        id: 'olx_porto_velho',
        label: 'OLX Porto Velho',
        listUrl: 'https://www.olx.com.br/vagas-de-emprego/estado-ro/rondonia/porto-velho',
        async collect() {
            return collectOlxJobsViaSearch();
        }
    },
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
                    area: '',
                    summary: meta || observation || 'Vaga publicada pelo SINE Porto Velho.',
                    requirements,
                    salaryInfo: '',
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
                    area: stripHtml(details['Área de atuação'] || details['Area de atuacao'] || ''),
                    summary: summary || 'Vaga publicada no portal Rondônia ao Vivo Empregos.',
                    requirements: [
                        stripHtml(details['Detalhes de Vaga']),
                        stripHtml(details['Nível de Escolaridade'])
                    ].filter(Boolean).join(' '),
                    salaryInfo: salary,
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
                    area: '',
                    summary: [description, responsibilities].filter(Boolean).join(' '),
                    requirements,
                    salaryInfo: salary,
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
                    area: stripHtml(schema?.occupationalCategory || ''),
                    summary: stripHtml(schema?.description || ''),
                    requirements: stripHtml(schema?.description || ''),
                    salaryInfo: salary,
                    role: stripHtml(schema.title),
                    applyInfo: `Candidate-se pelo BNE no link da vaga: ${item.url}`,
                    url: item.url,
                    publishedAt: parseIsoDate(schema?.datePosted)
                });
            }

            return uniqueJobs(jobs);
        }
    },
    {
        id: 'linkedin_pvh',
        label: 'LinkedIn Porto Velho',
        listUrl: 'https://www.linkedin.com/jobs/search/?keywords=Porto%20Velho&location=Porto%20Velho%2C%20Rond%C3%B4nia%2C%20Brasil&geoId=103523495',
        async collect() {
            const html = await fetchHtml(this.listUrl);
            const cardBlocks = matchBlocks(
                html,
                /(<div class="base-card[\s\S]*?job-search-card"[\s\S]*?<\/li>)/gi
            );
            const jobs = [];

            for (const block of cardBlocks.slice(0, 12)) {
                const href = decodeHtml(readFirst(block, /<a[^>]+class="base-card__full-link[^"]*"[^>]+href="([^"]+)"/i));
                const title = stripHtml(readFirst(block, /<h3 class="base-search-card__title">([\s\S]*?)<\/h3>/i));
                const company = stripHtml(readFirst(block, /<h4 class="base-search-card__subtitle">([\s\S]*?)<\/h4>/i));
                const location = stripHtml(readFirst(block, /<span class="job-search-card__location">([\s\S]*?)<\/span>/i));
                const datetime = stripHtml(readFirst(block, /<time class="job-search-card__listdate(?:--new)?" datetime="([^"]+)"/i));
                const url = canonicalizeLinkedInJobUrl(href);

                if (!url || !title || !/porto velho/i.test(location)) continue;

                let detailHtml = '';
                let schema = null;
                try {
                    detailHtml = await fetchHtml(url);
                    schema = readJobPostingSchema(detailHtml);
                } catch (_) {
                    detailHtml = '';
                    schema = null;
                }

                const summary = stripHtml(schema?.description || readMeta(detailHtml, 'description') || '');
                const applyUrl = decodeHtml(readFirst(detailHtml, /<code id="applyUrl"[^>]*><!--"([^"]+)"/i));
                const requirements = summary;
                const salary = schema?.baseSalary?.value
                    ? formatSalaryRange(schema.baseSalary.value.minValue, schema.baseSalary.value.maxValue)
                    : '';

                jobs.push({
                    sourceId: this.id,
                    sourceLabel: this.label,
                    title: stripHtml(schema?.title || title),
                    company: stripHtml(schema?.hiringOrganization?.name || company || 'Empresa anunciada no LinkedIn'),
                    location: formatLinkedInLocation(stripHtml(schema?.jobLocation?.address?.addressLocality || location), stripHtml(schema?.jobLocation?.address?.addressRegion || 'RO')),
                    area: '',
                    summary: summary || 'Vaga publicada no LinkedIn.',
                    requirements,
                    salaryInfo: salary,
                    role: stripHtml(schema?.title || title),
                    applyInfo: applyUrl ? `Candidate-se no LinkedIn ou no link externo da vaga: ${applyUrl}` : `Candidate-se pela vaga no LinkedIn: ${url}`,
                    url,
                    publishedAt: parseIsoDate(schema?.datePosted || datetime)
                });
            }

            return uniqueJobs(jobs);
        }
    },
    ...WEB_SEARCH_SOURCES.map((source) => ({
        id: source.id,
        label: source.label,
        listUrl: source.listUrl,
        async collect() {
            return collectGenericSearchJobs(source);
        }
    })),
    ...INSTAGRAM_PUBLIC_PROFILES.map((username) => ({
        id: `instagram_${username}`,
        label: `Instagram @${username}`,
        listUrl: `https://www.instagram.com/${username}/`,
        async collect() {
            return collectInstagramProfileJobs(username);
        }
    }))
];

let cronTask = null;
let pollingInFlight = false;
const newsletterTargetCache = new Map();

function getDefaultConfig() {
    return {
        enabled: true
    };
}

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            const config = getDefaultConfig();
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
            return config;
        }
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return {
            enabled: parsed?.enabled !== false
        };
    } catch (_) {
        return getDefaultConfig();
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        enabled: config?.enabled !== false
    }, null, 2), 'utf8');
}

function normalizeSpace(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeGroupName(value) {
    return normalizeSpace(value).toLowerCase();
}

function decodeDuckDuckGoResultUrl(value) {
    const safe = decodeHtml(String(value || '').trim());
    if (!safe) return '';

    const absolute = safe.startsWith('//') ? `https:${safe}` : safe;
    try {
        const parsed = new URL(absolute);
        if (/duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/l/')) {
            return decodeURIComponent(parsed.searchParams.get('uddg') || '').trim();
        }
        return parsed.toString();
    } catch (_) {
        return '';
    }
}

function normalizeOlxTitle(value) {
    return cleanLine(
        String(value || '')
            .replace(/\s*-\s*olx\b.*$/i, '')
            .replace(/\s*\|\s*olx\b.*$/i, ''),
        110
    );
}

function cleanOlxTitle(value) {
    return cleanLine(
        normalizeOlxTitle(value)
            .replace(/\s+\d{7,}\s*$/g, '')
            .replace(/\s+\.\.\.\s*$/g, '')
            .replace(/\s{2,}/g, ' '),
        110
    );
}

function cleanOlxSnippet(value) {
    return cleanLine(
        String(value || '')
            .replace(/\bInforma(?:ções|coes) verificadas\b[\s\S]*$/i, '')
            .replace(/\bpublicidade\b[\s\S]*$/i, '')
            .replace(/\bDicas de segurança\b[\s\S]*$/i, '')
            .replace(/\bFechar janela de diálogo\b[\s\S]*$/i, '')
            .replace(/\s+·\s+/g, ', ')
            .replace(/\s{2,}/g, ' '),
        420
    );
}

function looksLikeOlxJobUrl(value) {
    return /https?:\/\/(?:[a-z]{2}\.)?olx\.com\.br\/rondonia\/vagas-de-emprego\//i.test(String(value || ''));
}

function extractDuckDuckGoResults(html) {
    const blocks = matchBlocks(String(html || ''), /<div class="result results_links(?![^"]*result--ad)[\s\S]*?<div class="clear"><\/div>\s*<\/div>/gi);
    const results = [];

    for (const block of blocks) {
        const href = decodeDuckDuckGoResultUrl(readFirst(block, /<a[^>]+class="result__a"[^>]+href="([^"]+)"/i));
        const title = cleanOlxTitle(stripHtml(readFirst(block, /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i)));
        const snippet = cleanOlxSnippet(stripHtml(
            readFirst(block, /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
            || readFirst(block, /<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
        ));

        if (!looksLikeOlxJobUrl(href) || !title) continue;
        results.push({ href, title, snippet });
    }

    return results;
}

function extractDuckDuckGoGenericResults(html) {
    const blocks = matchBlocks(String(html || ''), /<div class="result results_links(?![^"]*result--ad)[\s\S]*?<div class="clear"><\/div>\s*<\/div>/gi);
    const results = [];

    for (const block of blocks) {
        const href = decodeDuckDuckGoResultUrl(readFirst(block, /<a[^>]+class="result__a"[^>]+href="([^"]+)"/i));
        const title = cleanLine(stripHtml(readFirst(block, /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i)), 110);
        const snippet = cleanLine(stripHtml(
            readFirst(block, /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
            || readFirst(block, /<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
        ), 420);

        if (!href || !title) continue;
        results.push({ href, title, snippet });
    }

    return results;
}

function extractBraveOlxResults(html) {
    const parts = String(html || '').split('<div class="snippet');
    const results = [];

    for (const part of parts) {
        if (!part.includes('data-type="web"')) continue;
        const block = `<div class="snippet${part}`;
        const href = decodeHtml(readFirst(block, /<a href="(https:\/\/ro\.olx\.com\.br\/rondonia\/vagas-de-emprego\/[^"]+)"/i));
        const title = cleanOlxTitle(
            decodeHtml(readFirst(block, /<div class="title [^"]*" title="([^"]+)"/i))
            || stripHtml(readFirst(block, /<div class="title [^"]*">([\s\S]*?)<\/div><\/a>/i))
        );
        const snippet = cleanOlxSnippet(stripHtml(
            readFirst(block, /<div class="generic-snippet[^"]*"><div class="content [^"]*">([\s\S]*?)<\/div>/i)
        ));
        const dateLabel = normalizeSpace(stripHtml(readFirst(block, /<span class="t-secondary">([\s\S]*?)<\/span>/i))).replace(/\s*-\s*$/, '');

        if (!looksLikeOlxJobUrl(href) || !title) continue;
        results.push({
            href,
            title,
            snippet,
            publishedAt: parseSearchEngineDate(dateLabel)
        });
    }

    return results;
}

function extractBraveGenericResults(html) {
    const parts = String(html || '').split('<div class="snippet');
    const results = [];

    for (const part of parts) {
        if (!part.includes('data-type="web"')) continue;
        const block = `<div class="snippet${part}`;
        const href = decodeHtml(readFirst(block, /<a href="(https?:\/\/[^"]+)"/i));
        const title = cleanLine(
            decodeHtml(readFirst(block, /<div class="title [^"]*" title="([^"]+)"/i))
            || stripHtml(readFirst(block, /<div class="title [^"]*">([\s\S]*?)<\/div><\/a>/i)),
            110
        );
        const snippet = cleanLine(stripHtml(
            readFirst(block, /<div class="generic-snippet[^"]*"><div class="content [^"]*">([\s\S]*?)<\/div>/i)
        ), 420);
        const dateLabel = normalizeSpace(stripHtml(readFirst(block, /<span class="t-secondary">([\s\S]*?)<\/span>/i))).replace(/\s*-\s*$/, '');

        if (!href || !title) continue;
        results.push({
            href,
            title,
            snippet,
            publishedAt: parseSearchEngineDate(dateLabel)
        });
    }

    return results;
}

function parseSearchEngineDate(value) {
    const safe = normalizeSpace(value).toLowerCase();
    if (!safe) return null;

    const months = {
        january: '01',
        february: '02',
        march: '03',
        april: '04',
        may: '05',
        june: '06',
        july: '07',
        august: '08',
        september: '09',
        october: '10',
        november: '11',
        december: '12'
    };

    const match = safe.match(/([a-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
    if (!match) return null;
    const [, monthName, day, year] = match;
    const month = months[monthName];
    if (!month) return null;
    return parseIsoDate(`${year}-${month}-${String(day).padStart(2, '0')}T00:00:00-04:00`);
}

async function fetchBraveSearchHtml(query) {
    const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
    return fetchHtml(searchUrl, {
        accept: 'text/html,application/xhtml+xml'
    });
}

async function fetchDuckDuckGoSearchHtml(query) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=br-pt&kp=-2`;
    return fetchHtml(searchUrl, {
        referer: 'https://duckduckgo.com/'
    });
}

async function collectOlxJobsViaSearch() {
    const jobs = [];
    const state = loadState();
    const braveBlockedUntilTs = state?.braveSearchBlockedUntil ? Date.parse(state.braveSearchBlockedUntil) : NaN;
    const braveBlocked = Number.isFinite(braveBlockedUntilTs) && braveBlockedUntilTs > Date.now();

    for (const query of OLX_SEARCH_QUERIES) {
        let results = [];
        if (!braveBlocked) {
            try {
                results = extractBraveOlxResults(await fetchBraveSearchHtml(query));
            } catch (error) {
                const message = error?.message || String(error);
                if (/HTTP 429\b/i.test(message)) {
                    state.braveSearchBlockedUntil = new Date(Date.now() + BRAVE_RETRY_AFTER_429_MS).toISOString();
                    saveState(state);
                    logger.warn('job_forwarder_olx_brave_rate_limited', {
                        query,
                        error: message,
                        retryAfterMs: BRAVE_RETRY_AFTER_429_MS
                    });
                } else {
                    logger.warn('job_forwarder_olx_brave_failed', {
                        query,
                        error: message
                    });
                }
            }
        }

        if (results.length === 0) {
            try {
                results = extractDuckDuckGoResults(await fetchDuckDuckGoSearchHtml(query));
            } catch (error) {
                logger.warn('job_forwarder_olx_search_failed', {
                    query,
                    error: error?.message || String(error)
                });
            }
        }

        for (const result of results.slice(0, OLX_RESULT_LIMIT)) {
            const combinedText = normalizeSpace([result.title, result.snippet].join(' '));
            if (!combinedText) continue;
            if (/\b(aluguel|imoveis|veiculos|moto|carro|casa)\b/i.test(combinedText)) continue;

            jobs.push({
                sourceId: 'olx_porto_velho',
                sourceLabel: 'OLX Porto Velho',
                title: result.title,
                company: 'Anunciante da OLX',
                location: 'Porto Velho/RO',
                area: '',
                summary: result.snippet || 'Vaga encontrada na OLX para Porto Velho/RO.',
                requirements: result.snippet || result.title,
                salaryInfo: '',
                role: result.title,
                applyInfo: `Entre em contato pelo anuncio da OLX: ${result.href}`,
                url: result.href,
                publishedAt: result.publishedAt || null
            });
        }
    }

    return uniqueJobs(jobs).slice(0, OLX_RESULT_LIMIT);
}

function buildGenericSearchQueries(source) {
    const listUrl = String(source?.listUrl || '').trim();
    const hostname = readHostname(listUrl);
    const label = String(source?.label || '').trim();
    const company = String(source?.company || '').trim();
    return Array.from(new Set([
        hostname ? `site:${hostname} "Porto Velho" vaga emprego` : '',
        hostname ? `site:${hostname} "Porto Velho" "RO"` : '',
        company ? `"${company}" "Porto Velho" vaga` : '',
        label ? `"${label}" vaga "Porto Velho"` : ''
    ].filter(Boolean)));
}

function readHostname(value) {
    try {
        return new URL(String(value || '').trim()).hostname;
    } catch (_) {
        return '';
    }
}

function matchesSearchSourceHost(url, sitePattern) {
    try {
        const hostname = new URL(String(url || '').trim()).hostname;
        return sitePattern instanceof RegExp ? sitePattern.test(hostname) : true;
    } catch (_) {
        return false;
    }
}

function looksLikeJobSearchResult(result, source) {
    const haystack = normalizeSpace([result?.title, result?.snippet].join(' '))
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    if (!haystack) return false;
    if (!/(vaga|vagas|emprego|empregos|oportunidade|trabalhe conosco|processo seletivo|job|jobs|career|careers)/i.test(haystack)) {
        return false;
    }
    if (!/(porto velho|rondonia|\bro\b|pvh)/i.test(haystack)) {
        return false;
    }
    if (/\b(curso|noticia|noticias|blog|artigo|salario minimo|dicas|como fazer|concurso|concurseiro)\b/i.test(haystack)) {
        return false;
    }
    return matchesSearchSourceHost(result?.href, source?.sitePattern);
}

async function collectGenericSearchJobs(source) {
    const queries = buildGenericSearchQueries(source);
    const jobs = [];

    for (const query of queries) {
        let results = [];
        try {
            results = extractBraveGenericResults(await fetchBraveSearchHtml(query));
        } catch (_) {
            results = [];
        }

        if (results.length === 0) {
            try {
                results = extractDuckDuckGoGenericResults(await fetchDuckDuckGoSearchHtml(query));
            } catch (_) {
                results = [];
            }
        }

        for (const result of results.slice(0, SEARCH_SOURCE_RESULT_LIMIT)) {
            if (!looksLikeJobSearchResult(result, source)) continue;
            jobs.push({
                sourceId: source.id,
                sourceLabel: source.label,
                title: result.title,
                company: source.company || 'Empresa anunciada no portal',
                location: 'Porto Velho/RO',
                area: '',
                summary: result.snippet || `Vaga encontrada em ${source.label}.`,
                requirements: result.snippet || result.title,
                salaryInfo: '',
                role: result.title,
                applyInfo: `${source.applyInfoPrefix || 'Acesse a vaga no portal'}: ${result.href}`,
                url: result.href,
                publishedAt: result.publishedAt || null
            });
        }
    }

    return uniqueJobs(jobs).slice(0, SEARCH_SOURCE_RESULT_LIMIT);
}

function buildGeracaoEmpregoHeaders() {
    return {
        accept: 'application/json',
        'x-client-device': 'web',
        'x-version-name': '2.0.0',
        'content-type': 'application/json',
        'x-app-package': 'br.com.bluetrix.geracaoemprego.web'
    };
}

function formatGeracaoSalary(pay, payPeriod) {
    const parsed = Number(pay);
    if (!Number.isFinite(parsed) || parsed <= 0) return '';
    const suffix = payPeriod ? ` / ${cleanLine(payPeriod, 20)}` : '';
    return `R$ ${parsed.toFixed(2).replace('.', ',')}${suffix}`;
}

async function collectGeracaoEmpregoJobs() {
    const payload = await fetchJson(`${GERACAO_EMPREGO_API_URL}/sine/search_opportunities`, buildGeracaoEmpregoHeaders());
    const opportunities = Array.isArray(payload?.opportunities) ? payload.opportunities : [];

    const jobs = opportunities
        .filter((item) => /porto velho/i.test(String(item?.work_address?.city || '')))
        .map((item) => {
            const city = cleanLine(item?.work_address?.city || 'Porto Velho', 50);
            const state = cleanLine(item?.work_address?.state_abbrev || 'RO', 10);
            const district = cleanLine(item?.work_address?.district || '', 60);
            const roleTitle = cleanLine(item?.occupation_title || item?.occupation_name || 'Vaga de emprego', 110);
            const applyUrl = `${GERACAO_EMPREGO_API_URL.replace('api.', '')}/vagas-de-emprego?order_by=newest&application=geracaoemprego&page=1`;
            const skills = Array.isArray(item?.desired_skills_categories)
                ? item.desired_skills_categories.map((skill) => cleanLine(skill?.title || '', 40)).filter(Boolean)
                : [];

            return {
                sourceId: 'geracao_emprego',
                sourceLabel: 'Geracao Emprego RO',
                title: roleTitle,
                company: 'Empresa cadastrada no Geracao Emprego',
                location: `${city}/${state}`,
                area: cleanLine(item?.occupation_name || '', 80),
                summary: cleanLine(item?.job_description || `Vaga em ${district || city}.`, 520),
                requirements: cleanLine([
                    item?.schooling ? `Escolaridade: ${item.schooling}` : '',
                    skills.length ? `Competencias: ${skills.join(', ')}` : '',
                    Array.isArray(item?.job_type) && item.job_type.length ? `Tipo: ${item.job_type.join(', ')}` : '',
                    Number(item?.job_openings) > 0 ? `Vagas: ${item.job_openings}` : ''
                ].filter(Boolean).join(' | '), MAX_REQUIREMENTS_LENGTH),
                salaryInfo: formatGeracaoSalary(item?.pay, item?.pay_period),
                role: roleTitle,
                applyInfo: `Candidate-se pelo portal Geracao Emprego: ${applyUrl}`,
                url: `${applyUrl}#vaga-${item?.id || roleTitle.toLowerCase().replace(/\s+/g, '-')}`,
                publishedAt: parseIsoDate(item?.start_date ? `${item.start_date}T00:00:00-04:00` : '')
            };
        });

    return uniqueJobs(jobs);
}

function extractMarianaListJobs(html) {
    const jobs = [];
    const rowRegex = /<tr>\s*<td[^>]*class="tdatagrid_cell action"[^>]*>\s*<a href="([^"]*VisualizaVaga[^"]*key=(\d+)[^"]*)"[\s\S]*?<td class="tdatagrid_cell"[^>]*>[\s\S]*?<\/td>\s*<td class="tdatagrid_cell" align="left"[^>]*>([\s\S]*?)<\/td>\s*<td class="tdatagrid_cell" align="left"[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;

    for (const match of String(html || '').matchAll(rowRegex)) {
        const [, relativeUrl, key, rawTitle, rawLocation] = match;
        const title = cleanLine(stripHtml(rawTitle), 110);
        const location = cleanLine(stripHtml(rawLocation), 60);
        const url = absoluteUrl(`${MARIANA_BASE_URL}/`, decodeHtml(relativeUrl));
        const detailUrl = url.replace('/index.php?', '/engine.php?');
        if (!title || !/porto velho/i.test(location) || !url) continue;
        jobs.push({ key, title, location, url, detailUrl });
    }

    return jobs.slice(0, MARIANA_RESULT_LIMIT);
}

function extractMarianaDetailField(html, label) {
    return cleanLine(stripHtml(readFirst(
        html,
        new RegExp(`<div class="section-title">${escapeRegex(label)}:<\\/div>\\s*<div class="section-content">([\\s\\S]*?)<\\/div>`, 'i')
    )), 520);
}

async function collectMarianaGoedertJobs() {
    const listHtml = await fetchHtml(`${MARIANA_BASE_URL}/engine.php?class=VagasListPublica&method=onReload`);
    const rows = extractMarianaListJobs(listHtml);
    const jobs = [];

    for (const row of rows) {
        let detailHtml = '';
        try {
            detailHtml = await fetchHtml(row.detailUrl || row.url);
        } catch (_) {
            detailHtml = '';
        }

        const company = extractMarianaDetailField(detailHtml, 'Empresa Contratante') || 'Empresa anunciada pela Mariana Goedert';
        const activities = extractMarianaDetailField(detailHtml, 'Atividades');
        const skills = extractMarianaDetailField(detailHtml, 'Conhecimentos e Habilidades');
        const requirements = extractMarianaDetailField(detailHtml, 'Requisitos e Qualificações');
        const salary = extractMarianaDetailField(detailHtml, 'Salário e Benefício') || extractMarianaDetailField(detailHtml, 'Salário');
        const hours = extractMarianaDetailField(detailHtml, 'Horários');
        const role = cleanLine(row.title.replace(/^COD\s*\d+\s*-\s*/i, ''), 110);

        jobs.push({
            sourceId: 'mariana_goedert',
            sourceLabel: 'Mariana Goedert',
            title: role || row.title,
            company,
            location: row.location.replace(/\s*-\s*/g, '/'),
            area: '',
            summary: activities || `Vaga publicada na Mariana Goedert para ${row.location}.`,
            requirements: cleanLine([requirements, skills, hours ? `Horario: ${hours}` : ''].filter(Boolean).join(' | '), MAX_REQUIREMENTS_LENGTH),
            salaryInfo: salary,
            role: role || row.title,
            applyInfo: `Acesse a vaga e candidate-se pelo portal Mariana Goedert: ${row.url}`,
            url: row.url,
            publishedAt: null
        });
    }

    return uniqueJobs(jobs);
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

function cleanLine(value, maxLen) {
    return truncate(
        normalizeSpace(String(value || '')
            .replace(/\s*[|•·]\s*/g, ', ')
            .replace(/,+/g, ', ')
            .replace(/\s*,\s*/g, ', ')),
        maxLen
    );
}

function formatLocation(value) {
    const safe = cleanLine(value, 60);
    return safe.replace(/\s*\/\s*/g, ' - ');
}

function buildRequirementBullets(value) {
    const parts = normalizeSpace(String(value || ''))
        .split(',')
        .map((item) => cleanLine(item, 180))
        .filter(Boolean)
        .slice(0, 8);

    if (parts.length === 0) return '';
    return parts.map((item) => `\u2022 ${item}`).join('\n');
}

function stripEmoji(value) {
    return normalizeSpace(String(value || '').replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, ' '));
}

function firstNonEmptyLine(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map((line) => normalizeSpace(line))
        .find(Boolean) || '';
}

function extractEmail(value) {
    const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : '';
}

function extractPhone(value) {
    const match = String(value || '').match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9?\d{4})-?\d{4}/);
    return match ? normalizeSpace(match[0]) : '';
}

function looksLikeInstagramJobPost(caption, accessibilityCaption, locationName) {
    const haystack = normalizeSpace([caption, accessibilityCaption, locationName].join(' '))
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    if (!haystack) return false;
    if (!/(porto velho|pvh|rondonia|\bro\b)/i.test(haystack)) return false;
    if (/\b(seguidores|visualizacoes|visualizações|divulgada aqui|alcancou|alcançou 1 milhao|stories agora)\b/i.test(haystack)) return false;
    if (/\b(contrata|contratando|curriculo|currículo|processo seletivo|envie seu curriculo|envie seu currículo)\b/i.test(haystack)) {
        return true;
    }

    return /\b(vaga|vagas|oportunidade)\b/i.test(haystack) && Boolean(extractEmail(haystack) || extractPhone(haystack));
}

function inferInstagramJobTitle(caption, accessibilityCaption) {
    const lines = String(caption || '')
        .split(/\r?\n/)
        .map((line) => stripEmoji(line))
        .filter(Boolean);

    const captionText = normalizeSpace(stripEmoji(caption));
    const multiRoleMatch = captionText.match(/oportunidades?\s+abertas?\s+para:\s*([^.]+?)(?:local:|se voce|se você|envie seu curriculo|envie seu currículo|marque alguem|marque alguém|siga @|#|$)/i);
    if (multiRoleMatch?.[1]) {
        return cleanLine(
            multiRoleMatch[1]
                .replace(/\s{2,}/g, ', ')
                .replace(/[•·]/g, ', ')
                .replace(/\s*️\s*/g, ', '),
            110
        );
    }

    const openRoleMatch = captionText.match(/vaga\s+aberta[,:\s-]*(?:para|na area|na área)\s+([^.]+?)(?:segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|oque a empresa|requisitos|envie seu curriculo|envie seu currículo|marque alguem|marque alguém|$)/i);
    if (openRoleMatch?.[1]) {
        return cleanLine(openRoleMatch[1], 110);
    }

    for (const line of lines) {
        const hired = line.match(/(?:esta|está)\s+contratando[:\s-]*(.+)$/i);
        if (hired?.[1]) {
            const candidate = cleanLine(hired[1], 110);
            if (/[A-Za-zÀ-Ý0-9]/.test(candidate)) return candidate;
        }
        if (/(?:esta|está)\s+contratando[:\s-]*$/i.test(line)) {
            continue;
        }

        if (/^(vaga|oportunidade)/i.test(line)) {
            return cleanLine(line.replace(/^(vaga|oportunidade)(\s+de\s+emprego)?[:\s-]*/i, ''), 110);
        }

        if (/^[A-ZÀ-Ý0-9\s/&-]{4,}$/.test(line) && !/^PORTO VELHO/i.test(line)) {
            return cleanLine(line, 110);
        }
    }

    const accessibility = stripEmoji(accessibilityCaption);
    const accessibilityMatch = accessibility.match(/vaga de emprego\s+(.+?)(?:\s{2,}|\.|$)/i);
    if (accessibilityMatch?.[1]) {
        return cleanLine(
            accessibilityMatch[1].split(/\b(superior|experiencia|experiência|requisitos|carga horaria|carga horária|salario|salário)\b/i)[0],
            110
        );
    }

    return cleanLine(firstNonEmptyLine(caption) || 'Vaga divulgada no Instagram', 110);
}

function inferInstagramCompany(caption, accessibilityCaption) {
    const captionMatch = String(caption || '').match(/^(.+?)\s+(?:esta|está)\s+contratando/i);
    if (captionMatch?.[1]) return cleanLine(stripEmoji(captionMatch[1]), 80);

    const accessibility = stripEmoji(accessibilityCaption);
    const companyMatch = accessibility.match(/may be an image of text that says ['"]?(.*?)\s+vaga de emprego/i);
    if (companyMatch?.[1]) return cleanLine(companyMatch[1], 80);

    return 'Empresa divulgada no Instagram';
}

function inferInstagramApplyInfo(caption, postUrl) {
    const email = extractEmail(caption);
    if (email) return `Envie curriculo para ${email}`;

    const phone = extractPhone(caption);
    if (phone) return `Contato informado no post: ${phone}`;

    return `Confira os detalhes e candidatura no post: ${postUrl}`;
}

function canonicalizeLinkedInJobUrl(rawUrl) {
    const safe = String(rawUrl || '').trim();
    if (!safe) return '';

    try {
        const parsed = new URL(safe);
        parsed.search = '';
        parsed.hash = '';
        parsed.hostname = 'br.linkedin.com';
        return parsed.toString();
    } catch (_) {
        return '';
    }
}

function formatLinkedInLocation(city, region) {
    const citySafe = cleanLine(city, 50).replace(/,\s*Brazil$/i, '').replace(/,\s*Brasil$/i, '').trim();
    const regionSafe = cleanLine(region, 20).replace(/^Rondônia$/i, 'RO').replace(/^Rondonia$/i, 'RO');
    if (!citySafe) return 'Porto Velho/RO';
    if (!regionSafe) return citySafe;
    return `${citySafe}/${regionSafe}`;
}

function parseInstagramJob(node, username) {
    const caption = node?.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const accessibilityCaption = node?.accessibility_caption || '';
    const locationName = node?.location?.name || '';

    if (!looksLikeInstagramJobPost(caption, accessibilityCaption, locationName)) {
        return null;
    }

    const postUrl = node?.product_type === 'clips' || node?.__typename === 'GraphVideo'
        ? `https://www.instagram.com/reel/${node.shortcode}/`
        : `https://www.instagram.com/p/${node.shortcode}/`;
    const title = inferInstagramJobTitle(caption, accessibilityCaption);

    return {
        sourceId: `instagram_${username}`,
        sourceLabel: `Instagram @${username}`,
        title,
        company: inferInstagramCompany(caption, accessibilityCaption),
        location: /porto velho/i.test(`${locationName} ${caption} ${accessibilityCaption}`) ? 'Porto Velho/RO' : cleanLine(locationName, 60) || 'Porto Velho/RO',
        area: '',
        summary: cleanLine(stripEmoji(caption), 520) || 'Vaga publicada em perfil publico do Instagram.',
        requirements: cleanLine(stripEmoji(accessibilityCaption || caption), MAX_REQUIREMENTS_LENGTH),
        salaryInfo: '',
        role: title,
        applyInfo: inferInstagramApplyInfo(caption, postUrl),
        url: postUrl,
        publishedAt: Number(node?.taken_at_timestamp) ? Number(node.taken_at_timestamp) * 1000 : null
    };
}

async function collectInstagramProfileJobs(username) {
    const safeUsername = String(username || '').trim().replace(/^@+/, '').toLowerCase();
    if (!safeUsername) return [];

    const cache = loadInstagramCache();
    const cachedEntry = cache?.[safeUsername] && typeof cache[safeUsername] === 'object' ? cache[safeUsername] : null;
    const lastFailedAt = cachedEntry?.lastFailedAt ? Date.parse(cachedEntry.lastFailedAt) : NaN;
    const retryAfterMs = Number(cachedEntry?.retryAfterMs) || 0;
    if (Number.isFinite(lastFailedAt) && retryAfterMs > 0 && (lastFailedAt + retryAfterMs) > Date.now() && !cachedEntry?.payload) {
        return [];
    }

    let payload = null;

    try {
        payload = await fetchJson(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(safeUsername)}`, {
            'x-ig-app-id': INSTAGRAM_APP_ID,
            referer: `https://www.instagram.com/${safeUsername}/`
        });

        cache[safeUsername] = {
            fetchedAt: new Date().toISOString(),
            lastFailedAt: null,
            retryAfterMs: 0,
            lastWarnedAt: null,
            payload
        };
        saveInstagramCache(cache);
    } catch (error) {
        payload = cachedEntry?.payload || null;
        const message = error?.message || String(error);
        const retryWindow = /HTTP 429\b/i.test(message)
            ? INSTAGRAM_RETRY_AFTER_429_MS
            : /HTTP 401\b/i.test(message)
                ? INSTAGRAM_RETRY_AFTER_401_MS
                : 60 * 60 * 1000;

        cache[safeUsername] = {
            ...(cachedEntry || {}),
            lastFailedAt: new Date().toISOString(),
            retryAfterMs: retryWindow,
            payload
        };
        saveInstagramCache(cache);
        if (!payload) {
            logger.warn('job_forwarder_instagram_profile_unavailable', {
                source: `Instagram @${safeUsername}`,
                error: message,
                retryAfterMs: retryWindow
            });
            return [];
        }

        const lastWarnedAt = cachedEntry?.lastWarnedAt ? Date.parse(cachedEntry.lastWarnedAt) : NaN;
        const shouldWarn = !Number.isFinite(lastWarnedAt) || (lastWarnedAt + INSTAGRAM_CACHE_WARN_INTERVAL_MS) <= Date.now();
        if (shouldWarn) {
            cache[safeUsername] = {
                ...(cache[safeUsername] || {}),
                lastWarnedAt: new Date().toISOString()
            };
            saveInstagramCache(cache);
            logger.warn('job_forwarder_instagram_cache_fallback', {
                source: `Instagram @${safeUsername}`,
                error: message,
                cachedAt: cachedEntry?.fetchedAt || null
            });
        }
    }

    const edges = payload?.data?.user?.edge_owner_to_timeline_media?.edges;
    if (!Array.isArray(edges)) return [];

    const jobs = [];
    for (const edge of edges.slice(0, 18)) {
        const parsed = parseInstagramJob(edge?.node, safeUsername);
        if (parsed) jobs.push(parsed);
    }

    return uniqueJobs(jobs);
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

function normalizeNewsletterInviteCode(value) {
    const safe = String(value || '').trim();
    if (!safe) return '';
    try {
        const parsed = new URL(safe);
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && parts[0].toLowerCase() === 'channel') {
            return String(parts[1] || '').trim();
        }
        return safe;
    } catch (_) {
        return safe.replace(/^\/+|\/+$/g, '');
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

function loadInstagramCache() {
    try {
        if (!fs.existsSync(INSTAGRAM_CACHE_FILE)) return {};
        const parsed = JSON.parse(fs.readFileSync(INSTAGRAM_CACHE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function saveInstagramCache(cache) {
    fs.writeFileSync(INSTAGRAM_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function getDefaultState() {
    return {
        initialized: false,
        seenUrls: [],
        seenFingerprints: [],
        lastRunAt: null,
        braveSearchBlockedUntil: null,
        sourceCooldowns: {}
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
            lastRunAt: parsed?.lastRunAt || null,
            braveSearchBlockedUntil: parsed?.braveSearchBlockedUntil || null,
            sourceCooldowns: parsed?.sourceCooldowns && typeof parsed.sourceCooldowns === 'object' ? parsed.sourceCooldowns : {}
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
        lastRunAt: state?.lastRunAt || null,
        braveSearchBlockedUntil: state?.braveSearchBlockedUntil || null,
        sourceCooldowns: state?.sourceCooldowns && typeof state?.sourceCooldowns === 'object' ? state.sourceCooldowns : {}
    }, null, 2), 'utf8');
}

function getSourceCooldownEntry(state, sourceId) {
    if (!state.sourceCooldowns || typeof state.sourceCooldowns !== 'object') {
        state.sourceCooldowns = {};
    }
    const key = String(sourceId || '').trim();
    return key ? state.sourceCooldowns[key] || null : null;
}

function isSourceCoolingDown(state, sourceId) {
    const entry = getSourceCooldownEntry(state, sourceId);
    if (!entry?.until) return false;
    const untilTs = Date.parse(entry.until);
    return Number.isFinite(untilTs) && untilTs > Date.now();
}

function setSourceCooldown(state, sourceId, error) {
    if (!state.sourceCooldowns || typeof state.sourceCooldowns !== 'object') {
        state.sourceCooldowns = {};
    }
    const key = String(sourceId || '').trim();
    if (!key) return;
    state.sourceCooldowns[key] = {
        until: new Date(Date.now() + SOURCE_FAILURE_COOLDOWN_MS).toISOString(),
        error: error?.message || String(error || ''),
        updatedAt: new Date().toISOString()
    };
}

function clearSourceCooldown(state, sourceId) {
    if (!state.sourceCooldowns || typeof state.sourceCooldowns !== 'object') return;
    delete state.sourceCooldowns[String(sourceId || '').trim()];
}

async function fetchHtml(url, extraHeaders = {}) {
    const response = await fetch(url, {
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; iMavyBot/1.0; +https://github.com/fjprojectsdev/jh)',
            ...extraHeaders
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} em ${url}`);
    }
    return response.text();
}

async function fetchJson(url, extraHeaders = {}) {
    const response = await fetch(url, {
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; iMavyBot/1.0; +https://github.com/fjprojectsdev/jh)',
            accept: 'application/json',
            ...extraHeaders
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} em ${url}`);
    }
    return response.json();
}

function resolveTargetGroups(groups) {
    const normalizedTargets = TARGET_GROUPS.map((item) => ({
        raw: item,
        normalized: normalizeGroupName(item),
        isJid: /@g\.us$/i.test(String(item || '').trim())
    }));
    const remaining = new Set(normalizedTargets.map((item) => item.raw));
    const resolved = [];

    for (const [id, group] of Object.entries(groups || {})) {
        const subject = String(group?.subject || id).trim() || id;
        const normalized = normalizeGroupName(subject);
        for (const target of normalizedTargets) {
            if (!remaining.has(target.raw)) continue;
            const matched = target.isJid ? id === target.raw : normalized === target.normalized;
            if (!matched) continue;
            resolved.push({ id, subject, target: target.raw });
            remaining.delete(target.raw);
            break;
        }
    }

    return {
        resolved,
        missing: TARGET_GROUPS.filter((item) => remaining.has(item))
    };
}

async function resolveNewsletterTargets(sock) {
    const resolved = [];
    const missing = [];

    for (const jid of JOB_CHANNEL_JIDS) {
        resolved.push({
            id: jid,
            subject: jid,
            target: jid,
            targetType: 'newsletter'
        });
    }

    for (const inviteCode of JOB_CHANNEL_INVITE_CODES) {
        const cacheKey = inviteCode.toLowerCase();
        const cached = newsletterTargetCache.get(cacheKey);
        if (cached && (Date.now() - cached.cachedAt) < NEWSLETTER_CACHE_TTL_MS) {
            resolved.push(cached.value);
            continue;
        }

        if (typeof sock?.newsletterMetadata !== 'function') {
            missing.push(inviteCode);
            continue;
        }

        try {
            const metadata = await sock.newsletterMetadata('invite', inviteCode);
            if (!metadata?.id) {
                missing.push(inviteCode);
                continue;
            }

            const target = {
                id: String(metadata.id).trim(),
                subject: String(metadata.name || metadata.id).trim() || String(metadata.id).trim(),
                target: inviteCode,
                targetType: 'newsletter'
            };
            newsletterTargetCache.set(cacheKey, {
                cachedAt: Date.now(),
                value: target
            });
            resolved.push(target);
        } catch (error) {
            missing.push(inviteCode);
            logger.warn('job_forwarder_newsletter_lookup_failed', {
                inviteCode,
                error: error?.message || String(error)
            });
        }
    }

    return { resolved, missing };
}

async function resolvePublishTargets(sock, groups, options = {}) {
    const targets = [];
    const missing = [];
    const includeGroups = options.forceIncludeGroups === true || !JOB_DISABLE_GROUPS;

    if (includeGroups) {
        const { resolved, missing: missingGroups } = resolveTargetGroups(groups);
        targets.push(...resolved.map((item) => ({ ...item, targetType: 'group' })));
        missing.push(...missingGroups);
    }

    const { resolved: newsletterTargets, missing: missingNewsletters } = await resolveNewsletterTargets(sock);
    targets.push(...newsletterTargets);
    missing.push(...missingNewsletters);

    return { resolved: targets, missing };
}

export async function sendJobToConfiguredTargets(sock, job, options = {}) {
    if (!sock) return { sent: 0, failed: 0, targets: [] };

    const groups = typeof sock.groupFetchAllParticipating === 'function'
        ? await sock.groupFetchAllParticipating()
        : {};
    const { resolved: targets } = await resolvePublishTargets(sock, groups, {
        forceIncludeGroups: options.includeGroups === true
    });
    const delayMs = Math.max(500, Number(options.delayMs || 1200));
    let sent = 0;
    let failed = 0;

    for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        const delivered = await sendSafeMessage(sock, target.id, buildJobPayload(job, { targetType: target.targetType }));
        if (delivered) {
            sent += 1;
        } else {
            failed += 1;
        }
        if (index < targets.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    const apiResult = await postJobToEmpregosPvh(job);

    return { sent, failed, targets, api: apiResult };
}

export function buildJobPayload(job, options = {}) {
    const safeUrl = String(job.url || '').replace('https://', 'https://\u200B');
    const requirementBullets = buildRequirementBullets(job.requirements);
    const siteUrl = 'http://empregospvh.com.br';
    const channelUrl = 'https://whatsapp.com/channel/0029VbCuxQ8BKfi1ZJaHhw0R';
    const targetType = String(options.targetType || '').trim().toLowerCase();
    const footerLines = targetType === 'newsletter'
        ? [
            '',
            '━━━━━━━━━━━━━━━━━━━━━━',
            '',
            `🌐 Acesse: ${siteUrl}`
        ]
        : targetType === 'group'
            ? [
                '',
                '━━━━━━━━━━━━━━━━━━━━━━',
                '',
                '📢 Quer ver mais vagas ou perdeu alguma oportunidade?',
                '',
                `🌐 Acesse: ${siteUrl}`,
                '',
                '📲 Ou entre no nosso canal do WhatsApp:',
                '',
                channelUrl
            ]
            : [];
    const lines = [
        `📌 VAGA: ${cleanLine(job.title, 110)}`,
        '',
        job.company ? `🏢 Empresa: ${cleanLine(job.company, 80)}` : '',
        job.location ? `📍 Local: ${formatLocation(job.location)}` : '',
        job.area ? `📖 Area: ${cleanLine(job.area, 80)}` : '',
        '',
        '📝 Descricao:',
        cleanLine(job.summary, 520),
        '',
        requirementBullets ? '✅ Requisitos:' : '',
        requirementBullets,
        '',
        job.salaryInfo ? '💰 Salario e Beneficios:' : '',
        job.salaryInfo ? `• ${cleanLine(job.salaryInfo, 120)}` : '',
        '',
        '🔗 Candidatura:',
        cleanLine(job.applyInfo, 220),
        safeUrl,
        ...footerLines
    ].filter((line, index, array) => {
        if (line !== '') return true;
        return array[index - 1] !== '' && array[index + 1] !== '';
    });

    return { text: lines.join('\n') };
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized) return normalized;
    }
    return '';
}

function inferJobCategory(job) {
    const area = firstNonEmpty(job.area, job.role, job.title).toLowerCase();
    if (!area) return 'Geral';
    if (/(administr|financeir|contabil|fiscal|rh|recursos humanos|dp|departamento pessoal)/i.test(area)) return 'Administrativo';
    if (/(vendas|comercial|atendimento|caixa|balconista)/i.test(area)) return 'Comercial';
    if (/(motorista|entrega|logistica|estoque|almoxarif)/i.test(area)) return 'Logistica';
    if (/(tecnic|manutenc|mecanic|eletric|operador|produc|industr)/i.test(area)) return 'Operacional';
    if (/(saude|enferm|farmac|clin|medic|odont)/i.test(area)) return 'Saude';
    if (/(ti|tecnologia|desenvolvedor|programador|suporte|analista de sistemas)/i.test(area)) return 'Tecnologia';
    if (/(limpeza|servicos gerais|zelador|copeir|auxiliar)/i.test(area)) return 'Servicos Gerais';
    return cleanLine(firstNonEmpty(job.area, job.role, job.title), 80) || 'Geral';
}

function inferJobNeighborhood(job) {
    const location = firstNonEmpty(job.location, job.applyInfo, job.summary);
    const normalized = location
        .replace(/\bporto velho\s*\/?\s*ro\b/ig, '')
        .replace(/\bro\b/ig, '')
        .replace(/\bpresencial\b/ig, '')
        .replace(/\bremoto\b/ig, '')
        .replace(/\bhibrido\b/ig, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-,:;|]+/, '')
        .replace(/[-,:;|]+$/, '');
    return normalized || 'Centro';
}

function inferJobType(job) {
    const haystack = [job.summary, job.requirements, job.applyInfo, job.title].map((item) => String(item || '')).join(' ');
    if (/\best[aá]gio\b/i.test(haystack)) return 'Estagio';
    if (/\bjovem aprendiz\b/i.test(haystack)) return 'Jovem Aprendiz';
    if (/\btempor[aá]ri[oa]\b/i.test(haystack)) return 'Temporario';
    if (/\bfreelancer\b/i.test(haystack)) return 'Freelance';
    if (/\bpj\b/i.test(haystack)) return 'PJ';
    return 'CLT';
}

function inferContactType(job) {
    const applyInfo = String(job.applyInfo || '');
    if (/@/.test(applyInfo) && !/https?:\/\//i.test(applyInfo)) return 'email';
    if (/wa\.me|whatsapp|\b55\d{10,13}\b/i.test(applyInfo)) return 'whatsapp';
    return 'link';
}

function inferContactValue(job) {
    const applyInfo = firstNonEmpty(job.applyInfo, job.url);
    const urlMatch = applyInfo.match(/https?:\/\/\S+/i);
    if (urlMatch) return urlMatch[0].replace(/[),.;]+$/, '');
    const emailMatch = applyInfo.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch) return emailMatch[0];
    const phoneMatch = applyInfo.match(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?(?:9?\d{4}[-\s]?\d{4})/);
    if (phoneMatch) {
        return phoneMatch[0].replace(/\D/g, '');
    }
    return String(job.url || '').trim();
}

function mapJobToEmpregosPvhPayload(job) {
    const requirements = buildRequirementBullets(job.requirements)
        .split('\n')
        .map((item) => item.replace(/^[•\-]\s*/, '').trim())
        .filter(Boolean);
    const description = cleanLine(job.summary, 2000);
    const contactType = inferContactType(job);
    const contactValue = inferContactValue(job);

    return {
        title: cleanLine(job.title, 160),
        company: cleanLine(job.company || 'Empresa anunciada', 120),
        category: inferJobCategory(job),
        neighborhood: inferJobNeighborhood(job),
        city: 'Porto Velho',
        salary: cleanLine(job.salaryInfo, 160) || null,
        type: inferJobType(job),
        source: 'Bot',
        description: description || 'Vaga coletada automaticamente pelo bot de empregos.',
        requirements: requirements.length > 0 ? requirements : ['Ver detalhes completos no link de candidatura.'],
        contactType,
        contactValue: contactValue || String(job.url || '').trim(),
        externalUrl: String(job.url || '').trim() || null,
        featured: false
    };
}

async function postJobToEmpregosPvh(job) {
    if (!EMPREGOS_PVH_AUTO_POST) {
        return { skipped: true, reason: 'disabled' };
    }
    if (!EMPREGOS_PVH_API_URL || !EMPREGOS_PVH_INGESTION_TOKEN) {
        return { skipped: true, reason: 'missing_config' };
    }

    const payload = mapJobToEmpregosPvhPayload(job);
    try {
        const response = await fetch(`${EMPREGOS_PVH_API_URL}/api/jobs/import`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Ingestion-Token': EMPREGOS_PVH_INGESTION_TOKEN
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            logger.warn('job_forwarder_empregospvh_failed', {
                status: response.status,
                title: job.title,
                error: data?.error || response.statusText || 'request_failed'
            });
            return {
                ok: false,
                status: response.status,
                error: data?.error || response.statusText || 'request_failed'
            };
        }
        logger.info('job_forwarder_empregospvh_posted', {
            title: job.title,
            duplicate: data?.duplicate === true,
            approved: data?.job?.approved === true,
            jobId: data?.job?.id || null
        });
        return {
            ok: true,
            duplicate: data?.duplicate === true,
            approved: data?.job?.approved === true,
            jobId: data?.job?.id || null
        };
    } catch (error) {
        logger.warn('job_forwarder_empregospvh_failed', {
            title: job.title,
            error: error?.message || String(error)
        });
        return { ok: false, error: error?.message || String(error) };
    }
}

export function getConfiguredJobTargets() {
    return [
        ...(!JOB_DISABLE_GROUPS ? TARGET_GROUPS : []),
        ...JOB_CHANNEL_JIDS,
        ...JOB_CHANNEL_INVITE_CODES.map((code) => `channel:${code}`)
    ];
}

export function getJobForwarderStatus() {
    const config = loadConfig();
    const state = loadState();
    return {
        enabled: config.enabled !== false,
        cron: JOB_CRON,
        timezone: JOB_TIMEZONE,
        maxJobsPerRun: MAX_JOBS_PER_RUN,
        delayBetweenPostsMs: JOB_DELAY_BETWEEN_POSTS_MS,
        targets: getConfiguredJobTargets(),
        lastRunAt: state.lastRunAt || null,
        initialized: state.initialized === true,
        trackedUrls: Array.isArray(state.seenUrls) ? state.seenUrls.length : 0,
        trackedFingerprints: Array.isArray(state.seenFingerprints) ? state.seenFingerprints.length : 0,
        braveSearchBlockedUntil: state.braveSearchBlockedUntil || null,
        sourceCooldowns: state.sourceCooldowns && typeof state.sourceCooldowns === 'object' ? state.sourceCooldowns : {}
    };
}

export async function collectJobs(options = {}) {
    const state = options.state && typeof options.state === 'object' ? options.state : loadState();
    const cycleStats = options.cycleStats && typeof options.cycleStats === 'object' ? options.cycleStats : null;
    const jobs = [];
    for (const source of SOURCES) {
        if (isSourceCoolingDown(state, source.id)) {
            if (cycleStats) {
                cycleStats.sourcesSkipped = Array.isArray(cycleStats.sourcesSkipped) ? cycleStats.sourcesSkipped : [];
                cycleStats.sourcesSkipped.push(source.label);
            }
            logger.warn('job_forwarder_source_cooldown', {
                source: source.label,
                until: getSourceCooldownEntry(state, source.id)?.until || null
            });
            continue;
        }
        try {
            const sourceJobs = await source.collect();
            clearSourceCooldown(state, source.id);
            jobs.push(...sourceJobs);
            if (cycleStats) {
                cycleStats.sourcesOk = Array.isArray(cycleStats.sourcesOk) ? cycleStats.sourcesOk : [];
                cycleStats.sourcesOk.push(source.label);
            }
        } catch (error) {
            setSourceCooldown(state, source.id, error);
            saveState(state);
            logger.error('job_forwarder_source_failed', {
                source: source.label,
                error: error?.message || String(error)
            });
            if (cycleStats) {
                cycleStats.sourcesFailed = Array.isArray(cycleStats.sourcesFailed) ? cycleStats.sourcesFailed : [];
                cycleStats.sourcesFailed.push(source.label);
            }
        }
    }

    return uniqueJobs(jobs).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
}

export async function collectPreparedJobsForPublishing(options = {}) {
    const filterFn = typeof options.filterFn === 'function' ? options.filterFn : null;
    const excludeUrls = Array.isArray(options.excludeUrls) ? options.excludeUrls : [];
    const excluded = new Set(excludeUrls.map((item) => normalizeUrl(item)));
    const state = options.state && typeof options.state === 'object' ? options.state : loadState();
    const jobs = await collectJobs({ state });
    const freshJobs = jobs.filter((job) => {
        const safeUrl = normalizeUrl(job.url);
        if (excluded.has(safeUrl)) return false;
        return filterFn ? filterFn(job) : true;
    });

    const preparedJobs = [];
    for (const job of freshJobs) {
        const analyzed = await analyzeJobForPublishing(job);
        if (!analyzed?.publish) {
            logger.info('job_forwarder_filtered', {
                source: job.sourceLabel,
                title: job.title,
                reason: analyzed?.reason || 'filtered'
            });
            continue;
        }
        if (filterFn && !filterFn(analyzed)) {
            continue;
        }
        preparedJobs.push(analyzed);
    }

    return preparedJobs;
}

function mergeStateEntries(current = [], extra = []) {
    return Array.from(new Set([...(Array.isArray(current) ? current : []), ...(Array.isArray(extra) ? extra : [])]))
        .slice(-MAX_TRACKED_ITEMS);
}

async function pollJobs(sock) {
    if (pollingInFlight) return;
    pollingInFlight = true;

    try {
        const config = loadConfig();
        if (config.enabled === false) {
            logger.info('job_forwarder_paused');
            return;
        }

        const groups = await sock.groupFetchAllParticipating();
        const { resolved: targetGroups, missing: missingGroups } = await resolvePublishTargets(sock, groups);
        if (targetGroups.length === 0) {
            logger.warn('job_forwarder_group_not_found', {
                targetGroups: !JOB_DISABLE_GROUPS ? TARGET_GROUPS : [],
                targetChannels: [...JOB_CHANNEL_JIDS, ...JOB_CHANNEL_INVITE_CODES]
            });
            return;
        }
        if (missingGroups.length > 0) {
            logger.warn('job_forwarder_groups_missing', { targetGroups: missingGroups });
        }

        const cycleStats = {
            collectedJobs: 0,
            freshJobs: 0,
            analyzedJobs: 0,
            filteredJobs: 0,
            sentToGroups: 0,
            privateDispatchCandidates: 0,
            targetGroups: targetGroups.map((group) => `${group.targetType}:${group.subject}`)
        };
        const state = loadState();
        const jobs = await collectJobs({ state, cycleStats });
        cycleStats.collectedJobs = jobs.length;
        const urlsSnapshot = jobs.map((job) => normalizeUrl(job.url));
        const fingerprintSnapshot = jobs.map((job) => jobFingerprint(job));

        if (!state.initialized) {
            state.initialized = true;
            state.seenUrls = mergeStateEntries(state.seenUrls, urlsSnapshot);
            state.seenFingerprints = mergeStateEntries(state.seenFingerprints, fingerprintSnapshot);
            state.lastRunAt = new Date().toISOString();
            saveState(state);
            logger.info('job_forwarder_initialized', {
                targetGroups: targetGroups.map((group) => group.subject),
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
        cycleStats.freshJobs = freshJobs.length;

        if (freshJobs.length === 0) {
            state.seenUrls = mergeStateEntries(state.seenUrls, urlsSnapshot);
            state.seenFingerprints = mergeStateEntries(state.seenFingerprints, fingerprintSnapshot);
            state.lastRunAt = new Date().toISOString();
            saveState(state);
            logger.info('job_forwarder_cycle_summary', cycleStats);
            return;
        }

        const analyzedFreshJobs = [];
        const filteredFreshJobs = [];
        for (const job of freshJobs) {
            const analyzed = await analyzeJobForPublishing(job);
            if (analyzed?.publish) {
                analyzedFreshJobs.push(analyzed);
            } else {
                filteredFreshJobs.push(job);
                logger.info('job_forwarder_filtered', {
                    source: job.sourceLabel,
                    title: job.title,
                    reason: analyzed?.reason || 'filtered'
                });
            }
        }
        cycleStats.analyzedJobs = analyzedFreshJobs.length;
        cycleStats.filteredJobs = filteredFreshJobs.length;

        if (analyzedFreshJobs.length === 0) {
            state.seenUrls = mergeStateEntries(state.seenUrls, filteredFreshJobs.map((job) => normalizeUrl(job.url)));
            state.seenFingerprints = mergeStateEntries(state.seenFingerprints, filteredFreshJobs.map((job) => jobFingerprint(job)));
            state.lastRunAt = new Date().toISOString();
            saveState(state);
            logger.info('job_forwarder_cycle_summary', cycleStats);
            return;
        }

        const jobsToSend = analyzedFreshJobs.slice(0, MAX_JOBS_PER_RUN);
        for (let jobIndex = 0; jobIndex < jobsToSend.length; jobIndex += 1) {
            const job = jobsToSend[jobIndex];
            for (const targetGroup of targetGroups) {
                const sent = await sendSafeMessage(sock, targetGroup.id, buildJobPayload(job, { targetType: targetGroup.targetType }));
                if (sent) {
                    cycleStats.sentToGroups += 1;
                    logger.info('job_forwarder_sent', {
                        group: targetGroup.subject,
                        targetType: targetGroup.targetType,
                        source: job.sourceLabel,
                        title: job.title,
                        url: job.url
                    });
                }
                await new Promise((resolve) => setTimeout(resolve, 1200));
            }
            await postJobToEmpregosPvh(job);
            if (jobIndex < jobsToSend.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, JOB_DELAY_BETWEEN_POSTS_MS));
            }
        }

        try {
            const { dispatchPrivateJobAlertsForJobs } = await import('./privateJobAlerts.js');
            cycleStats.privateDispatchCandidates = analyzedFreshJobs.length;
            await dispatchPrivateJobAlertsForJobs(sock, analyzedFreshJobs, {
                mode: 'inline_group_delivery',
                limit: MAX_JOBS_PER_RUN
            });
        } catch (error) {
            logger.error('job_forwarder_private_dispatch_failed', {
                error: error?.message || String(error)
            });
        }

        state.initialized = true;
        state.seenUrls = mergeStateEntries(state.seenUrls, [
            ...filteredFreshJobs.map((job) => normalizeUrl(job.url)),
            ...jobsToSend.map((job) => normalizeUrl(job.url))
        ]);
        state.seenFingerprints = mergeStateEntries(state.seenFingerprints, [
            ...filteredFreshJobs.map((job) => jobFingerprint(job)),
            ...jobsToSend.map((job) => jobFingerprint(job))
        ]);
        state.lastRunAt = new Date().toISOString();
        saveState(state);
        logger.info('job_forwarder_cycle_summary', cycleStats);
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

    const config = loadConfig();

    logger.info('job_forwarder_started', {
        cron: JOB_CRON,
        timezone: JOB_TIMEZONE,
        maxJobsPerRun: MAX_JOBS_PER_RUN,
        delayBetweenPostsMs: JOB_DELAY_BETWEEN_POSTS_MS,
        enabled: config.enabled !== false,
        targetGroups: !JOB_DISABLE_GROUPS ? TARGET_GROUPS : [],
        targetChannels: [...JOB_CHANNEL_JIDS, ...JOB_CHANNEL_INVITE_CODES],
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

export function stopJobPublishing() {
    const nextConfig = { ...loadConfig(), enabled: false };
    saveConfig(nextConfig);
    return nextConfig;
}

export function startJobPublishing() {
    const nextConfig = { ...loadConfig(), enabled: true };
    saveConfig(nextConfig);
    return nextConfig;
}

export function isJobPublishingEnabled() {
    return loadConfig().enabled !== false;
}
