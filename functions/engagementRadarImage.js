import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp, loadFont } = require('jimp');
const { SANS_16_WHITE, SANS_32_WHITE } = require('@jimp/plugin-print/fonts');

const WIDTH = 1200;
const HEIGHT = 1320;

const COLORS = {
    bgTop: 0x06142eff,
    bgBottom: 0x0a1e40ff,
    panel: 0x13284dff,
    panelSoft: 0x17315bff,
    panelDeep: 0x102345ff,
    panelInset: 0x0b1b36ff,
    rowA: 0x1a3868ff,
    rowB: 0x173360ff,
    success: 0x34d399ff,
    danger: 0xf87171ff,
    warning: 0xfbbf24ff,
    info: 0x60a5faff,
    insight: 0x8b5cf6ff,
    cyan: 0x38bdf8ff,
    border: 0x2f5187cc,
    borderSoft: 0x294878aa,
    track: 0x122a4eff,
    shadow: 0x01061166,
    white: 0xffffffff
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
    const radius = Math.max(6, Number(options.radius || 14));
    const borderColor = options.borderColor || COLORS.borderSoft;
    const shadowColor = options.shadowColor || COLORS.shadow;
    const inset = 1;

    fillRoundedRect(image, x + 2, y + 3, w, h, radius, shadowColor);
    fillRoundedRect(image, x, y, w, h, radius, borderColor);
    fillRoundedRect(image, x + inset, y + inset, w - (inset * 2), h - (inset * 2), Math.max(2, radius - inset), color);
}

function drawGradientBackground(image) {
    for (let y = 0; y < HEIGHT; y += 1) {
        const ratio = y / (HEIGHT - 1);
        const topR = 0x06;
        const topG = 0x14;
        const topB = 0x2e;
        const botR = 0x0a;
        const botG = 0x1e;
        const botB = 0x40;
        const r = Math.round(topR + ((botR - topR) * ratio));
        const g = Math.round(topG + ((botG - topG) * ratio));
        const b = Math.round(topB + ((botB - topB) * ratio));
        const color = (r << 24) | (g << 16) | (b << 8) | 0xff;
        fillRect(image, 0, y, WIDTH, 1, color >>> 0);
    }
}

function drawBar(image, x, y, w, h, pct, color) {
    fillRoundedRect(image, x, y, w, h, 6, COLORS.track);
    const safe = Math.max(0, Math.min(1, Number(pct || 0)));
    if (safe <= 0) return;
    fillRoundedRect(image, x, y, Math.max(4, Math.floor(w * safe)), h, 6, color);
}

function drawDashedHLine(image, x, y, w, dash = 6, gap = 4, color = 0x7dd3fc99) {
    const d = Math.max(1, Number(dash || 1));
    const g = Math.max(0, Number(gap || 0));
    for (let dx = 0; dx < w; dx += (d + g)) {
        fillRect(image, x + dx, y, Math.min(d, w - dx), 1, color);
    }
}

function drawMiniBars(image, x, y, w, h, values) {
    const safe = Array.isArray(values) ? values.map((v) => Math.max(0, Number(v || 0))).slice(-24) : [];
    drawCard(image, x, y, w, h, COLORS.panelInset, { radius: 10, borderColor: COLORS.borderSoft, shadowColor: 0x01040c44 });
    if (safe.length === 0) return;

    const left = 10;
    const right = 10;
    const top = 10;
    const bottom = 8;
    const contentW = Math.max(12, w - left - right);
    const contentH = Math.max(12, h - top - bottom);
    const gap = 2;
    const barW = Math.max(3, Math.floor((contentW - ((safe.length - 1) * gap)) / safe.length));
    const max = Math.max(1, ...safe);
    const avg = safe.reduce((sum, n) => sum + n, 0) / safe.length;
    const avgY = y + h - bottom - Math.max(2, Math.round((avg / max) * contentH));

    drawDashedHLine(image, x + left, avgY, contentW);

    const peak = Math.max(...safe);
    const peakIndex = safe.findIndex((n) => n === peak);

    safe.forEach((value, idx) => {
        const barH = Math.max(3, Math.round((value / max) * contentH));
        const barX = x + left + (idx * (barW + gap));
        const barY = y + h - bottom - barH;
        const isPeak = idx === peakIndex;
        const tone = isPeak ? COLORS.warning : (idx >= safe.length - 4 ? COLORS.success : COLORS.cyan);
        fillRoundedRect(image, barX, barY, barW, barH, 2, tone);
    });
}

function statusColor(label) {
    if (label === 'QUENTE') return COLORS.success;
    if (label === 'MORNO') return COLORS.warning;
    return COLORS.info;
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

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function formatPct(value) {
    const n = Number(value || 0);
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
}

function formatPctCompact(value) {
    const n = Number(value || 0);
    const abs = Math.abs(n);
    const sign = n >= 0 ? '+' : '-';
    if (abs >= 10000) return `${sign}${Math.round(abs / 1000)}k%`;
    if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k%`;
    if (abs >= 100) return `${sign}${abs.toFixed(0)}%`;
    return `${sign}${abs.toFixed(1)}%`;
}

function ellipsize(text, maxChars) {
    const safe = String(text || '').replace(/\s+/g, ' ').trim();
    const max = Math.max(3, Number(maxChars) || 3);
    if (safe.length <= max) return safe;
    return `${safe.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function splitLines(text, maxCharsPerLine, maxLines) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    const maxChars = Math.max(8, Number(maxCharsPerLine) || 8);
    const cap = Math.max(1, Number(maxLines) || 1);
    let current = '';

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxChars) {
            current = candidate;
            continue;
        }

        if (current) {
            lines.push(current);
            if (lines.length >= cap) break;
        }
        current = word.length > maxChars ? ellipsize(word, maxChars) : word;
    }

    if (lines.length < cap && current) lines.push(current);
    if (lines.length > cap) lines.length = cap;

    const consumed = lines.join(' ').split(' ').filter(Boolean).length;
    if (consumed < words.length && lines.length > 0) {
        lines[lines.length - 1] = ellipsize(lines[lines.length - 1], maxChars);
    }

    return lines.length > 0 ? lines : ['-'];
}

function topicDotColor(topic) {
    const variation = Number(topic && topic.variationPct || 0);
    const icon = String(topic && topic.visual && topic.visual.icon || '').toUpperCase();
    if (icon === 'BOOM' || icon === 'ALERT' || variation >= 8) return COLORS.danger;
    if (variation > 0) return COLORS.success;
    if (variation < 0) return COLORS.warning;
    return COLORS.info;
}

export async function renderEngagementRadarImage(report) {
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const image = new Jimp({ width: WIDTH, height: HEIGHT, color: COLORS.bgTop });
    drawGradientBackground(image);

    const outerX = 32;
    const outerW = WIDTH - 64;
    const colGap = 16;
    const colW = Math.floor((outerW - colGap) / 2);
    let y = 24;

    const statusLabel = report.status?.label || 'N/D';
    const statusTone = statusColor(statusLabel);
    const growthPct = Number(report.summary?.growthPct || 0);
    const growthTone = growthColor(growthPct);
    const growthPrefix = growthPct > 0 ? 'UP ' : (growthPct < 0 ? 'DOWN ' : 'FLAT ');
    const hourlySeries = Array.isArray(report.summary?.hourlySeries) ? report.summary.hourlySeries : [];
    const hotTopics = (report.hotTopics || []).slice(0, 2);
    const topGroups = (report.topGroups || []).slice(0, 4);
    const accelerating = report.opportunities?.acceleratingToken;
    const insightLines = splitLines(String(report.insight || '-'), 44, 2);

    drawCard(image, outerX, y, outerW, 104, COLORS.panel, { borderColor: COLORS.borderSoft, radius: 18 });
    image.print({ font: titleFont, x: outerX + 20, y: y + 18, text: 'IMAVY - Radar de Engajamento', maxWidth: 760 });
    image.print({ font: bodyFont, x: outerX + 20, y: y + 66, text: 'Periodo: Ultimas 24h', maxWidth: 280 });
    drawCard(image, outerX + outerW - 244, y + 20, 220, 64, COLORS.panelInset, { borderColor: statusTone, radius: 12 });
    image.print({ font: bodyFont, x: outerX + outerW - 222, y: y + 30, text: 'Status', maxWidth: 120 });
    fillRoundedRect(image, outerX + outerW - 222, y + 52, 140, 18, 8, statusTone);
    image.print({ font: bodyFont, x: outerX + outerW - 196, y: y + 55, text: statusLabel, maxWidth: 100 });
    y += 120;

    drawCard(image, outerX, y, outerW, 130, COLORS.panelSoft, { borderColor: COLORS.borderSoft, radius: 16 });
    image.print({ font: bodyFont, x: outerX + 20, y: y + 14, text: 'Evolucao 24h', maxWidth: 220 });
    drawMiniBars(image, outerX + 20, y + 38, outerW - 40, 74, hourlySeries);
    y += 146;

    drawCard(image, outerX, y, outerW, 168, COLORS.panelDeep, { borderColor: growthTone, radius: 16 });
    image.print({ font: titleFont, x: outerX + 24, y: y + 22, text: `${growthPrefix}${formatPctCompact(growthPct)}`, maxWidth: 320 });
    image.print({ font: bodyFont, x: outerX + 24, y: y + 66, text: 'Crescimento do Grupo', maxWidth: 280 });

    const chipY = y + 92;
    const chipGap = 12;
    const chipW = Math.floor((outerW - 40 - (chipGap * 2)) / 3);
    const vel = `${(Number(report.summary?.msgPerMin || 0)).toFixed(1)} msg/min`;
    const pico = String(report.summary?.peakWindow || 'N/D');
    const energia = `${report.energiaGrupo?.score || 0}% ${ellipsize(report.energiaGrupo?.label || 'Fraco', 8)}`;
    drawCard(image, outerX + 20, chipY, chipW, 44, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10 });
    drawCard(image, outerX + 20 + chipW + chipGap, chipY, chipW, 44, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10 });
    drawCard(image, outerX + 20 + ((chipW + chipGap) * 2), chipY, chipW, 44, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10 });
    image.print({ font: bodyFont, x: outerX + 30, y: chipY + 10, text: `Velocidade: ${vel}`, maxWidth: chipW - 16 });
    image.print({ font: bodyFont, x: outerX + 30 + chipW + chipGap, y: chipY + 10, text: `Pico: ${pico}`, maxWidth: chipW - 16 });
    image.print({ font: bodyFont, x: outerX + 30 + ((chipW + chipGap) * 2), y: chipY + 10, text: `Energia: ${energia}`, maxWidth: chipW - 16 });
    drawBar(image, outerX + 20, y + 144, outerW - 40, 10, Number(report.energiaGrupo?.score || 0) / 100, energyColor(report.energiaGrupo?.score || 0));
    y += 184;

    drawCard(image, outerX, y, colW, 220, COLORS.panel, { borderColor: COLORS.borderSoft, radius: 14 });
    image.print({ font: bodyFont, x: outerX + 18, y: y + 14, text: 'Assuntos Quentes', maxWidth: 220 });
    if (hotTopics.length === 0) {
        image.print({ font: bodyFont, x: outerX + 18, y: y + 74, text: 'Sem topicos no periodo.', maxWidth: colW - 36 });
    } else {
        hotTopics.forEach((topic, idx) => {
            const rowY = y + 46 + (idx * 56);
            drawCard(image, outerX + 16, rowY, colW - 32, 44, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10 });
            image.print({ font: bodyFont, x: outerX + 28, y: rowY + 12, text: ellipsize(topic.label, 14), maxWidth: 170 });
            image.print({ font: bodyFont, x: outerX + 204, y: rowY + 12, text: formatNumber(topic.totalMentions), maxWidth: 60 });
            image.print({ font: bodyFont, x: outerX + 286, y: rowY + 12, text: formatPct(topic.variationPct || 0), maxWidth: 90 });
            fillRoundedRect(image, outerX + colW - 44, rowY + 12, 18, 18, 9, topicDotColor(topic));
        });
    }

    drawCard(image, outerX + colW + colGap, y, colW, 220, COLORS.panel, { borderColor: COLORS.borderSoft, radius: 14 });
    image.print({ font: bodyFont, x: outerX + colW + colGap + 18, y: y + 14, text: 'Pico Real', maxWidth: 180 });
    image.print({ font: bodyFont, x: outerX + colW + colGap + 18, y: y + 52, text: `Janela: ${report.peak?.window || 'N/D'}`, maxWidth: 220 });
    image.print({ font: bodyFont, x: outerX + colW + colGap + 18, y: y + 74, text: `Mensagens: +${report.peak?.totalMessages || 0}`, maxWidth: 220 });
    image.print({ font: bodyFont, x: outerX + colW + colGap + 18, y: y + 96, text: `Usuarios: +${report.peak?.activeUsers || 0}`, maxWidth: 220 });
    image.print({ font: bodyFont, x: outerX + colW + colGap + 18, y: y + 118, text: `Tema: ${ellipsize(report.peak?.dominantToken || 'N/D', 16)}`, maxWidth: 220 });
    drawCard(image, outerX + colW + colGap + colW - 192, y + 148, 172, 56, COLORS.panelInset, { borderColor: growthTone, radius: 12 });
    image.print({ font: titleFont, x: outerX + colW + colGap + colW - 178, y: y + 154, text: formatPctCompact(report.peak?.aboveAveragePct || 0), maxWidth: 150 });
    image.print({ font: bodyFont, x: outerX + colW + colGap + colW - 158, y: y + 188, text: 'vs media', maxWidth: 110 });
    y += 236;

    drawCard(image, outerX, y, colW, 170, COLORS.panel, { borderColor: COLORS.borderSoft, radius: 14 });
    image.print({ font: bodyFont, x: outerX + 18, y: y + 14, text: 'Oportunidades', maxWidth: 190 });
    drawCard(image, outerX + 16, y + 46, colW - 32, 34, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 9 });
    drawCard(image, outerX + 16, y + 88, colW - 32, 34, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 9 });
    drawCard(image, outerX + 16, y + 130, colW - 32, 34, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 9 });
    image.print({ font: bodyFont, x: outerX + 28, y: y + 56, text: `Perguntas ignoradas: ${report.opportunities?.ignoredQuestions || 0}`, maxWidth: colW - 64 });
    image.print({ font: bodyFont, x: outerX + 28, y: y + 98, text: `Ativos sem falar: ${report.opportunities?.usersDropOff || 0}`, maxWidth: colW - 64 });
    image.print({
        font: bodyFont,
        x: outerX + 28,
        y: y + 140,
        text: accelerating ? `Token: ${ellipsize(accelerating.label, 12)} ${formatPct(accelerating.variationPct)}` : 'Token: nenhum',
        maxWidth: colW - 64
    });

    drawCard(image, outerX + colW + colGap, y, colW, 170, 0x2b2350ff, { borderColor: COLORS.insight, radius: 14 });
    image.print({ font: bodyFont, x: outerX + colW + colGap + 18, y: y + 14, text: 'Insight Estrategico', maxWidth: 220 });
    insightLines.forEach((line, idx) => {
        image.print({ font: bodyFont, x: outerX + colW + colGap + 18, y: y + 54 + (idx * 18), text: line, maxWidth: colW - 36 });
    });
    y += 186;

    drawCard(image, outerX, y, outerW, 220, COLORS.panel, { borderColor: COLORS.borderSoft, radius: 14 });
    image.print({ font: bodyFont, x: outerX + 20, y: y + 14, text: 'Top grupos', maxWidth: 200 });
    drawCard(image, outerX + 16, y + 44, outerW - 32, 156, COLORS.panelInset, { borderColor: COLORS.borderSoft, radius: 10 });
    image.print({ font: bodyFont, x: outerX + 34, y: y + 58, text: 'Grupo', maxWidth: 520 });
    image.print({ font: bodyFont, x: outerX + outerW - 250, y: y + 58, text: 'Msgs', maxWidth: 70 });
    image.print({ font: bodyFont, x: outerX + outerW - 140, y: y + 58, text: 'Ativos', maxWidth: 70 });
    if (topGroups.length === 0) {
        image.print({ font: bodyFont, x: outerX + 34, y: y + 106, text: 'Sem grupos no periodo.', maxWidth: 400 });
    } else {
        topGroups.forEach((group, idx) => {
            const rowY = y + 82 + (idx * 28);
            fillRoundedRect(image, outerX + 28, rowY, outerW - 56, 24, 6, idx % 2 === 0 ? COLORS.rowA : COLORS.rowB);
            image.print({ font: bodyFont, x: outerX + 36, y: rowY + 6, text: ellipsize(group.groupName || '-', 48), maxWidth: outerW - 380 });
            image.print({ font: bodyFont, x: outerX + outerW - 248, y: rowY + 6, text: formatNumber(group.totalMessages), maxWidth: 80 });
            image.print({ font: bodyFont, x: outerX + outerW - 138, y: rowY + 6, text: formatNumber(group.activeUsers), maxWidth: 80 });
        });
    }
    y += 236;

    drawCard(image, outerX, y, outerW, 64, COLORS.panelSoft, { borderColor: COLORS.borderSoft, radius: 12 });
    image.print({ font: bodyFont, x: outerX + 18, y: y + 22, text: `Sugestao: ${ellipsize(report.suggestion || '-', 146)}`, maxWidth: outerW - 36 });

    return await image.getBuffer('image/png');
}
