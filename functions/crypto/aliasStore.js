// functions/crypto/aliasStore.js
// Armazena aliases de cripto em JSON no root do projeto.
// Objetivo: comandos curtos tipo /pnix -> responde com preço + métricas + link.
//
// Segurança:
// - Os comandos de escrita (add/del) devem ser protegidos por admin no groupResponder.
// - Aqui só fazemos persistência.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIASES_FILE = path.join(__dirname, '..', '..', 'crypto_aliases.json');

let cache = null;
let cacheTs = 0;
const CACHE_TTL_MS = 5000;

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(ALIASES_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    return (data && typeof data === 'object') ? data : {};
  } catch {
    // Se não existir, retorna vazio
    return {};
  }
}

async function saveToDisk(obj) {
  const data = obj && typeof obj === 'object' ? obj : {};
  await fs.writeFile(ALIASES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export async function getAliases() {
  const now = Date.now();
  if (cache && (now - cacheTs) < CACHE_TTL_MS) return cache;
  cache = await loadFromDisk();
  cacheTs = now;
  return cache;
}

export async function getAlias(alias) {
  const key = String(alias || '').trim().toLowerCase();
  if (!key) return null;
  const all = await getAliases();
  return all[key] || null;
}

export async function listAliases() {
  const all = await getAliases();
  return Object.entries(all).map(([k, v]) => ({
    alias: k,
    chain: v?.chain || 'unknown',
    pair: v?.pair || 'unknown',
    label: v?.label || ''
  }));
}

export async function addAlias(alias, chain, pair, label = '') {
  const key = String(alias || '').trim().toLowerCase().replace(/^\//, '');
  if (!key) return { ok: false, error: 'Alias vazio.' };
  if (!/^p[a-z0-9_\-]+$/.test(key)) return { ok: false, error: 'Alias inválido. Use algo como pnix, pbtc, psnappy.' };

  const c = String(chain || '').trim().toLowerCase();
  if (!c) return { ok: false, error: 'Chain vazia.' };

  const p = String(pair || '').trim();
  const m = p.match(/0x[a-fA-F0-9]{40}/);
  if (!m) return { ok: false, error: 'Pair inválido (esperado 0x... com 40 hex).' };

  const all = await loadFromDisk();
  all[key] = { chain: c, pair: m[0], label: String(label || '').trim() || key.toUpperCase() };

  await saveToDisk(all);
  cache = all;
  cacheTs = Date.now();
  return { ok: true, value: all[key] };
}

export async function removeAlias(alias) {
  const key = String(alias || '').trim().toLowerCase().replace(/^\//, '');
  if (!key) return { ok: false, error: 'Alias vazio.' };

  const all = await loadFromDisk();
  if (!all[key]) return { ok: false, error: 'Alias não existe.' };
  const removed = all[key];
  delete all[key];

  await saveToDisk(all);
  cache = all;
  cacheTs = Date.now();
  return { ok: true, value: removed };
}
