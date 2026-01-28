// functions/crypto/chart.js
// Gera um gráfico simples (sparkline) em PNG usando Jimp.
// Pensado para WhatsApp: leve, rápido, sem dependência de browser.

import { Jimp } from 'jimp';

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export async function renderSparklinePng(points, options = {}) {
  const {
    width = 700,
    height = 360,
    pad = 24,
    lineColor = 0x111111ff,
    bgColor = 0xffffffff
  } = options;

  const img = new Jimp(width, height, bgColor);

  // Sem pontos suficientes, devolve uma imagem "vazia" com nota
  if (!Array.isArray(points) || points.length < 2) {
    return await img.getBufferAsync(Jimp.MIME_PNG);
  }

  // Extrair preços válidos
  const prices = points
    .map(p => Number(p?.priceUsd ?? p?.price))
    .filter(n => Number.isFinite(n));

  if (prices.length < 2) {
    return await img.getBufferAsync(Jimp.MIME_PNG);
  }

  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (min === max) {
    // Evita divisão por zero: cria uma faixa artificial
    min = min * 0.999;
    max = max * 1.001;
  }

  const usableW = width - pad * 2;
  const usableH = height - pad * 2;

  // Desenha um grid bem leve (linhas horizontais)
  const gridColor = 0xddddddff;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(pad + (usableH * i) / 4);
    for (let x = pad; x < pad + usableW; x++) {
      img.setPixelColor(gridColor, x, y);
    }
  }

  // Mapear preço -> Y
  const toY = (price) => {
    const t = (price - min) / (max - min);
    return Math.round(pad + usableH - t * usableH);
  };

  // Linha
  const n = prices.length;
  let prevX = pad;
  let prevY = toY(prices[0]);

  for (let i = 1; i < n; i++) {
    const x = Math.round(pad + (usableW * i) / (n - 1));
    const y = toY(prices[i]);

    // Desenho simples por interpolação (DDA)
    const dx = x - prevX;
    const dy = y - prevY;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let s = 0; s <= steps; s++) {
      const px = Math.round(prevX + (dx * s) / steps);
      const py = Math.round(prevY + (dy * s) / steps);
      if (px >= 0 && py >= 0 && px < width && py < height) {
        img.setPixelColor(lineColor, px, py);
        // engrossa um pouco a linha
        img.setPixelColor(lineColor, px, clamp(py + 1, 0, height - 1));
      }
    }

    prevX = x;
    prevY = y;
  }

  return await img.getBufferAsync(Jimp.MIME_PNG);
}
