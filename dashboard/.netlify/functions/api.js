const serverless = require('serverless-http');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const SECRET_KEY = process.env.JWT_SECRET || 'chave_super_secreta_padrao';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'FJMR2025';

app.use(cors());
app.use(express.json());

const DATA_DIR = '/tmp';
const FILES = {
    BANNED: path.join(DATA_DIR, 'banned_words.json'),
    GROUPS: path.join(DATA_DIR, 'allowed_groups.json'),
    ADMINS: path.join(DATA_DIR, 'admins.json'),
    REMINDERS: path.join(DATA_DIR, 'lembretes.json'),
    LOGS: path.join(DATA_DIR, 'bot.log')
};

async function initDataFiles() {
    const defaults = {
        [FILES.BANNED]: "[]",
        [FILES.GROUPS]: "[]",
        [FILES.ADMINS]: JSON.stringify({ admins: [] }),
        [FILES.REMINDERS]: "{}"
    };
    for (const [file, content] of Object.entries(defaults)) {
        try { await fs.access(file); } catch { await fs.writeFile(file, content); }
    }
}

async function readJson(filePath) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return []; }
}

async function writeJson(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function addLog(action) {
    const logEntry = `[${new Date().toISOString()}] ${action}\n`;
    try { await fs.appendFile(FILES.LOGS, logEntry); } catch {}
}

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, SECRET_KEY, { expiresIn: '24h' });
        await addLog('Login realizado');
        res.json({ token, message: "Login realizado" });
    } else {
        res.status(401).json({ message: "Senha incorreta" });
    }
});

app.get('/api/stats', authenticateToken, async (req, res) => {
    await initDataFiles();
    const [banned, groups, adminsData, reminders] = await Promise.all([
        readJson(FILES.BANNED), readJson(FILES.GROUPS), readJson(FILES.ADMINS), readJson(FILES.REMINDERS)
    ]);
    res.json({
        bannedWords: banned.length || 0,
        allowedGroups: groups.length || 0,
        admins: adminsData.admins?.length || 0,
        lembretes: Object.keys(reminders).length || 0
    });
});

app.get('/api/banned-words', authenticateToken, async (req, res) => {
    await initDataFiles();
    res.json(await readJson(FILES.BANNED));
});

app.post('/api/banned-words', authenticateToken, async (req, res) => {
    const { word } = req.body;
    if (!word) return res.status(400).send();
    let list = await readJson(FILES.BANNED);
    if (!list.includes(word)) {
        list.push(word);
        await writeJson(FILES.BANNED, list);
        await addLog(`Palavra banida: ${word}`);
    }
    res.json({ success: true });
});

app.delete('/api/banned-words/:word', authenticateToken, async (req, res) => {
    let list = await readJson(FILES.BANNED);
    await writeJson(FILES.BANNED, list.filter(w => w !== req.params.word));
    await addLog(`Palavra removida: ${req.params.word}`);
    res.json({ success: true });
});

app.get('/api/allowed-groups', authenticateToken, async (req, res) => {
    await initDataFiles();
    res.json(await readJson(FILES.GROUPS));
});

app.post('/api/allowed-groups', authenticateToken, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).send();
    let list = await readJson(FILES.GROUPS);
    if (!list.includes(name)) {
        list.push(name);
        await writeJson(FILES.GROUPS, list);
        await addLog(`Grupo adicionado: ${name}`);
    }
    res.json({ success: true });
});

app.delete('/api/allowed-groups/:name', authenticateToken, async (req, res) => {
    let list = await readJson(FILES.GROUPS);
    await writeJson(FILES.GROUPS, list.filter(g => g !== req.params.name));
    await addLog(`Grupo removido: ${req.params.name}`);
    res.json({ success: true });
});

app.get('/api/admins', authenticateToken, async (req, res) => {
    await initDataFiles();
    const data = await readJson(FILES.ADMINS);
    res.json(data.admins || []);
});

app.get('/api/logs', authenticateToken, async (req, res) => {
    try {
        const raw = await fs.readFile(FILES.LOGS, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim()).reverse().slice(0, 50);
        const parsedLogs = lines.map(line => {
            const match = line.match(/^\[(.*?)\] (.*)$/);
            return match ? { timestamp: match[1], action: match[2] } : { timestamp: '', action: line };
        });
        res.json(parsedLogs);
    } catch {
        res.json([]);
    }
});

module.exports.handler = serverless(app);
