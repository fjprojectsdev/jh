import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp, loadFont } = require('jimp');
const { SANS_16_WHITE, SANS_32_WHITE } = require('@jimp/plugin-print/fonts');

const WIDTH = 1200;
const HEIGHT = 1600;

const COLORS = {
    bgTop: 0x05142eff,
    bgBottom: 0x091f45ff,
    panel: 0x0c2a56ff,
    panelSoft: 0x12366eff,
    panelDeep: 0x0a2249ff,
    rowA: 0x1a4387ff,
    rowB: 0x153770ff,
    green: 0x22c55eff,
    orange: 0xf59e0bff,
    red: 0xef4444ff,
    gray: 0x94a3b8ff,
    cyan: 0x38bdf8ff,
    border: 0x2d5caeff,
    borderSoft: 0x284c89cc,
    track: 0x102f5fff,
    glowBlue: 0x60a5fa55,
    topGlow: 0xffffff1f,
    white: 0xffffffff,
    shadow: 0x020817a8,
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

function drawCard(image, x, y, w, h, color, options = {}) {
    const radius = Math.max(4, Number(options.radius || 18));
    const borderColor = options.borderColor || COLORS.borderSoft;
    const shadowColor = options.shadowColor || COLORS.shadow;
    const inset = 2;
    const innerW = Math.max(1, w - (inset * 2));
    const innerH = Math.max(1, h - (inset * 2));

    fillRoundedRect(image, x + 4, y + 7, w, h, radius, shadowColor);
    fillRoundedRect(image, x, y, w, h, radius, borderColor);
    fillRoundedRect(image, x + inset, y + inset, innerW, innerH, Math.max(2, radius - inset), color);

    if (innerW > 40 && innerH > 14) {
        fillRoundedRect(image, x + inset + 2, y + inset + 2, innerW - 4, 6, 3, COLORS.topGlow);
    }
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

function ellipsize(text, maxChars) {
    const safe = String(text || '').replace(/\s+/g, ' ').trim();
    const limit = Math.max(3, Number(maxChars) || 3);
    if (safe.length <= limit) {
        return safe;
    }
    return `${safe.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function splitLines(text, maxCharsPerLine, maxLines) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    const maxChars = Math.max(8, Number(maxCharsPerLine) || 8);
    const capLines = Math.max(1, Number(maxLines) || 1);

    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxChars) {
            current = candidate;
            continue;
        }

        if (current) {
            lines.push(current);
            if (lines.length >= capLines) {
                break;
            }
        }

        if (word.length > maxChars) {
            lines.push(ellipsize(word, maxChars));
            current = '';
        } else {
            current = word;
        }

        if (lines.length >= capLines) {
            break;
        }
    }

    if (lines.length < capLines && current) {
        lines.push(current);
    }

    if (lines.length > capLines) {
        lines.length = capLines;
    }

    const consumedWords = lines.join(' ').split(' ').filter(Boolean).length;
    if (consumedWords < words.length && lines.length > 0) {
        lines[lines.length - 1] = ellipsize(lines[lines.length - 1], maxChars);
    }

    return lines.length > 0 ? lines : ['-'];
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
    const lineColor = 0x244a8a55;
    for (let gx = x + 24; gx < x + w; gx += 40) {
        fillRect(image, gx, y + 6, 1, h - 12, lineColor);
    }
    for (let gy = y + 24; gy < y + h; gy += 32) {
        fillRect(image, x + 6, gy, w - 12, 1, lineColor);
    }
}

function drawBar(image, x, y, w, h, pct, color = COLORS.green) {
    fillRoundedRect(image, x, y, w, h, 6, COLORS.track);
    const safePct = Math.max(0, Math.min(1, Number(pct || 0)));
    if (safePct <= 0) {
        return;
    }
    const filled = Math.max(6, Math.floor(w * safePct));
    fillRoundedRect(image, x, y, filled, h, 6, color);
}

function drawMiniBars(image, x, y, w, h, values) {
    const safeValues = Array.isArray(values)
        ? values.map((v) => Math.max(0, Number(v || 0))).slice(-24)
        : [];

    drawCard(image, x, y, w, h, COLORS.panelDeep, {
        radius: 10,
        borderColor: COLORS.borderSoft,
        shadowColor: 0x01040c66
    });

    if (safeValues.length === 0) {
        return;
    }

    const max = Math.max(1, ...safeValues);
    const leftPad = 8;
    const rightPad = 8;
    const bottomPad = 6;
    const topPad = 10;
    const contentW = Math.max(12, w - leftPad - rightPad);
    const contentH = Math.max(12, h - topPad - bottomPad);
    const gap = 2;
    const barW = Math.max(3, Math.floor((contentW - ((safeValues.length - 1) * gap)) / safeValues.length));

    safeValues.forEach((value, idx) => {
        const barH = Math.max(3, Math.round((value / max) * contentH));
        const barX = x + leftPad + (idx * (barW + gap));
        const barY = y + h - bottomPad - barH;
        const color = idx >= safeValues.length - 4 ? COLORS.green : COLORS.cyan;
        fillRoundedRect(image, barX, barY, barW, barH, 2, color);
    });
}

export async function renderEngagementRadarImage(report) {
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const image = new Jimp({ width: WIDTH, height: HEIGHT, color: COLORS.bgTop });
    drawGradientBackground(image);

    drawCard(image, 24, 24, WIDTH - 48, 144, COLORS.panel, { borderColor: COLORS.border });
    drawSoftGrid(image, 24, 24, WIDTH - 48, 144);
    fillRoundedRect(image, 42, 44, 6, 104, 3, COLORS.glowBlue);
    image.print({ font: titleFont, x: 58, y: 50, text: 'IMAVY - Radar de Engajamento', maxWidth: 700 });
    image.print({ font: bodyFont, x: 58, y: 112, text: 'Periodo: Ultimas 24h', maxWidth: 280 });

    const statusLabel = report.status?.label || 'N/D';
    const statusTone = statusColor(statusLabel);
    drawCard(image, 874, 48, 286, 90, COLORS.panelDeep, { radius: 14, borderColor: statusTone });
    image.print({ font: bodyFont, x: 898, y: 66, text: 'Status atual', maxWidth: 180 });
    fillRoundedRect(image, 898, 88, 180, 28, 8, statusTone);
    image.print({ font: bodyFont, x: 920, y: 96, text: statusLabel, maxWidth: 140 });

    drawCard(image, 24, 184, WIDTH - 48, 118, COLORS.panelSoft, { borderColor: COLORS.borderSoft });
    drawSoftGrid(image, 24, 184, WIDTH - 48, 118);
    const tendencia = report.summary?.tendencia || { arrow: 'FLAT', label: 'Estavel', growthPct: 0, description: 'Estavel (0%)' };
    image.print({ font: bodyFont, x: 48, y: 208, text: 'Tendencia Atual do Grupo', maxWidth: 330 });
    drawCard(image, 348, 198, 300, 64, COLORS.panelDeep, { radius: 12, borderColor: trendColor(tendencia.label) });
    image.print({ font: bodyFont, x: 374, y: 224, text: `${tendencia.arrow} ${tendencia.label} (${formatPct(tendencia.growthPct)})`, maxWidth: 260 });

    const sparkline = String(report.summary?.sparkline || '').slice(-24);
    const hourlySeries = Array.isArray(report.summary?.hourlySeries) ? report.summary.hourlySeries : [];
    image.print({ font: bodyFont, x: 680, y: 208, text: 'Evolucao 24h', maxWidth: 160 });
    drawMiniBars(image, 760, 198, 394, 90, hourlySeries);
    image.print({ font: bodyFont, x: 680, y: 272, text: sparkline || '......', maxWidth: 460 });

    drawCard(image, 24, 308, WIDTH - 48, 196, COLORS.panelSoft, { borderColor: COLORS.borderSoft });
    drawSoftGrid(image, 24, 308, WIDTH - 48, 190);
    drawCard(image, 40, 326, 340, 156, COLORS.panelDeep, { borderColor: COLORS.borderSoft });
    drawCard(image, 396, 326, 340, 156, COLORS.panelDeep, { borderColor: COLORS.borderSoft });
    drawCard(image, 752, 326, 408, 156, COLORS.panelDeep, { borderColor: COLORS.borderSoft });

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
    fillRect(image, 776, 402, 360, 1, COLORS.borderSoft);

    image.print({ font: bodyFont, x: 776, y: 404, text: 'Energia do Grupo', maxWidth: 220 });
    drawBar(image, 776, 424, 300, 14, Number(report.energiaGrupo?.score || 0) / 100, COLORS.green);
    image.print({ font: bodyFont, x: 1082, y: 418, text: `${report.energiaGrupo?.score || 0}%`, maxWidth: 68 });
    image.print({ font: bodyFont, x: 776, y: 444, text: `${report.energiaGrupo?.label || 'Fraco'}`, maxWidth: 160 });
    image.print({ font: bodyFont, x: 776, y: 460, text: 'Baseado em:', maxWidth: 140 });
    image.print({ font: bodyFont, x: 776, y: 474, text: '- Volume de mensagens', maxWidth: 200 });
    image.print({ font: bodyFont, x: 962, y: 474, text: '- Participacao ativa', maxWidth: 200 });
    image.print({ font: bodyFont, x: 776, y: 488, text: '- Aceleracao recente', maxWidth: 200 });

    drawCard(image, 24, 518, 760, 520, COLORS.panel, { borderColor: COLORS.borderSoft });
    drawSoftGrid(image, 24, 518, 760, 520);
    image.print({ font: bodyFont, x: 48, y: 546, text: 'Top 5 por grupo', maxWidth: 280 });

    const groupsForPanel = (report.topEngagersByGroup || []).slice(0, 3);
    while (groupsForPanel.length < 3) {
        groupsForPanel.push({
            groupName: 'Sem dados no periodo',
            topUsers: []
        });
    }

    groupsForPanel.forEach((group, groupIdx) => {
        const baseY = 582 + (groupIdx * 152);
        drawCard(image, 44, baseY, 720, 136, groupIdx % 2 === 0 ? COLORS.rowB : COLORS.rowA, {
            radius: 10,
            borderColor: COLORS.borderSoft,
            shadowColor: 0x01040c66
        });
        image.print({ font: bodyFont, x: 58, y: baseY + 12, text: String(group.groupName || '-'), maxWidth: 460 });

        const topScore = Math.max(1, ...((group.topUsers || []).map((u) => Number(u.totalMessages || 0))));
        const users = (group.topUsers || []).slice(0, 5);
        if (users.length === 0) {
            image.print({ font: bodyFont, x: 58, y: baseY + 56, text: 'Sem participantes relevantes neste intervalo.', maxWidth: 420 });
            return;
        }

        users.forEach((user, userIdx) => {
            const rowY = baseY + 36 + (userIdx * 18);
            image.print({ font: bodyFont, x: 58, y: rowY, text: `${userIdx + 1}. ${String(user.name || '-')}`, maxWidth: 240 });
            drawBar(image, 320, rowY + 3, 280, 10, Number(user.totalMessages || 0) / topScore, COLORS.green);
            image.print({ font: bodyFont, x: 610, y: rowY - 2, text: String(user.totalMessages || 0), maxWidth: 36 });
        });
    });

    drawCard(image, 800, 518, 376, 260, COLORS.panel, { borderColor: COLORS.borderSoft });
    drawSoftGrid(image, 800, 518, 376, 260);
    image.print({ font: bodyFont, x: 824, y: 546, text: 'Assuntos Quentes', maxWidth: 220 });

    const highlighted = String(report.highlightedTopic?.label || '');
    const hotTopics = (report.hotTopics || []).slice(0, 3);
    if (hotTopics.length === 0) {
        drawCard(image, 822, 582, 332, 52, COLORS.rowB, { radius: 8, borderColor: COLORS.borderSoft, shadowColor: 0x01040c44 });
        image.print({ font: bodyFont, x: 836, y: 600, text: 'Sem topicos quentes no periodo.', maxWidth: 310 });
    }

    hotTopics.forEach((topic, idx) => {
        const y = 582 + (idx * 56);
        const isHighlight = highlighted && topic.label === highlighted;
        drawCard(image, 822, y, 332, 44, topicRowColor(topic, isHighlight), {
            radius: 8,
            borderColor: COLORS.borderSoft,
            shadowColor: 0x01040c44
        });
        const pct = formatPct(topic.variationPct || 0);
        const rowText = ellipsize(
            `${topic.label} - ${formatNumber(topic.totalMentions)} msgs (${pct} ${topic.visual?.icon || 'FLAT'})`,
            48
        );
        image.print({
            font: bodyFont,
            x: 836,
            y: y + 14,
            text: rowText,
            maxWidth: 312
        });
    });

    drawCard(image, 800, 790, 376, 122, COLORS.panel, { borderColor: COLORS.borderSoft });
    image.print({ font: bodyFont, x: 824, y: 812, text: 'Pico Real Detectado', maxWidth: 220 });
    image.print({ font: bodyFont, x: 824, y: 834, text: `${report.peak?.window || 'N/D'}`, maxWidth: 120 });
    image.print({ font: bodyFont, x: 900, y: 834, text: `+${report.peak?.totalMessages || 0} mensagens`, maxWidth: 240 });
    image.print({ font: bodyFont, x: 900, y: 852, text: `+${report.peak?.activeUsers || 0} usuarios ativos`, maxWidth: 240 });
    image.print({ font: bodyFont, x: 824, y: 870, text: `Velocidade: ${(Number(report.peak?.speedPerMin || 0)).toFixed(1)} msg/min`, maxWidth: 180 });
    image.print({ font: bodyFont, x: 1006, y: 870, text: `Tema: ${report.peak?.dominantToken || 'N/D'}`, maxWidth: 150 });
    image.print({ font: bodyFont, x: 824, y: 888, text: `${formatPct(report.peak?.aboveAveragePct || 0)} acima da media horaria`, maxWidth: 320 });

    drawCard(image, 800, 918, 376, 120, COLORS.panel, { borderColor: COLORS.borderSoft });
    image.print({ font: bodyFont, x: 824, y: 936, text: 'Radar de Oportunidades', maxWidth: 220 });
    image.print({ font: bodyFont, x: 824, y: 956, text: `Perguntas ignoradas: ${report.opportunities?.ignoredQuestions || 0}`, maxWidth: 330 });
    image.print({ font: bodyFont, x: 824, y: 974, text: `Ativos ontem sem falar hoje: ${report.opportunities?.usersDropOff || 0}`, maxWidth: 330 });
    const accelerating = report.opportunities?.acceleratingToken;
    image.print({ font: bodyFont, x: 824, y: 992, text: accelerating ? `Token acelerando: ${accelerating.label} (${formatPct(accelerating.variationPct)})` : 'Token acelerando: nenhum', maxWidth: 330 });

    drawCard(image, 800, 1044, 376, 84, COLORS.panel, { borderColor: COLORS.borderSoft });
    image.print({ font: bodyFont, x: 824, y: 1062, text: 'Insight Estrategico', maxWidth: 220 });
    const insightLines = splitLines(String(report.insight || '-'), 44, 2);
    insightLines.forEach((line, idx) => {
        image.print({ font: bodyFont, x: 824, y: 1084 + (idx * 16), text: line, maxWidth: 330 });
    });

    drawCard(image, 24, 1140, WIDTH - 48, 370, COLORS.panel, { borderColor: COLORS.borderSoft });
    drawSoftGrid(image, 24, 1140, WIDTH - 48, 370);
    image.print({ font: bodyFont, x: 48, y: 1164, text: 'Top 10 grupos considerados', maxWidth: 320 });
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
    image.print({ font: bodyFont, x: 48, y: 1538, text: `Sugestao: ${ellipsize(report.suggestion || '-', 152)}`, maxWidth: WIDTH - 96 });

    return await image.getBuffer('image/png');
}
