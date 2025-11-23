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

console.log('🤖 IA de Moderação:', isAIEnabled() ? '✅ ATIVA (Groq)' : '❌ Desabilitada');

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
    
    let version;
    try {
        const result = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        version = result.version;
        console.log('✅ Versão Baileys:', version.join('.'));
    } catch {
        version = [2, 3000, 1017531287];
        console.log('⚠️ Usando versão padrão Baileys');
    }

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false
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
            if (!message.key.fromMe && message.message) {
                // Ignorar mensagens do próprio bot
                const botId = sock.user?.id;
                const msgSender = message.key.participant || message.key.remoteJid;
                if (msgSender === botId) {
                    continue;
                }
                // Ignorar mensagens antigas (enviadas antes da inicialização do bot)
                const messageTimestamp = message.messageTimestamp ? parseInt(message.messageTimestamp) * 1000 : Date.now();
                if (messageTimestamp < botStartTime) {
                    console.log('⏭️ Ignorando mensagem antiga:', new Date(messageTimestamp).toLocaleString());
                    continue;
                }
                
                // Carregar grupos permitidos
                    let ALLOWED_GROUP_NAMES = new Set();
                    try {
                        const allowedPath = path.join(__dirname, 'allowed_groups.json');
                        if (fs.existsSync(allowedPath)) {
                            const raw = fs.readFileSync(allowedPath, 'utf8');
                            const parsed = JSON.parse(raw);
                            if (Array.isArray(parsed)) {
                                ALLOWED_GROUP_NAMES = new Set(parsed.map(s => s.trim()).filter(Boolean));
                            }
                        }
                    } catch (e) {
                        console.warn('⚠️ Falha ao ler allowed_groups.json:', e.message);
                    }
                // processar mensagens imediatamente

                const senderId = message.key.participant || message.key.remoteJid;
                const isGroup = message.key.remoteJid && message.key.remoteJid.endsWith('@g.us');
                const groupId = isGroup ? message.key.remoteJid : null;
                
                console.log('🔍 DEBUG - Mensagem recebida:');
                console.log('- senderId:', senderId);
                console.log('- isGroup:', isGroup);
                console.log('- remoteJid:', message.key.remoteJid);

                // Se for mensagem de grupo, buscar metadados e validar pela lista de grupos autorizados
                let groupSubject = null;
                let groupMetadataForCheck = null;
                if (isGroup) {
                    try {
                        groupMetadataForCheck = await sock.groupMetadata(groupId);
                        groupSubject = groupMetadataForCheck.subject || '';
                        console.log('🔍 DEBUG - Nome do grupo:', groupSubject);
                        console.log('🔍 DEBUG - Grupos autorizados:', Array.from(ALLOWED_GROUP_NAMES));
                    } catch (e) {
                        console.warn('⚠️ Falha ao obter metadata do grupo:', e.message);
                    }

                    // Verificar se o grupo está na lista de autorizados
                    if (!groupSubject || !ALLOWED_GROUP_NAMES.has(groupSubject)) {
                        console.log('⏭️ Grupo NÃO autorizado — ignorando:', groupSubject || groupId);
                        console.log('🔍 DEBUG - Lista completa de grupos permitidos:', ALLOWED_GROUP_NAMES);
                        continue;
                    } else {
                        console.log('✅ Grupo AUTORIZADO - processando:', groupSubject);
                    }
                } else {
                    // Para mensagens privadas, permitir processamento
                    console.log('📱 Processando mensagem privada de:', senderId);
                }

                const contentType = getContentType(message.message);
                const content = message.message[contentType];

                console.log('\n╔════════════════════════════════════════════════════════════╗');
                console.log('║           📨 NOVA MENSAGEM RECEBIDA                       ║');
                console.log('╠════════════════════════════════════════════════════════════╣');
                // Tentar obter JID real do participante quando for mensagem de grupo
                let jidForNumber = senderId;
                try {
                    if (isGroup && groupMetadataForCheck && groupMetadataForCheck.participants) {
                        const participant = groupMetadataForCheck.participants.find(p => p.id === senderId || p.id === (senderId));
                        if (participant && participant.jid) {
                            jidForNumber = participant.jid;
                        }
                    }
                } catch (e) {
                    // falha ao acessar participant, continuar com senderId
                }

                const senderNumber = getNumberFromJid(jidForNumber) || '';
                const senderNumberIntl = senderNumber ? formatNumberInternational(senderNumber) : '';
                console.log('║ 📋 Tipo:', contentType.padEnd(45), '║');
                console.log('║ 👤 De:', senderId.substring(0, 45).padEnd(47), '║');
                console.log('║ 📞 Número:', (senderNumberIntl || senderNumber).padEnd(43), '║');
                if (groupId) console.log('║ 👥 Grupo:', groupId.substring(0, 42).padEnd(44), '║');
                console.log('║ 💬 Texto:', (content?.text || 'N/A').substring(0, 43).padEnd(45), '║');

                // Debug: se for PV e não conseguimos extrair um número razoável, logar informações para análise
                if (!isGroup) {
                    const numDigits = (senderNumber || '').replace(/\D/g, '').length;
                    if (!senderNumber || numDigits < 8) {
                        console.warn('⚠️ DEBUG: PV sem número extraído ou número curto. Exibindo chaves relevantes para inspeção.');
                        console.warn('⚠️ DEBUG senderId:', senderId);
                        try {
                            console.warn('⚠️ DEBUG message.key:', JSON.stringify(message.key));
                        } catch (e) {
                            console.warn('⚠️ DEBUG: falha ao serializar message.key');
                        }
                    }
                }
                console.log('╚════════════════════════════════════════════════════════════╝\n');

                const messageText = content?.text || content;
                
                // Atendimento automático em PV
                if (!isGroup && typeof messageText === 'string') {
                    console.log('📱 Processando mensagem privada de:', senderId);
                    
                    // Comando /valores - notifica atendentes
                    if (messageText.toLowerCase().trim() === '/valores') {
                        await sock.sendMessage(senderId, { text: '✅ Recebemos sua solicitação! Um atendente entrará em contato em breve.' });
                        await notifyAttendants(sock, senderId, senderId.split('@')[0], getAdmins);
                        continue;
                    }
                    
                    // Verifica se usuário confirmou interesse
                    if (messageText.toLowerCase().trim() === 'sim' && isVerified(senderId)) {
                        await sendAttendanceMessage(sock, senderId);
                        continue;
                    }
                    
                    // Detecta interesse e envia verificação
                    if (detectClientInterest(messageText) && shouldSendAttendance(senderId)) {
                        await sendVerificationMessage(sock, senderId);
                        markAsVerified(senderId);
                        continue;
                    }
                }

                // Verificar violações em grupos
                if (isGroup && typeof messageText === 'string') {
                    // 1. Verificar palavras banidas
                    const violation = checkViolation(messageText);
                    
                    // 2. Verificar com IA (se habilitada)
                    let aiViolation = null;
                    if (isAIEnabled() && messageText.length > 10) {
                        const aiResult = await analyzeMessage(messageText);
                        if (!aiResult.safe) {
                            aiViolation = { violated: true, type: `IA: ${aiResult.reason}` };
                        }
                    }
                    
                    const finalViolation = violation.violated ? violation : aiViolation;
                    
                    if (finalViolation?.violated) {
                        console.log('🚨 VIOLAÇÃO:', finalViolation.type);
                        
                        // Deletar mensagem
                        try {
                            await sock.sendMessage(groupId, { delete: message.key });
                        } catch (e) {
                            console.error('Erro ao deletar:', e.message);
                        }
                        
                        // Notificar admins
                        await notifyAdmins(sock, groupId, {
                            userId: senderId,
                            message: messageText
                        });
                        
                        // Sistema de strikes
                        await addStrike(senderId, { type: finalViolation.type, message: messageText });
                        await applyPunishment(sock, groupId, senderId);
                        
                        continue;
                    }
                }

                await handleGroupMessages(sock, message);
                
                // Teste manual de boas-vindas
                if (isGroup && messageText === '/testar_boasvindas') {
                    console.log('\n🧪 ═══════════════════════════════════════════════════════');
                    console.log('🧪 TESTE DE BOAS-VINDAS');
                    console.log('🧪 ═══════════════════════════════════════════════════════\n');
                    const msgBoasVindas = await sendWelcomeMessage(sock, groupId, senderId);
                    console.log(msgBoasVindas ? '✅ ➜ Boas-vindas enviada\n' : '❌ ➜ Falha ao enviar boas-vindas\n');
                }
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
