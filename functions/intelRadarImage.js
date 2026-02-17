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
const PIE_COLORS = [
    0x38bdf8ff, 0x22c55eff, 0xf59e0bff, 0xef4444ff, 0xa78bfaFF,
    0xf97316ff, 0x10b981ff, 0xeab308ff, 0xf43f5eff, 0x14b8a6ff
];

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

function userActivityStatus(totalMessages) {
    const count = Number(totalMessages || 0);
    if (count >= 15) return { label: 'MUITO ATIVO', color: COLORS.green };
    if (count >= 8) return { label: 'ATIVO', color: COLORS.orange };
    return { label: 'NORMAL', color: COLORS.gray };
}

function drawPieSlice(image, cx, cy, radius, startAngle, endAngle, color) {
    const r2 = radius * radius;
    for (let y = cy - radius; y <= cy + radius; y += 1) {
        for (let x = cx - radius; x <= cx + radius; x += 1) {
            const dx = x - cx;
            const dy = y - cy;
            if ((dx * dx) + (dy * dy) > r2) continue;

            let angle = Math.atan2(dy, dx);
            if (angle < 0) angle += Math.PI * 2;
            if (startAngle <= endAngle) {
                if (angle >= startAngle && angle < endAngle) {
                    image.setPixelColor(color, x, y);
                }
            } else if (angle >= startAngle || angle < endAngle) {
                image.setPixelColor(color, x, y);
            }
        }
    }
}

function drawPieChart(image, cx, cy, radius, tokens) {
    const safe = (Array.isArray(tokens) ? tokens : []).slice(0, 10);
    const total = safe.reduce((acc, t) => acc + Number(t.totalMentions || 0), 0);
    if (total <= 0) {
        fillRect(image, cx - radius, cy - 16, radius * 2, 32, COLORS.rowB);
        return [];
    }

    let cursor = 0;
    const legend = [];
    safe.forEach((token, idx) => {
        const value = Number(token.totalMentions || 0);
        const portion = value / total;
        const angleSize = portion * Math.PI * 2;
        const color = PIE_COLORS[idx % PIE_COLORS.length];
        drawPieSlice(image, cx, cy, radius, cursor, cursor + angleSize, color);
        cursor += angleSize;
        legend.push({
            token: String(token.token || '-'),
            value,
            pct: portion * 100,
            color
        });
    });

    fillRect(image, cx - 2, cy - radius, 4, radius * 2, COLORS.bg);
    fillRect(image, cx - radius, cy - 2, radius * 2, 4, COLORS.bg);
    return legend;
}

export async function renderIntelRadarImages(report) {
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const tokens = chunk(report?.tokenAnalytics || [], TOKENS_PER_PAGE)[0] || [];
    const users = chunk(report?.topActiveUsers || [], USERS_PER_PAGE)[0] || [];
    const pages = 1;
    const buffers = [];

    for (let page = 0; page < pages; page += 1) {
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

        fillRect(image, 24, 350, 520, 430, COLORS.panel);
        image.print({ font: bodyFont, x: 46, y: 374, text: 'Distribuicao de tokens (Top 10)', maxWidth: 360 });
        const pieLegend = drawPieChart(image, 220, 560, 130, tokens);
        pieLegend.slice(0, 10).forEach((entry, idx) => {
            const y = 420 + (idx * 28);
            fillRect(image, 360, y + 2, 16, 16, entry.color);
            image.print({
                font: bodyFont,
                x: 382,
                y,
                text: `${entry.token} ${entry.pct.toFixed(1)}%`,
                maxWidth: 140
            });
        });

        fillRect(image, 560, 350, 496, 430, COLORS.panel);
        image.print({ font: bodyFont, x: 580, y: 374, text: 'Top 10 grupos', maxWidth: 180 });
        image.print({ font: bodyFont, x: 580, y: 406, text: 'Grupo', maxWidth: 220 });
        image.print({ font: bodyFont, x: 830, y: 406, text: 'Msgs', maxWidth: 70 });
        image.print({ font: bodyFont, x: 920, y: 406, text: 'Ativos', maxWidth: 90 });
        const topGroups = Array.isArray(report?.topGroups) ? report.topGroups.slice(0, 10) : [];
        topGroups.forEach((group, idx) => {
            const y = 440 + (idx * 32);
            fillRect(image, 574, y - 2, 468, 28, idx % 2 === 0 ? COLORS.rowA : COLORS.rowB);
            image.print({ font: bodyFont, x: 580, y, text: String(group.groupName || '-'), maxWidth: 240 });
            image.print({ font: bodyFont, x: 830, y, text: formatNumber(group.totalMessages), maxWidth: 80 });
            image.print({ font: bodyFont, x: 920, y, text: formatNumber(group.activeUsers), maxWidth: 90 });
        });

        fillRect(image, 24, 802, WIDTH - 48, 524, COLORS.panel);
        image.print({ font: bodyFont, x: 46, y: 826, text: 'Top 10 mais ativos', maxWidth: 260 });
        image.print({ font: bodyFont, x: 46, y: 858, text: 'Posicao', maxWidth: 90 });
        image.print({ font: bodyFont, x: 156, y: 858, text: 'Nome', maxWidth: 420 });
        image.print({ font: bodyFont, x: 640, y: 858, text: 'Mensagens', maxWidth: 160 });
        image.print({ font: bodyFont, x: 800, y: 858, text: 'Status', maxWidth: 160 });

        users.forEach((user, idx) => {
            const y = 892 + (idx * 38);
            fillRect(image, 40, y - 2, WIDTH - 80, 30, idx % 2 === 0 ? COLORS.rowA : COLORS.rowB);
            image.print({ font: bodyFont, x: 46, y, text: `${idx + 1}`, maxWidth: 80 });
            image.print({ font: bodyFont, x: 156, y, text: String(user.name || '-'), maxWidth: 450 });
            image.print({ font: bodyFont, x: 640, y, text: formatNumber(user.totalMessages), maxWidth: 130 });
            const status = userActivityStatus(user.totalMessages);
            fillRect(image, 800, y, 180, 24, status.color);
            image.print({ font: bodyFont, x: 812, y: y + 2, text: status.label, maxWidth: 160 });
        });

        buffers.push(await image.getBuffer('image/png'));
    }

    return buffers;
}
