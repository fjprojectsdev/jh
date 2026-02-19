import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp, loadFont } = require('jimp');
const { SANS_16_WHITE, SANS_32_WHITE } = require('@jimp/plugin-print/fonts');

const WIDTH = 1200;
const HEIGHT = 1600;

const COLORS = {
    bgTop: 0x05142eff,
    bgBottom: 0x091f45ff,
    panel: 0x13284dff,
    panelSoft: 0x17315bff,
    panelDeep: 0x0e2445ff,
    panelInset: 0x0b1b36ff,
    rowA: 0x1c3d73ff,
    rowB: 0x193564ff,
    success: 0x34d399ff,
    danger: 0xf87171ff,
    warning: 0xfbbf24ff,
    info: 0x60a5faff,
    insight: 0x8b5cf6ff,
    green: 0x34d399ff,
    orange: 0xfbbf24ff,
    red: 0xf87171ff,
    gray: 0x94a3b8ff,
    cyan: 0x38bdf8ff,
    border: 0x335b98dd,
    borderSoft: 0x2b4d84aa,
    track: 0x122a4eff,
    glowBlue: 0x60a5fa4a,
    topGlow: 0xffffff14,
    white: 0xffffffff,
    shadow: 0x0106117a,
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
    const radius = Math.max(6, Number(options.radius || 16));
    const borderColor = options.borderColor || COLORS.borderSoft;
    const shadowColor = options.shadowColor || COLORS.shadow;
    const inset = 1;
    const innerW = Math.max(1, w - (inset * 2));
    const innerH = Math.max(1, h - (inset * 2));

    fillRoundedRect(image, x + 2, y + 4, w, h, radius, shadowColor);
    fillRoundedRect(image, x, y, w, h, radius, borderColor);
    fillRoundedRect(image, x + inset, y + inset, innerW, innerH, Math.max(2, radius - inset), color);

    if (innerW > 40 && innerH > 14) {
        fillRoundedRect(image, x + inset + 2, y + inset + 2, innerW - 4, 4, 2, COLORS.topGlow);
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
    if (label === 'QUENTE') return COLORS.success;
    if (label === 'MORNO') return COLORS.warning;
    return COLORS.info;
}

function trendColor(label) {
    if (label === 'Acelerando') return COLORS.success;
    if (label === 'Estavel') return COLORS.info;
    return COLORS.warning;
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function formatPct(value) {
    const n = Number(value || 0);
    const prefix = n >= 0 ? '+' : '';
    return `${prefix}${n.toFixed(1)}%`;
}

function formatPctCompact(value) {
    const n = Number(value || 0);
    const abs = Math.abs(n);
    const prefix = n >= 0 ? '+' : '-';

    if (abs >= 10000) {
        return `${prefix}${Math.round(abs / 1000)}k%`;
    }
    if (abs >= 1000) {
        return `${prefix}${(abs / 1000).toFixed(1)}k%`;
    }
    if (abs >= 100) {
        return `${prefix}${abs.toFixed(0)}%`;
    }
    return `${prefix}${abs.toFixed(1)}%`;
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

function growthColor(value) {
    const n = Number(value || 0);
    if (n > 0) return COLORS.success;
    if (n < 0) return COLORS.danger;
    return COLORS.info;
}

function energyColor(score) {
    const n = Number(score || 0);
    if (n >= 70) return COLORS.success;
    if (n >= 40) return COLORS.warning;
    return COLORS.info;
}

function topicStatus(topic) {
    const variation = Number(topic && topic.variationPct || 0);
    const icon = String(topic && topic.visual && topic.visual.icon || '').toUpperCase();
    if (icon === 'BOOM' || icon === 'ALERT' || variation >= 8) {
        return { label: 'ALRT', color: COLORS.danger, icon: '!' };
    }
    if (variation > 0) {
        return { label: 'UP', color: COLORS.success, icon: '+' };
    }
    if (variation < 0) {
        return { label: 'DOWN', color: COLORS.warning, icon: '-' };
    }
    return { label: 'FLT', color: COLORS.info, icon: '=' };
}

function drawSoftGrid(image, x, y, w, h) {
    const lineColor = 0x2e4f8750;
    for (let gx = x + 24; gx < x + w; gx += 40) {
        fillRect(image, gx, y + 6, 1, h - 12, lineColor);
    }
    for (let gy = y + 24; gy < y + h; gy += 32) {
        fillRect(image, x + 6, gy, w - 12, 1, lineColor);
    }
}

function drawDashedHLine(image, x, y, w, dash, gap, color) {
    const safeDash = Math.max(1, Number(dash || 1));
    const safeGap = Math.max(0, Number(gap || 0));
    for (let dx = 0; dx < w; dx += (safeDash + safeGap)) {
        fillRect(image, x + dx, y, Math.min(safeDash, w - dx), 1, color);
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

    drawCard(image, x, y, w, h, COLORS.panelInset, {
        radius: 10,
        borderColor: COLORS.info,
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
    const avg = safeValues.reduce((sum, n) => sum + n, 0) / safeValues.length;
    const avgBarH = Math.max(2, Math.round((avg / max) * contentH));
    const avgY = y + h - bottomPad - avgBarH;
    drawDashedHLine(image, x + leftPad, avgY, contentW, 6, 4, 0x7dd3fc99);

    const peakValue = Math.max(...safeValues);
    const peakIndex = safeValues.findIndex((v) => v === peakValue);

    safeValues.forEach((value, idx) => {
        const barH = Math.max(3, Math.round((value / max) * contentH));
        const barX = x + leftPad + (idx * (barW + gap));
        const barY = y + h - bottomPad - barH;
        const isPeak = idx === peakIndex;
        const color = isPeak ? COLORS.warning : (idx >= safeValues.length - 4 ? COLORS.success : COLORS.cyan);
        if (isPeak) {
            fillRect(image, barX, y + topPad, Math.max(1, barW), contentH, 0xfbbf2418);
        }
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
    drawCard(image, 40, 326, 340, 156, COLORS.panelDeep, { borderColor: COLORS.borderSoft, radius: 14 });
    drawCard(image, 396, 326, 340, 156, COLORS.panelDeep, { borderColor: COLORS.borderSoft, radius: 14 });
    drawCard(image, 752, 326, 408, 156, COLORS.panelDeep, { borderColor: COLORS.borderSoft, radius: 14 });

    image.print({ font: titleFont, x: 58, y: 350, text: formatNumber(report.summary?.totalMessages), maxWidth: 220 });
    image.print({ font: bodyFont, x: 58, y: 410, text: 'Mensagens', maxWidth: 180 });

    image.print({ font: titleFont, x: 414, y: 350, text: formatNumber(report.summary?.activeUsers), maxWidth: 220 });
    image.print({ font: bodyFont, x: 414, y: 410, text: 'Participantes ativos', maxWidth: 220 });

    const growthPct = Number(report.summary?.growthPct || 0);
    const growthTone = growthColor(growthPct);
    const growthPrefix = growthPct > 0 ? '▲ ' : (growthPct < 0 ? '▼ ' : '= ');

    drawCard(image, 770, 338, 368, 62, COLORS.panelInset, { borderColor: growthTone, radius: 12 });
    image.print({ font: titleFont, x: 784, y: 344, text: `${growthPrefix}${formatPctCompact(growthPct)}`, maxWidth: 210 });
    image.print({ font: bodyFont, x: 786, y: 374, text: 'Crescimento do Grupo', maxWidth: 206 });

    fillRect(image, 776, 406, 352, 1, COLORS.borderSoft);

    drawCard(image, 776, 414, 108, 58, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10, shadowColor: 0x01040c4d });
    image.print({ font: bodyFont, x: 788, y: 425, text: 'Velocidade', maxWidth: 88 });
    image.print({ font: bodyFont, x: 788, y: 442, text: `${(Number(report.summary?.msgPerMin || 0)).toFixed(1)} msg/min`, maxWidth: 96 });

    drawCard(image, 894, 414, 108, 58, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10, shadowColor: 0x01040c4d });
    image.print({ font: bodyFont, x: 908, y: 425, text: 'Pico', maxWidth: 70 });
    image.print({ font: bodyFont, x: 908, y: 442, text: `${report.summary?.peakWindow || 'N/D'}`, maxWidth: 90 });

    drawCard(image, 1012, 414, 126, 58, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10, shadowColor: 0x01040c4d });
    image.print({ font: bodyFont, x: 1024, y: 425, text: 'Energia', maxWidth: 74 });
    image.print({ font: bodyFont, x: 1024, y: 442, text: `${report.energiaGrupo?.score || 0}%`, maxWidth: 44 });
    fillRoundedRect(image, 1068, 440, 56, 18, 8, energyColor(report.energiaGrupo?.score || 0));
    image.print({ font: bodyFont, x: 1078, y: 444, text: ellipsize(report.energiaGrupo?.label || 'Fraco', 7), maxWidth: 42 });

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

    drawCard(image, 800, 518, 376, 260, COLORS.panel, { borderColor: COLORS.borderSoft, radius: 14 });
    drawSoftGrid(image, 800, 518, 376, 260);
    image.print({ font: bodyFont, x: 824, y: 546, text: 'Assuntos Quentes', maxWidth: 220 });
    drawCard(image, 818, 574, 340, 186, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10, shadowColor: 0x01040c44 });

    image.print({ font: bodyFont, x: 836, y: 592, text: 'Tema', maxWidth: 92 });
    image.print({ font: bodyFont, x: 946, y: 592, text: 'Msgs', maxWidth: 42 });
    image.print({ font: bodyFont, x: 1032, y: 592, text: 'Var', maxWidth: 42 });
    image.print({ font: bodyFont, x: 1106, y: 592, text: 'St', maxWidth: 32 });
    fillRect(image, 832, 610, 320, 1, COLORS.borderSoft);

    const highlighted = String(report.highlightedTopic?.label || '');
    const hotTopics = (report.hotTopics || []).slice(0, 3);
    if (hotTopics.length === 0) {
        image.print({ font: bodyFont, x: 836, y: 646, text: 'Sem topicos quentes no periodo.', maxWidth: 300 });
    }

    hotTopics.forEach((topic, idx) => {
        const y = 618 + (idx * 46);
        const isHighlight = highlighted && topic.label === highlighted;
        drawCard(image, 826, y, 324, 40, COLORS.panelDeep, {
            radius: 8,
            borderColor: isHighlight ? COLORS.warning : COLORS.borderSoft,
            shadowColor: 0x01040c3f
        });
        if (isHighlight) {
            fillRoundedRect(image, 830, y + 8, 4, 24, 2, COLORS.warning);
        }

        const status = topicStatus(topic);
        image.print({ font: bodyFont, x: 838, y: y + 12, text: ellipsize(topic.label, 12), maxWidth: 98 });
        image.print({ font: bodyFont, x: 968, y: y + 12, text: formatNumber(topic.totalMentions), maxWidth: 42 });
        image.print({ font: bodyFont, x: 1032, y: y + 12, text: formatPct(topic.variationPct || 0), maxWidth: 64 });
        fillRoundedRect(image, 1114, y + 9, 30, 22, 7, status.color);
        image.print({ font: bodyFont, x: 1123, y: y + 14, text: `${status.icon}`, maxWidth: 10 });
    });

    drawCard(image, 800, 790, 376, 122, COLORS.panelDeep, { borderColor: COLORS.warning, radius: 14 });
    image.print({ font: bodyFont, x: 824, y: 808, text: 'Pico Real Detectado', maxWidth: 220 });
    image.print({ font: bodyFont, x: 824, y: 830, text: `TIME ${report.peak?.window || 'N/D'}`, maxWidth: 162 });
    image.print({ font: bodyFont, x: 824, y: 850, text: `MSGS +${report.peak?.totalMessages || 0}`, maxWidth: 162 });
    image.print({ font: bodyFont, x: 824, y: 870, text: `USERS +${report.peak?.activeUsers || 0}`, maxWidth: 170 });
    image.print({ font: bodyFont, x: 824, y: 888, text: `Tema: ${report.peak?.dominantToken || 'N/D'}`, maxWidth: 166 });

    const peakPct = formatPctCompact(report.peak?.aboveAveragePct || 0);
    const peakTone = growthColor(report.peak?.aboveAveragePct || 0);
    drawCard(image, 1000, 822, 160, 72, COLORS.panelInset, { borderColor: peakTone, radius: 12, shadowColor: 0x01040c40 });
    image.print({ font: titleFont, x: 1012, y: 830, text: peakPct, maxWidth: 136 });
    image.print({ font: bodyFont, x: 1020, y: 868, text: 'vs media', maxWidth: 120 });

    drawCard(image, 800, 918, 376, 120, COLORS.panel, { borderColor: COLORS.borderSoft, radius: 14 });
    image.print({ font: bodyFont, x: 824, y: 936, text: 'Radar de Oportunidades', maxWidth: 220 });
    const accelerating = report.opportunities?.acceleratingToken;
    const opportunityRows = [
        { color: COLORS.warning, icon: '?', label: 'Perguntas ignoradas', value: String(report.opportunities?.ignoredQuestions || 0) },
        { color: COLORS.info, icon: 'O', label: 'Ativos ontem sem falar', value: String(report.opportunities?.usersDropOff || 0) },
        {
            color: COLORS.success,
            icon: '^',
            label: 'Token acelerando',
            value: accelerating ? ellipsize(`${accelerating.label} ${formatPct(accelerating.variationPct)}`, 12) : '0'
        }
    ];

    opportunityRows.forEach((item, idx) => {
        const y = 952 + (idx * 28);
        drawCard(image, 822, y, 332, 24, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 8, shadowColor: 0x01040c33 });
        fillRoundedRect(image, 830, y + 7, 10, 10, 5, item.color);
        image.print({ font: bodyFont, x: 846, y: y + 6, text: item.label, maxWidth: 198 });
        image.print({ font: bodyFont, x: 1080, y: y + 6, text: item.value, maxWidth: 72 });
    });

    drawCard(image, 800, 1044, 376, 84, 0x2b2350ff, { borderColor: COLORS.insight, radius: 14 });
    image.print({ font: bodyFont, x: 824, y: 1060, text: 'Insight Estrategico', maxWidth: 220 });
    image.print({ font: bodyFont, x: 824, y: 1080, text: ellipsize(String(report.insight || '-'), 62), maxWidth: 330 });
    drawCard(image, 1000, 1096, 156, 22, 0x4b3e86ff, { borderColor: 0xb4a6ffff, radius: 8, shadowColor: 0x01040c33 });
    image.print({ font: bodyFont, x: 1012, y: 1102, text: 'Ver analise detalhada', maxWidth: 132 });

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

