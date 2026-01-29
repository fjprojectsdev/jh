// functions/crypto/timeseries.js
// Ring buffer em memória por par (mantém últimos N pontos)

const series = new Map();

export function pushPoint(key, point, maxLen = 720) {
  if (!series.has(key)) series.set(key, []);
  const arr = series.get(key);
  arr.push(point);
  while (arr.length > maxLen) arr.shift();
}

export function getSeries(key) {
  return series.get(key) || [];
}

export function clearSeries(key) {
  series.delete(key);
}
