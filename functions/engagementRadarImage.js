import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp, loadFont } = require('jimp');
const { SANS_16_WHITE, SANS_32_WHITE } = require('@jimp/plugin-print/fonts');

const WIDTH = 1200;
const HEIGHT = 1600;

const COLORS = {
    bgTop: 0x05142eff,
    bgBottom: 0x091f45ff,
    panel: 0x0d2a57ff,
    panelSoft: 0x12356bff,
    rowA: 0x194182ff,
    rowB: 0x14386fff,
    green: 0x22c55eff,
    orange: 0xf59e0bff,
    red: 0xef4444ff,
    gray: 0x94a3b8ff,
    white: 0xffffffff,
    shadow: 0x02081788,
    glow: 0xff5a5a55
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

function fillRoundedRect(image, x, y, w, h, r, color) {
    const radius = Math.max(0, Math.floor(r));
    for (let yy = 0; yy < h; yy += 1) {
        for (let xx = 0; xx < w; xx += 1) {
            const dx = Math.min(xx, w - 1 - xx);
            const dy = Math.min(yy, h - 1 - yy);

            if (dx >= radius || dy >= radius) {
                image.setPixelColor(color, x + xx, y + yy);
                continue;
            }

            const cx = radius - dx;
            const cy = radius - dy;
            if ((cx * cx) + (cy * cy) <= (radius * radius)) {
                image.setPixelColor(color, x + xx, y + yy);
            }
        }
    }
}

function drawCard(image, x, y, w, h, color) {
    fillRoundedRect(image, x + 4, y + 6, w, h, 18, COLORS.shadow);
    fillRoundedRect(image, x, y, w, h, 18, color);
}

function drawGradientBackground(image) {
    for (let y = 0; y < HEIGHT; y += 1) {
        const ratio = y / (HEIGHT - 1);
        const topR = 0x05;
        const topG = 0x14;
        const topB = 0x2e;
        const botR = 0x09;
        const botG = 0x1f;
        const botB = 0x45;

        const r = Math.round(topR + ((botR - topR) * ratio));
        const g = Math.round(topG + ((botG - topG) * ratio));
        const b = Math.round(topB + ((botB - topB) * ratio));
        const color = (r << 24) | (g << 16) | (b << 8) | 0xff;
        fillRect(image, 0, y, WIDTH, 1, color >>> 0);
    }
}

function statusColor(label) {
    if (label === 'QUENTE') return COLORS.red;
    if (label === 'MORNO') return COLORS.orange;
    return COLORS.gray;
}

function trendColor(label) {
    if (label === 'Acelerando') return COLORS.green;
    if (label === 'Estavel') return COLORS.orange;
    return COLORS.gray;
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function formatPct(value) {
    const n = Number(value || 0);
    const prefix = n >= 0 ? '+' : '';
    return `${prefix}${n.toFixed(1)}%`;
}

function topicRowColor(topic, isHighlight) {
    if (isHighlight) return COLORS.glow;
    if (!topic || !topic.visual) return COLORS.rowB;
    if (topic.visual.color === 'red') return 0x7f1d1dff;
    if (topic.visual.color === 'green') return 0x14532dff;
    if (topic.visual.color === 'orange') return 0x78350fff;
    return COLORS.rowB;
}

function drawSoftGrid(image, x, y, w, h) {
    const lineColor = 0x17356366;
    for (let gx = x + 24; gx < x + w; gx += 40) {
        fillRect(image, gx, y + 6, 1, h - 12, lineColor);
    }
    for (let gy = y + 24; gy < y + h; gy += 32) {
        fillRect(image, x + 6, gy, w - 12, 1, lineColor);
    }
}

function drawBar(image, x, y, w, h, pct, color = COLORS.green) {
    fillRoundedRect(image, x, y, w, h, 6, COLORS.rowB);
    const filled = Math.max(6, Math.floor(w * Math.max(0, Math.min(1, pct))));
    fillRoundedRect(image, x, y, filled, h, 6, color);
}

export async function renderEngagementRadarImage(report) {
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const image = new Jimp({ width: WIDTH, height: HEIGHT, color: COLORS.bgTop });
    drawGradientBackground(image);

    drawCard(image, 24, 24, WIDTH - 48, 140, COLORS.panel);
    drawSoftGrid(image, 24, 24, WIDTH - 48, 140);
    image.print({ font: titleFont, x: 48, y: 48, text: 'IMAVY - Radar de Engajamento', maxWidth: 700 });
    image.print({ font: bodyFont, x: 48, y: 108, text: 'Periodo: Ultimas 24h', maxWidth: 280 });

    fillRoundedRect(image, 890, 52, 270, 80, 12, statusColor(report.status?.label));
    image.print({ font: bodyFont, x: 922, y: 84, text: `Status: ${report.status?.label || 'N/D'}`, maxWidth: 230 });

    drawCard(image, 24, 184, WIDTH - 48, 110, COLORS.panelSoft);
    drawSoftGrid(image, 24, 184, WIDTH - 48, 110);
    const tendencia = report.summary?.tendencia || { arrow: 'FLAT', label: 'Estavel', growthPct: 0, description: 'Estavel (0%)' };
    image.print({ font: bodyFont, x: 48, y: 208, text: 'Tendencia Atual do Grupo', maxWidth: 330 });
    fillRoundedRect(image, 360, 202, 280, 56, 10, trendColor(tendencia.label));
    image.print({ font: bodyFont, x: 388, y: 224, text: `${tendencia.arrow} ${tendencia.label} (${formatPct(tendencia.growthPct)})`, maxWidth: 250 });

    const sparkline = String(report.summary?.sparkline || '').slice(-24);
    image.print({ font: bodyFont, x: 680, y: 208, text: 'Evolucao 24h', maxWidth: 160 });
    image.print({ font: bodyFont, x: 680, y: 236, text: sparkline || '......', maxWidth: 300 });

    drawCard(image, 24, 308, WIDTH - 48, 196, COLORS.panelSoft);
    drawSoftGrid(image, 24, 308, WIDTH - 48, 190);
    drawCard(image, 40, 326, 340, 156, COLORS.panel);
    drawCard(image, 396, 326, 340, 156, COLORS.panel);
    drawCard(image, 752, 326, 408, 156, COLORS.panel);

    image.print({ font: titleFont, x: 58, y: 350, text: formatNumber(report.summary?.totalMessages), maxWidth: 220 });
    image.print({ font: bodyFont, x: 58, y: 410, text: 'Mensagens', maxWidth: 180 });

    image.print({ font: titleFont, x: 414, y: 350, text: formatNumber(report.summary?.activeUsers), maxWidth: 220 });
    image.print({ font: bodyFont, x: 414, y: 410, text: 'Participantes ativos', maxWidth: 220 });

    fillRoundedRect(image, 776, 338, 360, 38, 10, statusColor(report.status?.label));
    image.print({ font: bodyFont, x: 804, y: 350, text: `Crescimento: ${formatPct(report.summary?.growthPct)}`, maxWidth: 320 });
    image.print({
        font: bodyFont,
        x: 776,
        y: 382,
        text: `Velocidade: ${(Number(report.summary?.msgPerMin || 0)).toFixed(1)} msg/min | Pico: ${report.summary?.peakWindow || 'N/D'}`,
        maxWidth: 360
    });

    image.print({ font: bodyFont, x: 776, y: 404, text: 'Energia do Grupo', maxWidth: 220 });
    drawBar(image, 776, 424, 300, 14, Number(report.energiaGrupo?.score || 0) / 100, COLORS.green);
    image.print({ font: bodyFont, x: 1082, y: 418, text: `${report.energiaGrupo?.score || 0}%`, maxWidth: 68 });
    image.print({ font: bodyFont, x: 776, y: 444, text: `${report.energiaGrupo?.label || 'Fraco'}`, maxWidth: 160 });
    image.print({ font: bodyFont, x: 776, y: 460, text: 'Baseado em:', maxWidth: 140 });
    image.print({ font: bodyFont, x: 776, y: 474, text: '- Volume de mensagens', maxWidth: 200 });
    image.print({ font: bodyFont, x: 962, y: 474, text: '- Participacao ativa', maxWidth: 200 });
    image.print({ font: bodyFont, x: 776, y: 488, text: '- Aceleracao recente', maxWidth: 200 });

    drawCard(image, 24, 518, 760, 520, COLORS.panel);
    drawSoftGrid(image, 24, 518, 760, 520);
    image.print({ font: bodyFont, x: 48, y: 546, text: 'Top 5 por grupo', maxWidth: 280 });

    const groupsForPanel = (report.topEngagersByGroup || []).slice(0, 3);
    groupsForPanel.forEach((group, groupIdx) => {
        const baseY = 582 + (groupIdx * 152);
        fillRoundedRect(image, 44, baseY, 720, 136, 10, groupIdx % 2 === 0 ? COLORS.rowB : COLORS.rowA);
        image.print({ font: bodyFont, x: 58, y: baseY + 12, text: String(group.groupName || '-'), maxWidth: 460 });

        const topScore = Math.max(1, ...((group.topUsers || []).map((u) => Number(u.totalMessages || 0))));
        (group.topUsers || []).slice(0, 5).forEach((user, userIdx) => {
            const rowY = baseY + 36 + (userIdx * 18);
            image.print({ font: bodyFont, x: 58, y: rowY, text: `${userIdx + 1}. ${String(user.name || '-')}`, maxWidth: 240 });
            drawBar(image, 320, rowY + 3, 280, 10, Number(user.totalMessages || 0) / topScore, COLORS.green);
            image.print({ font: bodyFont, x: 610, y: rowY - 2, text: String(user.totalMessages || 0), maxWidth: 36 });
        });
    });

    drawCard(image, 800, 518, 376, 260, COLORS.panel);
    drawSoftGrid(image, 800, 518, 376, 260);
    image.print({ font: bodyFont, x: 824, y: 546, text: 'Assuntos Quentes', maxWidth: 220 });

    const highlighted = String(report.highlightedTopic?.label || '');
    (report.hotTopics || []).slice(0, 3).forEach((topic, idx) => {
        const y = 582 + (idx * 56);
        const isHighlight = highlighted && topic.label === highlighted;
        fillRoundedRect(image, 822, y, 332, 44, 8, topicRowColor(topic, isHighlight));
        const pct = formatPct(topic.variationPct || 0);
        image.print({
            font: bodyFont,
            x: 836,
            y: y + 14,
            text: `${topic.label} - ${formatNumber(topic.totalMentions)} msgs (${pct} ${topic.visual?.icon || 'FLAT'})`,
            maxWidth: 312
        });
    });

    drawCard(image, 800, 790, 376, 122, COLORS.panel);
    image.print({ font: bodyFont, x: 824, y: 812, text: 'Pico Real Detectado', maxWidth: 220 });
    image.print({ font: bodyFont, x: 824, y: 834, text: `${report.peak?.window || 'N/D'}`, maxWidth: 120 });
    image.print({ font: bodyFont, x: 900, y: 834, text: `+${report.peak?.totalMessages || 0} mensagens`, maxWidth: 240 });
    image.print({ font: bodyFont, x: 900, y: 852, text: `+${report.peak?.activeUsers || 0} usuarios ativos`, maxWidth: 240 });
    image.print({ font: bodyFont, x: 824, y: 870, text: `Velocidade: ${(Number(report.peak?.speedPerMin || 0)).toFixed(1)} msg/min`, maxWidth: 180 });
    image.print({ font: bodyFont, x: 1006, y: 870, text: `Tema: ${report.peak?.dominantToken || 'N/D'}`, maxWidth: 150 });
    image.print({ font: bodyFont, x: 824, y: 888, text: `${formatPct(report.peak?.aboveAveragePct || 0)} acima da media horaria`, maxWidth: 320 });

    drawCard(image, 800, 918, 376, 120, COLORS.panel);
    image.print({ font: bodyFont, x: 824, y: 936, text: 'Radar de Oportunidades', maxWidth: 220 });
    image.print({ font: bodyFont, x: 824, y: 956, text: `Perguntas ignoradas: ${report.opportunities?.ignoredQuestions || 0}`, maxWidth: 330 });
    image.print({ font: bodyFont, x: 824, y: 974, text: `Ativos ontem sem falar hoje: ${report.opportunities?.usersDropOff || 0}`, maxWidth: 330 });
    const accelerating = report.opportunities?.acceleratingToken;
    image.print({ font: bodyFont, x: 824, y: 992, text: accelerating ? `Token acelerando: ${accelerating.label} (${formatPct(accelerating.variationPct)})` : 'Token acelerando: nenhum', maxWidth: 330 });

    drawCard(image, 800, 1044, 376, 84, COLORS.panel);
    image.print({ font: bodyFont, x: 824, y: 1062, text: 'Insight Estrategico', maxWidth: 220 });
    image.print({ font: bodyFont, x: 824, y: 1084, text: String(report.insight || '-'), maxWidth: 330 });

    drawCard(image, 24, 1140, WIDTH - 48, 370, COLORS.panel);
    drawSoftGrid(image, 24, 1140, WIDTH - 48, 370);
    image.print({ font: bodyFont, x: 48, y: 1164, text: 'Top 10 grupos (permitidos)', maxWidth: 280 });
    image.print({ font: bodyFont, x: 48, y: 1196, text: 'Grupo', maxWidth: 460 });
    image.print({ font: bodyFont, x: 860, y: 1196, text: 'Msgs', maxWidth: 80 });
    image.print({ font: bodyFont, x: 970, y: 1196, text: 'Ativos', maxWidth: 80 });

    (report.topGroups || []).slice(0, 10).forEach((group, idx) => {
        const y = 1226 + (idx * 27);
        fillRoundedRect(image, 44, y - 2, WIDTH - 88, 28, 6, idx % 2 === 0 ? COLORS.rowA : COLORS.rowB);
        image.print({ font: bodyFont, x: 52, y: y + 4, text: String(group.groupName || '-'), maxWidth: 760 });
        image.print({ font: bodyFont, x: 860, y: y + 4, text: formatNumber(group.totalMessages), maxWidth: 90 });
        image.print({ font: bodyFont, x: 970, y: y + 4, text: formatNumber(group.activeUsers), maxWidth: 90 });
    });

    drawCard(image, 24, 1520, WIDTH - 48, 56, COLORS.panelSoft);
    image.print({ font: bodyFont, x: 48, y: 1538, text: `Sugestao: ${report.suggestion || '-'}`, maxWidth: WIDTH - 96 });

    return await image.getBuffer('image/png');
}
