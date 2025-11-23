// Script de inicialização para Railway
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🚀 Inicializando bot no Railway...');

// Criar arquivos JSON necessários se não existirem
const requiredFiles = {
    'strikes.json': '{}',
    'lembretes.json': '{}',
    'banned_words.json': '[]',
    'allowed_groups.json': '[]',
    'admins.json': '[]',
    'blacklist.json': '{"words": [], "links": []}',
    'allowed_users.json': '[]',
    'scheduled.json': '[]'
};

Object.entries(requiredFiles).forEach(([filename, defaultContent]) => {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent);
        console.log(`✅ Criado: ${filename}`);
    } else {
        console.log(`✓ Existe: ${filename}`);
    }
});

// Criar pasta de backups
const backupDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log('✅ Pasta backups criada');
}

// Validar variáveis de ambiente críticas
const requiredEnvVars = ['GROQ_API_KEY', 'AUTHORIZED_IDS'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
    console.warn('⚠️ Variáveis de ambiente faltando:', missingVars.join(', '));
    console.warn('⚠️ Configure no Railway Dashboard');
}

// Configurar porta
if (process.env.PORT) {
    console.log(`✅ Porta configurada: ${process.env.PORT}`);
}

console.log('✅ Inicialização completa!\n');
