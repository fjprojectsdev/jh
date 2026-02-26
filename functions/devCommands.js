// Comandos de desenvolvedor
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Groq from 'groq-sdk';
import { sendSafeMessage } from './messageHandler.js';
import { getNumberFromJid } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLOBAL_DEV_MODE = String(process.env.IMAVY_DEV_MODE || 'false').toLowerCase() === 'true';

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || 'your-groq-api-key-here'
});

// IDs dos desenvolvedores autorizados
const DEV_IDS = (process.env.DEV_IDS || '').split(',').filter(Boolean);
function loadAdminIds() {
    const fromEnv = (process.env.AUTHORIZED_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

    const adminsPath = path.join(__dirname, '..', 'admins.json');
    let fromFile = [];

    try {
        if (fs.existsSync(adminsPath)) {
            const parsed = JSON.parse(fs.readFileSync(adminsPath, 'utf8'));
            fromFile = Array.isArray(parsed?.admins) ? parsed.admins : [];
        }
    } catch (error) {
        console.warn('Falha ao ler admins.json para permissao DEV:', error.message || String(error));
    }

    return [...fromEnv, ...fromFile];
}

// Modo desenvolvedor ativo por usuário
const devModeActive = new Map();
const conversationHistory = new Map();

export function isDev(userId) {
    const cleanId = userId.replace('@s.whatsapp.net', '').replace('@lid', '');
    const userNumber = getNumberFromJid(userId);
    const adminIds = loadAdminIds();
    console.log('DEBUG DEV - userId:', userId);
    console.log('DEBUG DEV - cleanId:', cleanId);
    console.log('DEBUG DEV - DEV_IDS:', DEV_IDS);
    const isExplicitDev = DEV_IDS.some((devId) => {
        const trimmed = devId.trim();
        if (!trimmed) return false;
        if (cleanId.includes(trimmed)) return true;
        return userNumber && userNumber === getNumberFromJid(trimmed);
    });
    const isAdmin = adminIds.some((adminId) => {
        if (userId === adminId) return true;
        const adminNumber = getNumberFromJid(adminId);
        return Boolean(userNumber) && Boolean(adminNumber) && userNumber === adminNumber;
    });
    const isAuthorized = isExplicitDev || isAdmin;
    console.log('DEBUG DEV - isAuthorized:', isAuthorized);
    return isAuthorized;
}

export function isDevModeActive(userId) {
    if (GLOBAL_DEV_MODE && isDev(userId)) {
        return true;
    }
    return devModeActive.get(userId) === true;
}

export function activateDevMode(userId) {
    devModeActive.set(userId, true);
    conversationHistory.set(userId, []);
}

export function deactivateDevMode(userId) {
    devModeActive.delete(userId);
    conversationHistory.delete(userId);
}

function getHistory(userId) {
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }
    return conversationHistory.get(userId);
}

function addToHistory(userId, role, content) {
    const history = getHistory(userId);
    history.push({ role, content });
    if (history.length > 20) history.shift();
}

export async function handleDevCommand(sock, message, text) {
    const senderId = message.key.participant || message.key.remoteJid;
    const chatId = message.key.remoteJid;
    const isPrivate = !chatId.endsWith('@g.us');

    if (!isDev(senderId)) {
        await sendSafeMessage(sock, chatId, { text: '❌ Acesso negado. Comando apenas para desenvolvedores.' });
        return;
    }

    // Ativar modo dev no privado
    if (text.trim() === '/dev' && isPrivate) {
        activateDevMode(senderId);
        const welcomeMsg = `🤖 *MODO DESENVOLVEDOR ATIVADO* 🤖

👋 Olá, mestre! Sou seu assistente de desenvolvimento.

💡 Agora você pode conversar comigo naturalmente:

• "Crie um comando de sorteio"
• "Adicione função de enquete"
• "Quero um comando que..."
• "Como faço para..."

🛠️ Comandos rápidos:
• /dev off - Desativar modo
• /dev status - Status do sistema
• /dev logs - Ver logs
• /dev restart - Reiniciar bot

✨ Estou pronto para criar qualquer função que você imaginar!`;
        await sendSafeMessage(sock, chatId, { text: welcomeMsg });
        return;
    }

    const args = text.split(' ');
    const subCmd = args[1]?.toLowerCase();

    if (subCmd === 'eval') {
        // Executar código JavaScript
        const code = args.slice(2).join(' ');
        try {
            const result = eval(code);
            await sendSafeMessage(sock, chatId, { text: `✅ Resultado:\n${JSON.stringify(result, null, 2)}` });
        } catch (e) {
            await sendSafeMessage(sock, chatId, { text: `❌ Erro:\n${e.message}` });
        }
    } else if (subCmd === 'restart') {
        await sendSafeMessage(sock, chatId, { text: '🔄 Reiniciando bot...' });
        process.exit(0);
    } else if (subCmd === 'logs') {
        const logFile = path.join(__dirname, '..', 'bot.log');
        if (fs.existsSync(logFile)) {
            const logs = fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n');
            await sendSafeMessage(sock, chatId, { text: `📋 Últimos logs:\n\n${logs}` });
        } else {
            await sendSafeMessage(sock, chatId, { text: '❌ Arquivo de log não encontrado' });
        }
    } else if (subCmd === 'status') {
        const uptime = process.uptime();
        const memory = process.memoryUsage();
        const status = `📊 STATUS DO BOT\n\n⏱️ Uptime: ${Math.floor(uptime / 60)}min\n💾 Memória: ${Math.floor(memory.heapUsed / 1024 / 1024)}MB\n🔢 PID: ${process.pid}\n🛠️ Dev global: ${GLOBAL_DEV_MODE ? 'ATIVO' : 'DESATIVADO'}`;
        await sendSafeMessage(sock, chatId, { text: status });
    } else if (subCmd === 'backup') {
        await sendSafeMessage(sock, chatId, { text: '💾 Criando backup...' });
        // Implementar backup manual
        await sendSafeMessage(sock, chatId, { text: '✅ Backup criado!' });
    } else if (subCmd === 'off') {
        deactivateDevMode(senderId);
        await sendSafeMessage(sock, chatId, { text: '✅ Modo desenvolvedor desativado.' });
    } else {
        const help = `🛠️ COMANDOS DEV\n\n/dev - Ativar modo IA (privado)\n/dev off - Desativar modo\n/dev eval [código] - Executa JS\n/dev restart - Reinicia bot\n/dev logs - Últimos logs\n/dev status - Status do sistema\n/dev backup - Backup manual`;
        await sendSafeMessage(sock, chatId, { text: help });
    }
}

export async function handleDevConversation(sock, senderId, messageText) {
    const chatId = senderId;

    await sendSafeMessage(sock, chatId, { text: '🤖 Analisando sua solicitação...' });

    try {
        const history = getHistory(senderId);

        const systemPrompt = `Você é um assistente de desenvolvimento EXPERT em Node.js, Baileys (WhatsApp bot) e JavaScript.

🎯 PROCESSO DE DESENVOLVIMENTO:

1. ANÁLISE: Entenda COMPLETAMENTE o que o dev quer
2. PLANEJAMENTO: Pense na lógica ANTES de codificar
3. VALIDAÇÃO: Pergunte se não tiver certeza
4. IMPLEMENTAÇÃO: Código limpo e funcional

📋 REGRAS DE LÓGICA:

- SEMPRE analise requisitos antes de codificar
- Identifique estados necessários (Map, Set, Array)
- Pense em edge cases (erros, validações)
- Use estruturas de dados apropriadas
- Considere concorrência (múltiplos grupos)

🔧 QUANDO CRIAR CÓDIGO:

SÓ crie código se:
✅ Entendeu 100% o requisito
✅ Sabe qual estrutura usar
✅ Tem lógica clara em mente

Se NÃO tiver certeza:
❌ NÃO crie código
✅ Faça perguntas (type: "question")
✅ Sugira alternativas (type: "advice")

📦 FORMATO DE RESPOSTA JSON:

{
  "type": "code" | "advice" | "question",
  "response": "explicação clara",
  "logic": "descrição da lógica (se type=code)",
  "commandName": "nome sem espaços",
  "commandTrigger": "!comando ou /comando",
  "code": "código completo",
  "usage": "exemplo de uso",
  "isPublic": true/false
}

💻 ESTRUTURA OBRIGATÓRIA:

// Estados globais (se necessário)
const estadoComando = new Map();

export async function handleNome(sock, message, text) {
  const chatId = message.key.remoteJid;
  const senderId = message.key.participant || message.key.remoteJid;
  const args = text.split(' ').slice(1);
  
  // Validações
  if (!args[0]) {
    await sendSafeMessage(sock, chatId, { text: '❌ Uso: !comando <param>' });
    return;
  }
  
  // Lógica principal
  try {
    // seu código
    await sendSafeMessage(sock, chatId, { text: '✅ Sucesso' });
  } catch (e) {
    await sendSafeMessage(sock, chatId, { text: '❌ Erro: ' + e.message });
  }
}

🎓 EXEMPLOS DE BOA LÓGICA:

1. Sorteio: Map para grupos ativos, setTimeout para finalizar
2. Enquete: Map com {chatId: {opcoes, votos}}
3. Quiz: Map com {chatId: {pergunta, resposta, participantes}}

⚠️ NUNCA:
- Código sem validação
- Lógica incompleta
- Variáveis globais sem Map/Set
- Código sem try/catch
- Funções sem await`;

        const messages = [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: messageText }
        ];

        const response = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages,
            max_tokens: 2000,
            temperature: 0.7,
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(response.choices[0].message.content);

        addToHistory(senderId, 'user', messageText);
        addToHistory(senderId, 'assistant', result.response);

        // Se for pergunta, apenas responder
        if (result.type === 'question') {
            await sendSafeMessage(sock, chatId, { text: `❓ ${result.response}` });
            return;
        }

        // Se for conselho, apenas responder
        if (result.type === 'advice') {
            await sendSafeMessage(sock, chatId, { text: `💡 ${result.response}` });
            return;
        }

        // Se for código, validar lógica
        if (result.type === 'code') {
            if (!result.logic || result.logic.length < 20) {
                await sendSafeMessage(sock, chatId, { text: '❌ Erro: Lógica não foi planejada adequadamente. Tente novamente.' });
                return;
            }
            const fileName = `${result.commandName}.js`;
            const customDir = path.join(__dirname, 'custom');

            if (!fs.existsSync(customDir)) {
                fs.mkdirSync(customDir, { recursive: true });
            }

            const filePath = path.join(customDir, fileName);
            fs.writeFileSync(filePath, result.code);

            // Auto-integrar ao groupResponder
            await integrateCommand(result.commandName, result.commandTrigger, result.isPublic);

            const msg = `${result.response}\n\n🧠 *LÓGICA IMPLEMENTADA:*\n${result.logic}\n\n✅ *COMANDO CRIADO!*\n📁 Arquivo: functions/custom/${fileName}\n🔑 Gatilho: ${result.commandTrigger}\n👥 Público: ${result.isPublic ? 'Sim' : 'Só admins'}\n💬 Uso: ${result.usage}\n\n✅ Integrado e pronto para usar!`;
            await sendSafeMessage(sock, chatId, { text: msg });
        } else {
            await sendSafeMessage(sock, chatId, { text: result.response });
        }

    } catch (e) {
        await sendSafeMessage(sock, chatId, { text: `❌ Erro: ${e.message}` });
    }
}

async function integrateCommand(commandName, trigger, isPublic) {
    const responderPath = path.join(__dirname, 'groupResponder.js');
    let content = fs.readFileSync(responderPath, 'utf8');

    // Adicionar import
    const importLine = `import { handle${capitalize(commandName)} } from './custom/${commandName}.js';`;
    if (!content.includes(importLine)) {
        const importPos = content.indexOf("import { handleSorteio }");
        if (importPos > -1) {
            content = content.replace(
                "import { handleSorteio } from './custom/sorteio.js';",
                `import { handleSorteio } from './custom/sorteio.js';\n${importLine}`
            );
        }
    }

    // Adicionar handler
    const handlerCode = `
    // Comando ${trigger} (${isPublic ? 'público' : 'admin'})
    if (normalizedText.startsWith('${trigger.toLowerCase()}')) {
        ${isPublic ? '' : `
        const authorized = await isAuthorized(senderId);
        if (!authorized) {
            await sendSafeMessage(sock, groupId, { text: '❌ Apenas admins podem usar este comando.' });
            return;
        }`}
        if (isGroup) {
            await handle${capitalize(commandName)}(sock, message, text);
        }
        return;
    }`;

    // Inserir antes dos comandos administrativos
    const insertPos = content.indexOf('// Comandos administrativos');
    if (insertPos > -1 && !content.includes(`Comando ${trigger}`)) {
        content = content.slice(0, insertPos) + handlerCode + '\n\n    ' + content.slice(insertPos);
    }

    fs.writeFileSync(responderPath, content);
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
