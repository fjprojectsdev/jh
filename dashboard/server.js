/**
 * iMavyBot Dashboard Backend
 * Tecnologias: Express, JWT, Cors, File System
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
console.log(`🔌 Porta configurada: ${PORT}`);
const SECRET_KEY = process.env.JWT_SECRET || 'chave_super_secreta_padrao';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'FJMR2025';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Caminhos dos arquivos de dados
const DATA_DIR = path.join(__dirname, '..');
const FILES = {
    BANNED: path.join(DATA_DIR, 'banned_words.json'),
    GROUPS: path.join(DATA_DIR, 'allowed_groups.json'),
    ADMINS: path.join(DATA_DIR, 'admins.json'),
    REMINDERS: path.join(DATA_DIR, 'lembretes.json'),
    LOGS: path.join(DATA_DIR, 'bot.log'),
    LEADS: path.join(DATA_DIR, 'leads.json')
};

// --- Helpers ---

// Garante que o diretório e arquivos existem
async function initDataFiles() {
    try {
        const defaults = {
            [FILES.BANNED]: "[]",
            [FILES.GROUPS]: "[]",
            [FILES.ADMINS]: JSON.stringify({ admins: [] }),
            [FILES.REMINDERS]: "{}"
        };

        for (const [file, content] of Object.entries(defaults)) {
            try {
                await fs.access(file);
            } catch {
                await fs.writeFile(file, content);
                console.log(`Criado arquivo padrão: ${path.basename(file)}`);
            }
        }
    } catch (err) {
        console.error("Erro ao inicializar arquivos:", err);
    }
}

// Lê arquivo JSON
async function readJson(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
}

// Escreve arquivo JSON
async function writeJson(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Adiciona Log
async function addLog(action) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${action}\n`;
    try {
        await fs.appendFile(FILES.LOGS, logEntry);
    } catch (err) {
        console.error("Erro ao gravar log:", err);
    }
}

// Middleware de Autenticação
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// --- Rotas ---

// Login
app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, SECRET_KEY, { expiresIn: '24h' });
        await addLog('Login de Administrador realizado com sucesso');
        res.json({ token, message: "Login realizado" });
    } else {
        await addLog('Tentativa de login falhou');
        res.status(401).json({ message: "Senha incorreta" });
    }
});

// Middleware aplicado para rotas abaixo
app.use('/api', authenticateToken);

// Estatísticas Gerais
app.get('/api/stats', async (req, res) => {
    try {
        const banned = await readJson(FILES.BANNED);
        const groups = await readJson(FILES.GROUPS);
        const adminsData = await readJson(FILES.ADMINS);
        const reminders = await readJson(FILES.REMINDERS);
        const leads = await readJson(FILES.LEADS);
        
        res.json({
            bannedWords: banned.length || 0,
            allowedGroups: groups.length || 0,
            admins: adminsData.admins ? adminsData.admins.length : 0,
            lembretes: Object.keys(reminders).length || 0,
            leads: leads.length || 0
        });
    } catch (err) {
        res.status(500).json({ error: "Erro ao ler dados" });
    }
});

// --- Palavras Banidas ---

app.get('/api/banned-words', async (req, res) => {
    const data = await readJson(FILES.BANNED);
    res.json(data);
});

app.post('/api/banned-words', async (req, res) => {
    const { word } = req.body;
    if (!word) return res.status(400).send();
    
    let list = await readJson(FILES.BANNED);
    if (!list.includes(word)) {
        list.push(word);
        await writeJson(FILES.BANNED, list);
        await addLog(`Palavra banida adicionada: ${word}`);
        io.emit('update');
    }
    res.json({ success: true });
});

app.delete('/api/banned-words/:word', async (req, res) => {
    const word = req.params.word;
    let list = await readJson(FILES.BANNED);
    const newList = list.filter(w => w !== word);
    
    await writeJson(FILES.BANNED, newList);
    await addLog(`Palavra banida removida: ${word}`);
    io.emit('update');
    res.json({ success: true });
});

// --- Grupos Permitidos ---

app.get('/api/allowed-groups', async (req, res) => {
    const data = await readJson(FILES.GROUPS);
    res.json(data);
});

app.post('/api/allowed-groups', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).send();

    let list = await readJson(FILES.GROUPS);
    if (!list.includes(name)) {
        list.push(name);
        await writeJson(FILES.GROUPS, list);
        await addLog(`Grupo permitido adicionado: ${name}`);
        io.emit('update');
    }
    res.json({ success: true });
});

app.delete('/api/allowed-groups/:name', async (req, res) => {
    const name = req.params.name;
    let list = await readJson(FILES.GROUPS);
    const newList = list.filter(g => g !== name);
    
    await writeJson(FILES.GROUPS, newList);
    await addLog(`Grupo permitido removido: ${name}`);
    io.emit('update');
    res.json({ success: true });
});

// --- Admins ---

app.get('/api/admins', async (req, res) => {
    const data = await readJson(FILES.ADMINS);
    res.json(data.admins || []);
});

// --- Leads ---

app.get('/api/leads', async (req, res) => {
    try {
        // Tentar Supabase primeiro
        const { createClient } = require('@supabase/supabase-js');
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_KEY;
        const supabase = createClient(supabaseUrl, supabaseKey);
        
        const { data } = await supabase.from('leads').select('*').order('updated_at', { ascending: false }).limit(50);
        res.json(data || []);
    } catch (e) {
        // Fallback para JSON
        const leads = await readJson(FILES.LEADS);
        res.json(leads.reverse().slice(0, 50));
    }
});

// --- Logs ---

app.get('/api/logs', async (req, res) => {
    try {
        const raw = await fs.readFile(FILES.LOGS, 'utf8');
        // Parse simples do formato de log texto para JSON
        const lines = raw.split('\n').filter(l => l.trim() !== '').reverse().slice(0, 50);
        
        const parsedLogs = lines.map(line => {
            // Extrai [Timestamp] Action
            const match = line.match(/^\[(.*?)\] (.*)$/);
            if (match) {
                return { timestamp: match[1], action: match[2] };
            }
            return { timestamp: '', action: line };
        });

        res.json(parsedLogs);
    } catch (err) {
        res.json([]);
    }
});

// WebSocket - Eventos em tempo real
io.on('connection', (socket) => {
    console.log('✅ Cliente conectado ao WebSocket');
    
    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado');
    });
});

// Função para emitir atualizações
global.emitDashboardUpdate = async (event, data) => {
    io.emit(event, data);
};

// Rota para violações
app.get('/api/violations', async (req, res) => {
    try {
        const { createClient } = require('@supabase/supabase-js');
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_KEY;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data, error } = await supabase
            .from('violations')
            .select('type')
            .limit(1000);

        if (error) throw error;

        // Processa os dados para contar as violações por tipo
        const violationCounts = data.reduce((acc, { type }) => {
            acc[type] = (acc[type] || 0) + 1;
            return acc;
        }, {});

        const chartData = Object.keys(violationCounts).map(type => ({
            type,
            count: violationCounts[type]
        }));

        res.json(chartData);
    } catch (e) {
        console.error("Erro ao buscar violações:", e);
        res.status(500).json([]); // Retorna array vazio em caso de erro
    }
});


// Rota para atividade recente
app.get('/api/recent-activity', async (req, res) => {
    try {
        const { createClient } = require('@supabase/supabase-js');
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_KEY;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data, error } = await supabase
            .from('logs')
            .select('action, timestamp')
            .order('timestamp', { ascending: false })
            .limit(5);

        if (error) throw error;

        res.json(data || []);
    } catch (e) {
        console.error("Erro ao buscar atividade recente:", e);
        res.status(500).json([]);
    }
});

// Catch-all para servir o app de página única
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicialização
initDataFiles().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🖥️ Dashboard rodando na porta ${PORT}`);
        console.log(`🔌 WebSocket ativo para atualizações em tempo real`);
        console.log(`🔑 Senha padrão: ${ADMIN_PASSWORD}`);
    });
});
