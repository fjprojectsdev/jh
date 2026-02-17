import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp, loadFont } = require('jimp');
const { SANS_16_WHITE, SANS_32_WHITE } = require('@jimp/plugin-print/fonts');

const WIDTH = 1080;
const HEIGHT = 1350;
const TOKENS_PER_PAGE = 10;
const USERS_PER_PAGE = 10;

const COLORS = {
    bg: 0x04122eff,
    panel: 0x0a2457ff,
    panelSoft: 0x0d2d6aff,
    rowA: 0x12387fff,
    rowB: 0x0f2f6dff,
    white: 0xffffffff,
    green: 0x22c55eff,
    orange: 0xf59e0bff,
    red: 0xef4444ff,
    gray: 0x9ca3afff
};

function fillRect(image, x, y, w, h, color) {
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    const ex = Math.min(image.bitmap.width, Math.floor(x + w));
    const ey = Math.min(image.bitmap.height, Math.floor(y + h));
    for (let yy = sy; yy < ey; yy += 1) {
        for (let xx = sx; xx < ex; xx += 1) {
            image.setPixelColor(color, xx, yy);
        }
    }
}

function chunk(list, size) {
    const safe = Array.isArray(list) ? list : [];
    const pages = [];
    for (let i = 0; i < safe.length; i += size) {
        pages.push(safe.slice(i, i + size));
    }
    return pages.length ? pages : [[]];
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function tokenStatus(token) {
    const growth = Number(token?.growthRate || 0);
    if (growth >= 50) return { label: 'HYPE FORTE', color: COLORS.red };
    if (growth >= 20) return { label: 'HYPE MODERADO', color: COLORS.orange };
    return { label: 'ESTAVEL', color: COLORS.gray };
}

function temperatureColor(level) {
    if (level === 'QUENTE') return COLORS.red;
    if (level === 'MORNO') return COLORS.orange;
    return COLORS.gray;
}

export async function renderIntelRadarImages(report) {
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const tokenPages = chunk(report?.tokenAnalytics || [], TOKENS_PER_PAGE);
    const userPages = chunk(report?.topActiveUsers || [], USERS_PER_PAGE);
    const pages = Math.max(tokenPages.length, userPages.length);
    const buffers = [];

    for (let page = 0; page < pages; page += 1) {
        const tokens = tokenPages[page] || [];
        const users = userPages[page] || [];
        const image = new Jimp({ width: WIDTH, height: HEIGHT, color: COLORS.bg });

        fillRect(image, 24, 24, WIDTH - 48, 140, COLORS.panel);
        image.print({ font: titleFont, x: 46, y: 48, text: 'IMAVY RADAR COMERCIAL', maxWidth: 700 });
        image.print({ font: bodyFont, x: 46, y: 98, text: 'Ranking de Interesse da Comunidade', maxWidth: 450 });
        image.print({ font: bodyFont, x: WIDTH - 220, y: 52, text: `Pagina ${page + 1}/${pages}`, maxWidth: 170 });

        fillRect(image, 24, 182, WIDTH - 48, 150, COLORS.panelSoft);
        const summary = report?.summary || {};
        const lines = [
            `Total analisado: ${formatNumber(summary.totalMessages24h)}`,
            `Participantes ativos: ${formatNumber(summary.activeUsers)}`,
            `Nivel do grupo: ${summary.groupTemperature?.level || 'FRIO'}`,
            `Media msg/usuario: ${Number(summary.avgMessagesPerUser || 0).toFixed(2)}`
        ];
        lines.forEach((line, idx) => {
            image.print({ font: bodyFont, x: 44, y: 206 + (idx * 26), text: line, maxWidth: 480 });
        });

        fillRect(image, 560, 205, 486, 100, temperatureColor(summary.groupTemperature?.level));
        image.print({
            font: titleFont,
            x: 610,
            y: 238,
            text: summary.groupTemperature?.label || 'FRIO',
            maxWidth: 390
        });

        fillRect(image, 24, 350, WIDTH - 48, 430, COLORS.panel);
        image.print({ font: bodyFont, x: 46, y: 374, text: 'Projetos mais mencionados', maxWidth: 360 });
        image.print({ font: bodyFont, x: 46, y: 406, text: 'Token', maxWidth: 160 });
        image.print({ font: bodyFont, x: 248, y: 406, text: 'Total', maxWidth: 80 });
        image.print({ font: bodyFont, x: 360, y: 406, text: 'Crescimento', maxWidth: 160 });
        image.print({ font: bodyFont, x: 566, y: 406, text: 'Status', maxWidth: 280 });

        tokens.forEach((token, idx) => {
            const y = 440 + (idx * 32);
            fillRect(image, 40, y - 2, WIDTH - 80, 28, idx % 2 === 0 ? COLORS.rowA : COLORS.rowB);
            const status = tokenStatus(token);
            image.print({ font: bodyFont, x: 46, y, text: String(token.token || '-'), maxWidth: 160 });
            image.print({ font: bodyFont, x: 248, y, text: formatNumber(token.totalMentions), maxWidth: 80 });
            image.print({
                font: bodyFont,
                x: 360,
                y,
                text: `${Number(token.growthRate || 0).toFixed(1)}%`,
                maxWidth: 150
            });
            fillRect(image, 566, y, 240, 24, status.color);
            image.print({ font: bodyFont, x: 578, y: y + 2, text: status.label, maxWidth: 220 });
        });

        fillRect(image, 24, 802, WIDTH - 48, 524, COLORS.panel);
        image.print({ font: bodyFont, x: 46, y: 826, text: 'Top 10 mais ativos', maxWidth: 260 });
        image.print({ font: bodyFont, x: 46, y: 858, text: 'Posicao', maxWidth: 90 });
        image.print({ font: bodyFont, x: 156, y: 858, text: 'Nome', maxWidth: 420 });
        image.print({ font: bodyFont, x: 640, y: 858, text: 'Mensagens', maxWidth: 160 });

        users.forEach((user, idx) => {
            const y = 892 + (idx * 38);
            fillRect(image, 40, y - 2, WIDTH - 80, 30, idx % 2 === 0 ? COLORS.rowA : COLORS.rowB);
            image.print({ font: bodyFont, x: 46, y, text: `${(page * USERS_PER_PAGE) + idx + 1}`, maxWidth: 80 });
            image.print({ font: bodyFont, x: 156, y, text: String(user.name || '-'), maxWidth: 450 });
            image.print({ font: bodyFont, x: 640, y, text: formatNumber(user.totalMessages), maxWidth: 130 });
        });

        buffers.push(await image.getBuffer('image/png'));
    }

    return buffers;
}
