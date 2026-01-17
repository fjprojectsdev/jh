/**
 * iMavyBot Dashboard Server (single service)
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_PASSWORD || !JWT_SECRET) {
    console.error('❌ Variáveis obrigatórias ausentes: ADMIN_PASSWORD e JWT_SECRET');
    console.error('👉 Configure no Railway/ambiente antes de iniciar o dashboard.');
    process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, '..');
const FILES = {
    BANNED: path.join(DATA_DIR, 'banned_words.json'),
    GROUPS: path.join(DATA_DIR, 'allowed_groups.json'),
    ADMINS: path.join(DATA_DIR, 'admins.json'),
    REMINDERS: path.join(DATA_DIR, 'lembretes.json'),
    LOGS: path.join(DATA_DIR, 'bot.log'),
    LEADS: path.join(DATA_DIR, 'leads.json')
};

async function ensureFile(filePath, defaultContent) {
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, defaultContent);
    }
}

async function initDataFiles() {
    await ensureFile(FILES.BANNED, '[]');
    await ensureFile(FILES.GROUPS, '[]');
    await ensureFile(FILES.ADMINS, JSON.stringify({ admins: [] }, null, 2));
    await ensureFile(FILES.REMINDERS, '{}');
    await ensureFile(FILES.LEADS, '[]');
    await ensureFile(FILES.LOGS, '');
}

async function readJson(filePath, fallback) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

async function writeJson(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function addLog(action) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${action}\n`;
    await fs.appendFile(FILES.LOGS, logEntry);
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        await addLog('Tentativa de login falhou');
        return res.status(401).json({ message: 'Senha incorreta' });
    }

    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    await addLog('Login de Administrador realizado com sucesso');
    res.json({ token, message: 'Login realizado' });
});

app.use('/api', authenticateToken);

app.get('/api/stats', async (req, res) => {
    try {
        const banned = await readJson(FILES.BANNED, []);
        const groups = await readJson(FILES.GROUPS, []);
        const adminsData = await readJson(FILES.ADMINS, { admins: [] });
        const reminders = await readJson(FILES.REMINDERS, {});
        const leads = await readJson(FILES.LEADS, []);

        res.json({
            bannedWords: banned.length,
            allowedGroups: groups.length,
            admins: adminsData.admins?.length || 0,
            lembretes: Object.keys(reminders).length,
            leads: leads.length
        });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao ler dados' });
    }
});

app.get('/api/banned-words', async (req, res) => {
    const data = await readJson(FILES.BANNED, []);
    res.json(data);
});

app.post('/api/banned-words', async (req, res) => {
    const word = String(req.body.word || '').trim();
    if (!word) return res.status(400).json({ message: 'Palavra inválida' });

    const list = await readJson(FILES.BANNED, []);
    if (!list.includes(word)) {
        list.push(word);
        await writeJson(FILES.BANNED, list);
        await addLog(`Palavra banida adicionada: ${word}`);
    }

    res.json({ success: true });
});

app.delete('/api/banned-words/:word', async (req, res) => {
    const word = decodeURIComponent(req.params.word);
    const list = await readJson(FILES.BANNED, []);
    const newList = list.filter((entry) => entry !== word);
    await writeJson(FILES.BANNED, newList);
    await addLog(`Palavra banida removida: ${word}`);
    res.json({ success: true });
});

app.get('/api/allowed-groups', async (req, res) => {
    const data = await readJson(FILES.GROUPS, []);
    res.json(data);
});

app.post('/api/allowed-groups', async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Nome inválido' });

    const list = await readJson(FILES.GROUPS, []);
    if (!list.includes(name)) {
        list.push(name);
        await writeJson(FILES.GROUPS, list);
        await addLog(`Grupo permitido adicionado: ${name}`);
    }

    res.json({ success: true });
});

app.delete('/api/allowed-groups/:name', async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const list = await readJson(FILES.GROUPS, []);
    const newList = list.filter((entry) => entry !== name);
    await writeJson(FILES.GROUPS, newList);
    await addLog(`Grupo permitido removido: ${name}`);
    res.json({ success: true });
});

app.get('/api/admins', async (req, res) => {
    const data = await readJson(FILES.ADMINS, { admins: [] });
    res.json(data.admins || []);
});

app.get('/api/leads', async (req, res) => {
    const leads = await readJson(FILES.LEADS, []);
    res.json(leads.slice().reverse().slice(0, 50));
});

app.get('/api/logs', async (req, res) => {
    try {
        const raw = await fs.readFile(FILES.LOGS, 'utf8');
        const lines = raw.split('\n').filter(Boolean).reverse().slice(0, 100);
        const parsed = lines.map((line) => {
            const match = line.match(/^\[(.*?)\] (.*)$/);
            if (match) {
                return { timestamp: match[1], action: match[2] };
            }
            return { timestamp: '', action: line };
        });

        res.json(parsed);
    } catch {
        res.json([]);
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDataFiles().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🖥️ Dashboard rodando na porta ${PORT}`);
    });
});
