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
import { checkViolation, notifyAdmins } from './functions/antiSpam.js';
import { addStrike, applyPunishment } from './functions/strikeSystem.js';
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

console.log('🤖 IA de Moderação:', isAIEnabled() ? '✅ ATIVA (Groq)' : '❌ Desabilitada');
console.log('💼 IA de Vendas:', isAISalesEnabled() ? '✅ ATIVA (Groq)' : '❌ Desabilitada');

// Variável para armazenar o servidor HTTP temporário
let qrServer = null;

// Timestamp de inicialização do bot para ignorar mensagens antigas
const botStartTime = Date.now();

async function startBot() {
    console.log("===============================================");
    console.log("🚀 Iniciando iMavyBot - Respostas Pré-Definidas");
    console.log("===============================================");
    console.log('🤖 IA Status: Groq (gratuito e rápido) para moderação automática!');
    console.log('⚙️ Sistema de lembretes avançado com encerramento automático ativo!');

    await ensureCoreConfigFiles();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        browser: ['Chrome (Linux)', '', ''],
        defaultQueryTimeoutMs: undefined
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
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 600 });
                console.log("\n🔗 LINK DO QR CODE (copie e cole no navegador):");
                console.log(qrDataUrl);
                console.log("\n");
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
            scheduleGroupMessages(sock);
            scheduleBackups();
            startScheduler(sock);
            scheduleSupabaseBackup();
            startAutoPromo(sock);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log('Motivo do fechamento:', reason);

            if (reason === DisconnectReason.loggedOut) {
                console.log('⚠️ Sessão desconectada. Escaneie o QR novamente.');
            } else {
                console.log('🔄 Reconectando em 5 segundos...');
                setTimeout(() => startBot(), 5000);
            }
        }
    });

    // Evento de mensagens recebidas
    sock.ev.on('messages.upsert', async (msgUpsert) => {
        const messages = msgUpsert.messages;

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
            
            const contentType = getContentType(message.message);
            const content = message.message[contentType];
            const messageText = content?.text || content;
            
            if (typeof messageText !== 'string') continue;

            // ========== 3. FLUXO PRIVADO (VENDAS) ==========
            if (!isGroup) {
                console.log('📱 FLUXO VENDAS:', senderId);
                
                // Comando direto para atendente
                if (messageText.toLowerCase().trim() === '/valores') {
                    await sock.sendMessage(senderId, { text: '✅ Recebemos sua solicitação! Um atendente entrará em contato em breve.' });
                    await notifyAttendants(sock, senderId, senderId.split('@')[0], getAdmins);
                    continue;
                }
                
                // IA para qualificar lead
                if (isAISalesEnabled()) {
                    try {
                        const aiResponse = await Promise.race([
                            analyzeLeadIntent(messageText, senderId),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 5000))
                        ]);
                        
                        console.log('🤖 IA:', aiResponse.intent, `(${aiResponse.confidence}%)`);
                        
                        await sock.sendMessage(senderId, { text: aiResponse.response });
                        
                        // Se cliente demonstrou interesse alto, notificar atendentes
                        if (aiResponse.needsHuman || (aiResponse.intent === 'interested' && aiResponse.confidence > 70)) {
                            await notifyAttendants(sock, senderId, senderId.split('@')[0], getAdmins);
                        }
                        
                        continue;
                    } catch (e) {
                        console.warn('⚠️ IA vendas falhou:', e.message);
                    }
                }
                
                // Fallback se IA estiver desabilitada
                if (messageText.toLowerCase().trim() === 'sim' && isVerified(senderId)) {
                    await sendAttendanceMessage(sock, senderId);
                    continue;
                }
                
                if (detectClientInterest(messageText) && shouldSendAttendance(senderId)) {
                    await sendVerificationMessage(sock, senderId);
                    markAsVerified(senderId);
                    continue;
                }
                
                await sock.sendMessage(senderId, { 
                    text: '👋 Olá! Sou o iMavyBot.\n\nDigite *sim* se tiver interesse em nossos serviços ou */valores* para falar com um atendente.' 
                });
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

            // 4.1. COMANDOS (prioridade máxima)
            if (messageText.startsWith('/')) {
                console.log('⚡ COMANDO detectado:', messageText.split(' ')[0]);
                await handleGroupMessages(sock, message);
                continue;
            }

            // 4.2. MODERAÇÃO
            const violation = checkViolation(messageText);
            let aiViolation = null;

            if (isAIEnabled() && messageText.length > 10 && !violation.violated) {
                try {
                    const aiResult = await Promise.race([
                        analyzeMessage(messageText),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 5000))
                    ]);
                    if (!aiResult.safe) {
                        aiViolation = { violated: true, type: `IA: ${aiResult.reason}` };
                    }
                } catch (e) {
                    console.warn('⚠️ IA timeout/erro:', e.message);
                }
            }

            const finalViolation = violation.violated ? violation : aiViolation;

            if (finalViolation?.violated) {
                console.log('🚨 VIOLAÇÃO:', finalViolation.type);
                
                try {
                    await sock.sendMessage(chatId, { delete: message.key });
                } catch (e) {
                    console.error('Erro ao deletar:', e.message);
                }
                
                await notifyAdmins(sock, chatId, { userId: senderId, message: messageText });
                await addStrike(senderId, { type: finalViolation.type, message: messageText });
                await applyPunishment(sock, chatId, senderId);
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
