const crypto = require('crypto');
const {
    requestJson,
    requestCount,
    sanitizeText,
    sanitizeEmail
} = require('../services/supabaseTenantClient.js');

const TABLE = process.env.IMAVY_CLIENTES_TABLE || 'clientes';

function mapClienteRow(row, includeSenha = false) {
    if (!row) {
        return null;
    }

    const cliente = {
        id: row.id,
        nome: row.nome,
        email: row.email,
        plano: row.plano,
        criadoEm: row.criado_em
    };

    if (includeSenha) {
        cliente.senhaHash = row.senha_hash;
    }

    return cliente;
}

function normalizePlano(plano) {
    const value = String(plano || 'free').toLowerCase();
    if (value === 'pro' || value === 'enterprise') {
        return value;
    }
    return 'free';
}

async function findClienteByEmail(email, includeSenha = false) {
    const safeEmail = sanitizeEmail(email);
    const selectFields = includeSenha
        ? 'id,nome,email,senha_hash,plano,criado_em'
        : 'id,nome,email,plano,criado_em';

    const query = `${TABLE}?select=${encodeURIComponent(selectFields)}&email=eq.${encodeURIComponent(safeEmail)}&limit=1`;
    const rows = await requestJson('GET', query);
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    return mapClienteRow(row, includeSenha);
}

async function findClienteById(clienteId, includeSenha = false) {
    const safeId = sanitizeText(clienteId, 120);
    const selectFields = includeSenha
        ? 'id,nome,email,senha_hash,plano,criado_em'
        : 'id,nome,email,plano,criado_em';

    const query = `${TABLE}?select=${encodeURIComponent(selectFields)}&id=eq.${encodeURIComponent(safeId)}&limit=1`;
    const rows = await requestJson('GET', query);
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    return mapClienteRow(row, includeSenha);
}

async function createCliente(payload) {
    const nome = sanitizeText(payload && payload.nome, 160);
    const email = sanitizeEmail(payload && payload.email);
    const senhaHash = sanitizeText(payload && payload.senhaHash, 500);
    const plano = normalizePlano(payload && payload.plano);

    if (!nome || !email || !senhaHash) {
        throw new Error('Dados obrigatorios de cliente ausentes.');
    }

    const record = {
        id: crypto.randomUUID(),
        nome,
        email,
        senha_hash: senhaHash,
        plano,
        criado_em: new Date().toISOString()
    };

    const query = `${TABLE}?select=${encodeURIComponent('id,nome,email,plano,criado_em')}`;
    const rows = await requestJson('POST', query, record, {
        headers: {
            Prefer: 'return=representation'
        }
    });

    return mapClienteRow(Array.isArray(rows) ? rows[0] : null, false);
}

async function countClientes() {
    const query = `${TABLE}?select=id`;
    return requestCount(query);
}

module.exports = {
    normalizePlano,
    findClienteByEmail,
    findClienteById,
    createCliente,
    countClientes
};
