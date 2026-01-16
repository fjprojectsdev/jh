// index.js
import 'dotenv/config';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, getContentType } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendWelcomeMessage } from './functions/welcomeMessage.js';
import { checkViolation, getText, notifyAdmins, addStrike, getStrikes, applyPunishment } from './functions/antiSpam.js';
import { getGroupStatus } from './functions/groupStats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { handleGroupMessages } from './functions/groupResponder.js';
import { isAuthorized } from './functions/adminCommands.js';
import { getNumberFromJid, formatNumberInternational } from './functions/utils.js';
import { scheduleGroupMessages } from './functions/scheduler.js';
import { ensureCoreConfigFiles } from './functions/configBootstrap.js';
import { scheduleBackups } from './functions/backup.js';
import { logger } from './functions/logger.js';
import { startScheduler } from './functions/scheduler2.js';
import { detectClientInterest, sendAttendanceMessage, shouldSendAttendance, sendVerificationMessage, markAsVerified, isVerified, notifyAttendants } from './functions/autoAttendance.js';
import { getAdmins } from './functions/authManager.js';
import { scheduleSupabaseBackup } from './functions/supabaseBackup.js';
import { analyzeMessage, isAIEnabled } from './functions/aiModeration.js';
import { analyzeLeadIntent, isAISalesEnabled } from './functions/aiSales.js';
import { startAutoPromo } from './functions/autoPromo.js';
import { handleConnectionUpdate, resetReconnectAttempts } from './functions/connectionManager.js';
import { startHealthMonitor, startSessionBackup, setConnected, updateHeartbeat, restoreSessionFromBackup } from './keepalive.js';
import { handleDevCommand, isDev, isDevModeActive, handleDevConversation } from './functions/devCommands.js';

console.log('🤖 IA de Moderação:', isAIEnabled() ? '✅ ATIVA (Groq)' : '❌ Desabilitada');
console.log('💼 IA de Vendas:', isAISalesEnabled() ? '✅ ATIVA (Groq)' : '❌ Desabilitada');

// Servidor HTTP para Railway/Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    if (req.url === '/qr' && qrCodeData) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#000"><img src="${qrCodeData}" style="max-width:90%;max-height:90%"></body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Bot WhatsApp iMavyAgent - Online\n\nAcesse /qr para ver o QR Code');
    }
}).listen(PORT, () => {
    console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

// Variável para armazenar o servidor HTTP temporário
let qrServer = null;
let qrCodeData = null;

// Timestamp de inicialização do bot para ignorar mensagens antigas
const botStartTime = Date.now();

async function startBot() {
    console.log("===============================================");
    console.log("🚀 Iniciando iMavyAgent - Respostas Pré-Definidas");
    console.log("===============================================");
    console.log('🤖 IA Status: Groq (gratuito e rápido) para moderação automática!');
    console.log('⚙️ Sistema de lembretes avançado com encerramento automático ativo!');

    await ensureCoreConfigFiles();
    
    // Tentar restaurar sessão do backup se necessário
    restoreSessionFromBackup();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        browser: ['iMavyAgent', 'Chrome', '10.0'],
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        qrTimeout: 60000,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && connection !== 'open') {
            console.log("\n╔════════════════════════════════════════════════════════════╗");
            console.log("║           🔐 AUTENTICAÇÃO WHATSAPP REQUERIDA 🔐              ║");
            console.log("╠════════════════════════════════════════════════════════════╣");
            console.log("║ Escaneie este QR code no WhatsApp Web                      ║");
            console.log("╚════════════════════════════════════════════════════════════╝\n");
            
            qrcode.generate(qr, { small: true });
            
            try {
                qrCodeData = await QRCode.toDataURL(qr, { width: 600 });
                console.log("\n🔗 QR CODE DISPONÍVEL EM:");
                console.log(`http://localhost:${PORT}/qr`);
                console.log("\n⚠️ O QR code fica disponível por 60 segundos\n");
            } catch (e) {
                console.log("Erro ao gerar link QR:", e.message);
            }
            
            // Detectar se está no Railway ou produção
            const isProduction = process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
            
            if (isProduction) {
                // Em produção (Railway), mostrar QR code compacto + base64
                qrcode.generate(qr, { small: true });
                
                try {
                    // Gerar base64 do QR code para copiar/colar
                    const qrImageDataUrl = await QRCode.toDataURL(qr, {
                        width: 400,
                        margin: 2
                    });
                    
                    console.log("\n🔗 LINK BASE64 DO QR CODE (copie e cole no navegador):");
                    console.log(qrImageDataUrl);
                    console.log("\n💡 Copie o link acima, cole na barra de endereços do navegador e escaneie\n");
                } catch (error) {
                    console.log("\n💡 Escaneie o QR code acima com o WhatsApp Web\n");
                }
            } else {
                // Local, mostrar QR code maior + servidor HTTP
                qrcode.generate(qr, { small: false });
                
                try {
                    // Gerar imagem do QR code em base64 (tamanho maior)
                    const qrImageDataUrl = await QRCode.toDataURL(qr, {
                        width: 800,
                        margin: 4,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });
                    
                    // Extrair apenas os dados base64 (remover o prefixo data:image/png;base64,)
                    const qrImageBase64 = qrImageDataUrl.split(',')[1];
                    const qrImageBuffer = Buffer.from(qrImageBase64, 'base64');
                    
                    // Fechar servidor anterior se existir
                    if (qrServer) {
                        qrServer.close(() => {
                            console.log('🔄 Servidor QR anterior fechado');
                        });
                        qrServer = null;
                    }
                    
                    // Criar servidor HTTP temporário
                    const port = process.env.QR_SERVER_PORT || 3001;
                    
                    qrServer = http.createServer((req, res) => {
                        if (req.url === '/qr' || req.url === '/qr.png' || req.url === '/') {
                            res.writeHead(200, {
                                'Content-Type': 'image/png',
                                'Content-Length': qrImageBuffer.length,
                                'Cache-Control': 'no-cache',
                                'Access-Control-Allow-Origin': '*'
                            });
                            res.end(qrImageBuffer);
                        } else {
                            res.writeHead(404, { 'Content-Type': 'text/plain' });
                            res.end('Not Found');
                        }
                    });
                    
                    qrServer.on('error', (err) => {
                        if (err.code === 'EADDRINUSE') {
                            console.error(`❌ Porta ${port} já está em uso. Tente usar outra porta.`);
                        } else {
                            console.error('❌ Erro no servidor QR code:', err);
                        }
                    });
                    
                    qrServer.listen(port, '0.0.0.0', () => {
                        const localUrl = `http://localhost:${port}/qr.png`;
                        
                        // Obter IP da rede local
                        const networkInterfaces = os.networkInterfaces();
                        let networkIp = null;
                        for (const interfaceName of Object.keys(networkInterfaces)) {
                            for (const iface of networkInterfaces[interfaceName]) {
                                if (iface.family === 'IPv4' && !iface.internal) {
                                    networkIp = iface.address;
                                    break;
                                }
                            }
                            if (networkIp) break;
                        }
                        
                        const networkUrl = networkIp ? `http://${networkIp}:${port}/qr.png` : null;
                        
                        console.log("\n╔════════════════════════════════════════════════════════════╗");
                        console.log("║                    🔗 LINK DE ACESSO 🔗                     ║");
                        console.log("╠════════════════════════════════════════════════════════════╣");
                        console.log("║ Opção 1: Escaneie o QR code acima no WhatsApp             ║");
                        console.log("║                                                             ║");
                        console.log("║ Opção 2: Acesse o link abaixo para ver a imagem do QR:    ║");
                        console.log("║                                                             ║");
                        console.log(`║ ${localUrl}`);
                        if (networkUrl) {
                            console.log("║                                                             ║");
                            console.log("║ Link alternativo (rede local):                             ║");
                            console.log(`║ ${networkUrl}`);
                        }
                        console.log("║                                                             ║");
                        console.log("╚════════════════════════════════════════════════════════════╝\n");
                        console.log("💡 Dica: Abra o link no navegador para ver a imagem do QR code");
                        console.log("   e escaneie com o WhatsApp Web.\n");
                    });
                    
                } catch (error) {
                    console.error('❌ Erro ao criar servidor QR code:', error);
                    console.log("\n╔════════════════════════════════════════════════════════════╗");
                    console.log("║                    ⚠️  INFORMAÇÃO ⚠️                        ║");
                    console.log("╠════════════════════════════════════════════════════════════╣");
                    console.log("║ Por favor, escaneie o QR code acima no WhatsApp Web        ║");
                    console.log("║ O QR code contém dados de autenticação que precisam ser   ║");
                    console.log("║ escaneados diretamente pelo aplicativo WhatsApp.         ║");
                    console.log("╚════════════════════════════════════════════════════════════╝\n");
                }
            }
        }
        
        // Fechar servidor quando conectar
        if (connection === 'open' && qrServer) {
            console.log('🔒 Fechando servidor QR code temporário...');
            qrServer.close();
            qrServer = null;
        }

        console.log('📡 Status da conexão:', connection);

        if (connection === 'open') {
            logger.info('Conectado ao WhatsApp');
            resetReconnectAttempts();
            setConnected(true);
            
            // Iniciar serviços apenas uma vez após conexão bem-sucedida
            try {
                scheduleGroupMessages(sock);
                scheduleBackups();
                startScheduler(sock);
                scheduleSupabaseBackup();
                startAutoPromo(sock);
                startHealthMonitor();
                startSessionBackup();
                console.log('✅ Todos os serviços iniciados com sucesso');
            } catch (e) {
                console.error('❌ Erro ao iniciar serviços:', e.message);
            }
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            setConnected(false);
            
            if (reason === DisconnectReason.loggedOut) {
                console.log('⚠️ Sessão desconectada manualmente. Deletando credenciais antigas...');
                try {
                    const authPath = path.join(__dirname, 'auth_info');
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                        console.log('🗑️ Credenciais antigas removidas');
                    }
                } catch (e) {
                    console.error('Erro ao remover credenciais:', e.message);
                }
                console.log('🔄 Reiniciando para gerar novo QR code...');
                setTimeout(() => startBot(), 3000);
            } else {
                // Usar gerenciador de conexão para reconexões automáticas
                handleConnectionUpdate(update, startBot);
            }
        }
    });

    // Evento de mensagens recebidas
    sock.ev.on('messages.upsert', async (msgUpsert) => {
        const messages = msgUpsert.messages;
        
        // Atualizar heartbeat a cada mensagem processada
        updateHeartbeat();

        for (const message of messages) {
            // ========== 1. FILTROS INICIAIS (Fast Return) ==========
            if (!message.message) continue;
            if (message.key.fromMe) continue;
            
            const messageTimestamp = message.messageTimestamp ? parseInt(message.messageTimestamp) * 1000 : Date.now();
            if (messageTimestamp < botStartTime) continue;

            // ========== 2. SEPARAÇÃO DE CONTEXTO ==========
            const isGroup = message.key.remoteJid?.endsWith('@g.us');
            const senderId = message.key.participant || message.key.remoteJid;
            const chatId = message.key.remoteJid;
            
            // Extrair texto usando getText()
            const messageText = getText(message);
            if (!messageText || messageText.trim() === '') continue;

            // ========== 3. FLUXO PRIVADO (VENDAS) - DESABILITADO ==========
            if (!isGroup) {
                // Comando /dev (ativar modo desenvolvedor)
                if (messageText.startsWith('/dev')) {
                    await handleDevCommand(sock, message, messageText);
                    continue;
                }
                
                // Modo desenvolvedor ativo
                if (isDevModeActive(senderId)) {
                    await handleDevConversation(sock, senderId, messageText);
                    continue;
                }
                
                // Ignorar mensagens privadas (atendimento desabilitado)
                continue;
            }

            // ========== 4. FLUXO DE GRUPO ==========
            // Validar grupo autorizado
            let ALLOWED_GROUP_NAMES = new Set();
            try {
                const allowedPath = path.join(__dirname, 'allowed_groups.json');
                if (fs.existsSync(allowedPath)) {
                    const parsed = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
                    if (Array.isArray(parsed)) {
                        ALLOWED_GROUP_NAMES = new Set(parsed.map(s => s.trim()).filter(Boolean));
                    }
                }
            } catch (e) {
                console.warn('⚠️ Falha ao ler allowed_groups.json:', e.message);
            }

            let groupSubject = null;
            try {
                const groupMetadata = await sock.groupMetadata(chatId);
                groupSubject = groupMetadata.subject || '';
            } catch (e) {
                console.warn('⚠️ Falha ao obter metadata do grupo:', e.message);
            }

            if (!groupSubject || !ALLOWED_GROUP_NAMES.has(groupSubject)) {
                console.log('⏭️ Grupo NÃO autorizado:', groupSubject || chatId);
                continue;
            }

            console.log('✅ Grupo autorizado:', groupSubject);

            // 4.1. COMANDOS (prioridade máxima - mas moderação SEMPRE roda)
            const isCommand = messageText.startsWith('/');
            
            if (isCommand) {
                console.log('⚡ COMANDO detectado:', messageText.split(' ')[0]);
                
                // Comando DEV (funciona em grupo e privado)
                if (messageText.toLowerCase().startsWith('/dev')) {
                    await handleDevCommand(sock, message, messageText);
                    continue;
                }
                
                // Processar comando
                await handleGroupMessages(sock, message);
                // NÃO continue aqui - deixar moderação rodar
            }

            // 4.2. MODERAÇÃO MINIMALISTA (2 regras: REPEAT + LINK)
            // Verificar se é admin do bot ou do grupo
            let isUserAdmin = false;
            try {
                const isBotAdmin = await isAuthorized(senderId);
                const groupMetadata = await sock.groupMetadata(chatId);
                const participant = groupMetadata.participants.find(p => p.id === senderId);
                const isGroupAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                isUserAdmin = isBotAdmin || isGroupAdmin;
            } catch (e) {
                console.error('Erro ao verificar admin:', e.message);
            }
            
            // Aplicar anti-spam
            const violation = checkViolation(messageText, chatId, senderId, isUserAdmin);

            if (violation.violated) {
                console.log(`🚨 VIOLAÇÃO: ${violation.rule} - User: ${senderId}`);
                
                // Deletar mensagem
                try {
                    await sock.sendMessage(chatId, { delete: message.key });
                    console.log('✅ Mensagem deletada');
                } catch (e) {
                    console.error('❌ Erro ao deletar:', e.message);
                }
                
                // Adicionar strike
                const strikeCount = addStrike(chatId, senderId, violation.rule, messageText);
                console.log(`⚠️ Strike aplicado: ${strikeCount}/3`);
                
                // Aviso no grupo
                const warning = violation.rule === 'REPEAT' 
                    ? `⚠️ Evite repetir mensagens. (Strike ${strikeCount}/3)`
                    : `🚫 Links não são permitidos. (Strike ${strikeCount}/3)`;
                
                try {
                    await sock.sendMessage(chatId, { text: warning });
                } catch (e) {
                    console.error('❌ Erro ao enviar aviso:', e.message);
                }
                
                // Aplicar punição se 3/3
                if (strikeCount >= 3) {
                    await applyPunishment(sock, chatId, senderId, strikeCount);
                }
                
                // Bloquear processamento de comandos
                continue;
            }
            
            // Se foi comando e não violou, já foi processado
            if (isCommand) {
                continue;
            }
        }
    });

    // Evento para detectar novos membros no grupo
    sock.ev.on('group-participants.update', async (update) => {
        try {
            console.log('📋 Atualização de participantes:', JSON.stringify(update, null, 2));
            const { id: groupId, participants, action } = update;
            
            if (action === 'add') {
                console.log('\n🎉 ═══════════════════════════════════════════════════════');
                console.log('🎉 NOVO MEMBRO DETECTADO');
                console.log('🎉 Grupo:', groupId);
                console.log('🎉 ═══════════════════════════════════════════════════════\n');
                
                for (const participant of participants) {
                    console.log('👤 ➜ Enviando boas-vindas para:', participant);
                    await sendWelcomeMessage(sock, groupId, participant);
                    console.log('✅ ➜ Boas-vindas enviada\n');
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Delay de 1s
                }
            }
        } catch (error) {
            console.error('❌ Erro no evento de participantes:', error);
        }
    });

    // Evento alternativo para capturar mudanças no grupo
    sock.ev.on('groups.update', async (updates) => {
        console.log('🔄 Atualização de grupos:', JSON.stringify(updates, null, 2));
    });
}

startBot();
