import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp, loadFont } = require('jimp');
const { SANS_16_WHITE, SANS_32_WHITE } = require('@jimp/plugin-print/fonts');

const WIDTH = 1200;
const HEIGHT = 1600;

const COLORS = {
    bg: 0x071934ff,
    panel: 0x0d2a57ff,
    panelSoft: 0x12356bff,
    rowA: 0x194182ff,
    rowB: 0x14386fff,
    green: 0x22c55eff,
    red: 0xef4444ff,
    yellow: 0xf59e0bff,
    white: 0xffffffff,
    muted: 0x9ca3afff
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

function pctColor(value) {
    return Number(value || 0) >= 0 ? COLORS.green : COLORS.red;
}

function statusColor(label) {
    if (label === 'QUENTE') return COLORS.red;
    if (label === 'MORNO') return COLORS.yellow;
    return COLORS.muted;
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function formatPct(value) {
    const n = Number(value || 0);
    const prefix = n >= 0 ? '+' : '';
    return `${prefix}${n.toFixed(1)}%`;
}

function drawBar(image, x, y, w, h, pct) {
    fillRect(image, x, y, w, h, COLORS.rowB);
    const filled = Math.max(6, Math.floor(w * Math.max(0, Math.min(1, pct))));
    fillRect(image, x, y, filled, h, COLORS.green);
}

export async function renderEngagementRadarImage(report) {
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const image = new Jimp({ width: WIDTH, height: HEIGHT, color: COLORS.bg });

    fillRect(image, 24, 24, WIDTH - 48, 150, COLORS.panel);
    image.print({ font: titleFont, x: 48, y: 54, text: 'IMAVY - Radar de Engajamento', maxWidth: 700 });
    image.print({ font: bodyFont, x: 48, y: 112, text: 'Periodo: Ultimas 24h', maxWidth: 260 });

    fillRect(image, 860, 54, 300, 86, statusColor(report.status.label));
    image.print({ font: bodyFont, x: 900, y: 86, text: `Status: ${report.status.label}`, maxWidth: 230 });

    fillRect(image, 24, 194, WIDTH - 48, 190, COLORS.panelSoft);
    fillRect(image, 40, 222, 350, 130, COLORS.panel);
    fillRect(image, 420, 222, 350, 130, COLORS.panel);
    fillRect(image, 800, 222, 360, 130, COLORS.panel);

    image.print({ font: titleFont, x: 58, y: 250, text: formatNumber(report.summary.totalMessages), maxWidth: 220 });
    image.print({ font: bodyFont, x: 58, y: 308, text: 'Mensagens', maxWidth: 180 });

    image.print({ font: titleFont, x: 438, y: 250, text: formatNumber(report.summary.activeUsers), maxWidth: 220 });
    image.print({ font: bodyFont, x: 438, y: 308, text: 'Participantes ativos', maxWidth: 220 });

    fillRect(image, 816, 250, 320, 54, pctColor(report.summary.growthPct));
    image.print({ font: titleFont, x: 848, y: 258, text: formatPct(report.summary.growthPct), maxWidth: 280 });
    image.print({ font: bodyFont, x: 848, y: 314, text: 'Crescimento', maxWidth: 200 });

    image.print({
        font: bodyFont,
        x: 48,
        y: 356,
        text: `Velocidade: ${report.summary.msgPerMin.toFixed(1)} msg/min  |  Pico: ${report.summary.peakWindow}`,
        maxWidth: WIDTH - 96
    });

    fillRect(image, 24, 404, 650, 560, COLORS.panel);
    image.print({ font: bodyFont, x: 48, y: 432, text: 'Top Engajadores', maxWidth: 280 });
    const topScore = Math.max(1, ...(report.topEngagers || []).map((u) => Number(u.totalMessages || 0)));
    (report.topEngagers || []).slice(0, 5).forEach((user, idx) => {
        const y = 476 + (idx * 95);
        image.print({ font: bodyFont, x: 48, y, text: String(user.name || '-'), maxWidth: 250 });
        drawBar(image, 300, y + 10, 320, 24, Number(user.totalMessages || 0) / topScore);
        image.print({ font: bodyFont, x: 630, y: y + 8, text: String(user.totalMessages || 0), maxWidth: 60 });
    });

    fillRect(image, 698, 404, 478, 280, COLORS.panel);
    image.print({ font: bodyFont, x: 722, y: 432, text: 'Assuntos Quentes', maxWidth: 220 });
    (report.hotTopics || []).slice(0, 3).forEach((topic, idx) => {
        const y = 472 + (idx * 62);
        fillRect(image, 722, y - 4, 430, 42, idx % 2 === 0 ? COLORS.rowA : COLORS.rowB);
        image.print({
            font: bodyFont,
            x: 738,
            y: y + 6,
            text: `${topic.label} - ${formatNumber(topic.count)} msgs`,
            maxWidth: 395
        });
    });

    fillRect(image, 698, 704, 478, 260, COLORS.panel);
    image.print({ font: bodyFont, x: 722, y: 732, text: 'Oportunidades', maxWidth: 180 });
    image.print({ font: bodyFont, x: 722, y: 770, text: `Perguntas sem resposta: ${report.opportunities.unansweredQuestions}`, maxWidth: 430 });
    image.print({ font: bodyFont, x: 722, y: 810, text: `Usuarios em queda: ${report.opportunities.reducedActivityUsers}`, maxWidth: 430 });

    fillRect(image, 24, 988, WIDTH - 48, 580, COLORS.panel);
    image.print({ font: bodyFont, x: 48, y: 1018, text: 'Top 10 grupos (permitidos)', maxWidth: 280 });
    image.print({ font: bodyFont, x: 48, y: 1056, text: 'Grupo', maxWidth: 340 });
    image.print({ font: bodyFont, x: 820, y: 1056, text: 'Msgs', maxWidth: 80 });
    image.print({ font: bodyFont, x: 930, y: 1056, text: 'Ativos', maxWidth: 80 });
    (report.topGroups || []).slice(0, 10).forEach((group, idx) => {
        const y = 1092 + (idx * 42);
        fillRect(image, 44, y - 2, WIDTH - 88, 34, idx % 2 === 0 ? COLORS.rowA : COLORS.rowB);
        image.print({ font: bodyFont, x: 50, y: y + 6, text: String(group.groupName || '-'), maxWidth: 760 });
        image.print({ font: bodyFont, x: 820, y: y + 6, text: formatNumber(group.totalMessages), maxWidth: 90 });
        image.print({ font: bodyFont, x: 930, y: y + 6, text: formatNumber(group.activeUsers), maxWidth: 90 });
    });

    fillRect(image, 24, 1508, WIDTH - 48, 70, COLORS.panelSoft);
    image.print({ font: bodyFont, x: 48, y: 1532, text: `Sugestao: ${report.suggestion}`, maxWidth: WIDTH - 96 });

    return await image.getBuffer('image/png');
}
