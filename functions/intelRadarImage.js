import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp, loadFont } = require('jimp');
const { SANS_16_WHITE, SANS_32_WHITE } = require('@jimp/plugin-print/fonts');

const WIDTH = 1080;
const HEIGHT = 1350;

const COLORS = {
    bg: 0x041332ff,
    panel: 0x0b2154ff,
    panelAlt: 0x0d2a63ff,
    text: 0xffffffff,
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

function chunkList(list, size = 10) {
    const chunks = [];
    const safe = Array.isArray(list) ? list : [];
    for (let i = 0; i < safe.length; i += size) {
        chunks.push(safe.slice(i, i + size));
    }
    return chunks.length ? chunks : [[]];
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function statusLabel(token) {
    const growth = Number(token?.growthRate || 0);
    if (growth >= 50) return { text: '🔥 Hype Forte', color: COLORS.red };
    if (growth >= 20) return { text: '🚀 Hype Moderado', color: COLORS.orange };
    return { text: '➖ Estavel', color: COLORS.gray };
}

function tempColor(level) {
    if (level === 'QUENTE') return COLORS.red;
    if (level === 'MORNO') return COLORS.orange;
    return COLORS.gray;
}

export async function renderIntelRadarImages(report) {
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const tokenChunks = chunkList(report?.tokenAnalytics || [], 10);
    const userChunks = chunkList(report?.topActiveUsers || [], 10);
    const pages = Math.max(tokenChunks.length, userChunks.length);
    const buffers = [];

    for (let page = 0; page < pages; page += 1) {
        const tokens = tokenChunks[page] || [];
        const users = userChunks[page] || [];
        const image = new Jimp({ width: WIDTH, height: HEIGHT, color: COLORS.bg });

        for (let y = 0; y < HEIGHT; y += 72) {
            for (let x = 0; x < WIDTH; x += 72) {
                if (((x + y) / 72) % 2 === 0) {
                    fillRect(image, x, y, 72, 72, 0x081a43ff);
                }
            }
        }

        fillRect(image, 28, 24, WIDTH - 56, 150, COLORS.panel);
        image.print({ font: titleFont, x: 48, y: 46, text: 'IMAVY RADAR COMERCIAL', maxWidth: 700 });
        image.print({ font: bodyFont, x: 48, y: 100, text: 'Ranking de Interesse da Comunidade', maxWidth: 500 });
        image.print({
            font: bodyFont,
            x: WIDTH - 280,
            y: 46,
            text: `Pagina ${page + 1}/${pages}`,
            maxWidth: 220
        });

        fillRect(image, 28, 190, WIDTH - 56, 150, COLORS.panelAlt);
        const summary = report?.summary || {};
        const blocks = [
            `Total analisado: ${formatNumber(summary.totalMessages24h)}`,
            `Participantes ativos: ${formatNumber(summary.activeUsers)}`,
            `Nivel do grupo: ${summary.groupTemperature?.level || 'FRIO'}`,
            `Media msg/usuario: ${Number(summary.avgMessagesPerUser || 0).toFixed(2)}`
        ];
        blocks.forEach((line, idx) => {
            image.print({ font: bodyFont, x: 48, y: 214 + (idx * 28), text: line, maxWidth: 480 });
        });
        fillRect(image, 560, 212, 420, 94, tempColor(summary.groupTemperature?.level));
        image.print({
            font: titleFont,
            x: 590,
            y: 240,
            text: summary.groupTemperature?.label || 'FRIO ❄',
            maxWidth: 360
        });

        fillRect(image, 28, 360, WIDTH - 56, 440, COLORS.panel);
        image.print({ font: bodyFont, x: 48, y: 382, text: 'Projetos mais mencionados', maxWidth: 360 });
        image.print({ font: bodyFont, x: 48, y: 416, text: 'Token', maxWidth: 180 });
        image.print({ font: bodyFont, x: 250, y: 416, text: 'Total', maxWidth: 120 });
        image.print({ font: bodyFont, x: 380, y: 416, text: 'Crescimento', maxWidth: 170 });
        image.print({ font: bodyFont, x: 590, y: 416, text: 'Status', maxWidth: 350 });

        tokens.forEach((token, idx) => {
            const rowY = 452 + (idx * 34);
            if (idx % 2 === 0) {
                fillRect(image, 42, rowY - 4, WIDTH - 84, 30, 0x0f2e70ff);
            }
            const status = statusLabel(token);
            image.print({ font: bodyFont, x: 48, y: rowY, text: String(token.token || '-'), maxWidth: 180 });
            image.print({ font: bodyFont, x: 250, y: rowY, text: formatNumber(token.totalMentions), maxWidth: 110 });
            image.print({
                font: bodyFont,
                x: 380,
                y: rowY,
                text: `${Number(token.growthRate || 0).toFixed(1)}%`,
                maxWidth: 170
            });
            fillRect(image, 590, rowY - 2, 310, 28, status.color);
            image.print({ font: bodyFont, x: 604, y: rowY + 3, text: status.text, maxWidth: 290 });
        });

        fillRect(image, 28, 820, WIDTH - 56, 500, COLORS.panel);
        image.print({ font: bodyFont, x: 48, y: 842, text: 'Top 10 mais ativos', maxWidth: 260 });
        image.print({ font: bodyFont, x: 48, y: 876, text: 'Posicao', maxWidth: 110 });
        image.print({ font: bodyFont, x: 170, y: 876, text: 'Nome', maxWidth: 360 });
        image.print({ font: bodyFont, x: 580, y: 876, text: 'Mensagens', maxWidth: 200 });

        users.forEach((user, idx) => {
            const rowY = 912 + (idx * 36);
            if (idx % 2 === 0) {
                fillRect(image, 42, rowY - 4, WIDTH - 84, 31, 0x0f2e70ff);
            }
            image.print({ font: bodyFont, x: 48, y: rowY, text: `${(page * 10) + idx + 1}`, maxWidth: 100 });
            image.print({ font: bodyFont, x: 170, y: rowY, text: String(user.name || '-'), maxWidth: 380 });
            image.print({ font: bodyFont, x: 580, y: rowY, text: formatNumber(user.totalMessages), maxWidth: 180 });
        });

        buffers.push(await image.getBuffer('image/png'));
    }

    return buffers;
}
