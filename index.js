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
import { checkViolation, notifyAdmins, notifyUser, logViolation } from './functions/antiSpam.js';
import { addStrike, applyPunishment } from './functions/strikeSystem.js';
import { incrementViolation, getGroupStatus } from './functions/groupStats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { handleGroupMessages } from './functions/groupResponder.js';
import { isAuthorized } from './functions/adminCommands.js';
import { getNumberFromJid, formatNumberInternational } from './functions/utils.js';
import { scheduleGroupMessages } from './functions/scheduler.js';

// Variável para armazenar o servidor HTTP temporário
let qrServer = null;

async function startBot() {
    console.log("===============================================");
    console.log("🚀 Iniciando iMavyBot - Respostas Pré-Definidas");
    console.log("===============================================");



    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false
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
            
            // Gerar QR code no terminal (tamanho maior para melhor leitura)
            qrcode.generate(qr, { small: false });
            
            // Criar servidor HTTP temporário para servir a imagem do QR code
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
        
        // Fechar servidor quando conectar
        if (connection === 'open' && qrServer) {
            console.log('🔒 Fechando servidor QR code temporário...');
            qrServer.close();
            qrServer = null;
        }

        console.log('📡 Status da conexão:', connection);

        if (connection === 'open') {
            console.log('✅ Conectado ao WhatsApp com sucesso!');
            // Ativa o agendador (fechar e abrir grupo)
            scheduleGroupMessages(sock);
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
                    // Verifique se o bot deve atuar neste grupo (ALLOWED_GROUP_NAMES via .env e arquivo allowed_groups.json)
                    const envAllowedList = (process.env.ALLOWED_GROUP_NAMES || '').split(',').map(s => s.trim()).filter(Boolean);
                    const envAllowedUsers = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
                    let fileAllowedList = [];
                    let fileAllowedUsers = [];
                    try {
                        const allowedPath = path.join(__dirname, 'allowed_groups.json');
                        if (fs.existsSync(allowedPath)) {
                            const raw = fs.readFileSync(allowedPath, 'utf8');
                            const parsed = JSON.parse(raw);
                            if (Array.isArray(parsed)) fileAllowedList = parsed;
                        }
                    } catch (e) {
                        console.warn('⚠️ Falha ao ler allowed_groups.json:', e.message);
                    }

                    try {
                        const allowedUsersPath = path.join(__dirname, 'allowed_users.json');
                        if (fs.existsSync(allowedUsersPath)) {
                            const raw = fs.readFileSync(allowedUsersPath, 'utf8');
                            const parsed = JSON.parse(raw);
                            if (Array.isArray(parsed)) fileAllowedUsers = parsed;
                        }
                    } catch (e) {
                        console.warn('⚠️ Falha ao ler allowed_users.json:', e.message);
                    }

                    const ALLOWED_GROUP_NAMES = new Set([...envAllowedList, ...fileAllowedList].map(s => s.trim()).filter(Boolean));
                    const ALLOWED_USER_IDS = new Set([...envAllowedUsers, ...fileAllowedUsers].map(s => s.trim()).filter(Boolean));
                // processar mensagens imediatamente

                const senderId = message.key.participant || message.key.remoteJid;
                const isGroup = message.key.remoteJid && message.key.remoteJid.endsWith('@g.us');
                const groupId = isGroup ? message.key.remoteJid : null;

                // Se for mensagem de grupo, buscar metadados e validar pela lista de grupos autorizados
                let groupSubject = null;
                let groupMetadataForCheck = null;
                if (isGroup) {
                    try {
                        groupMetadataForCheck = await sock.groupMetadata(groupId);
                        groupSubject = groupMetadataForCheck.subject || '';
                    } catch (e) {
                        console.warn('⚠️ Falha ao obter metadata do grupo:', e.message);
                    }

                    // Verificar se o grupo está na lista de autorizados
                    if (!groupSubject || !ALLOWED_GROUP_NAMES.has(groupSubject)) {
                        console.log('⏭️ Grupo NÃO autorizado — ignorando:', groupSubject || groupId);
                        continue;
                    }
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
                
                // Ignorar anti-spam para comandos administrativos (inclui comandos de gerenciamento de autorização)
                const isAdminCommand = messageText && typeof messageText === 'string' && (
                    messageText.toLowerCase().includes('/removertermo') ||
                    messageText.toLowerCase().includes('/removerlink') ||
                    messageText.toLowerCase().includes('/bloqueartermo') ||
                    messageText.toLowerCase().includes('/bloquearlink') ||
                    messageText.toLowerCase().includes('/listatermos') ||
                    messageText.toLowerCase().includes('/adicionargrupo') ||
                    messageText.toLowerCase().includes('/removergrupo') ||
                    messageText.toLowerCase().includes('/listargrupos') ||
                    messageText.toLowerCase().includes('/adicionaradmin') ||
                    messageText.toLowerCase().includes('/removeradmin') ||
                    messageText.toLowerCase().includes('/listaradmins')
                );

                if (isAdminCommand) {
                    console.log('⚙️ Comando administrativo detectado, pulando anti-spam');
                    await handleGroupMessages(sock, message);
                    continue;
                }

                // Restringir respostas em privados para IDs autorizados/permitidos
                    if (!isGroup) {
                    if (ALLOWED_USER_IDS.size > 0 && !ALLOWED_USER_IDS.has(senderId) && !(await isAuthorized(senderId))) {
                        console.log('⏭️ PV não autorizado — ignorando:', senderId);
                        continue;
                    }
                }

                // Verificar violações (anti-spam)
                console.log('🔍 DEBUG: Verificando anti-spam...');
                console.log('🔍 isGroup:', isGroup);
                console.log('🔍 messageText:', messageText);
                console.log('🔍 typeof:', typeof messageText);
                
                if (isGroup && typeof messageText === 'string') {
                    // Verificar se o remetente é administrador — admins não devem ser barrados pelo sistema
                    let isSenderAdmin = false;
                    try {
                        const groupMetadataForCheck = await sock.groupMetadata(groupId);
                        const participant = groupMetadataForCheck.participants.find(p => p.id === senderId);
                        if (participant && (participant.admin || participant.isAdmin)) {
                            isSenderAdmin = true;
                        }
                    } catch (e) {
                        console.warn('⚠️ Não foi possível obter metadata do grupo para checar admin:', e.message);
                    }

                    if (isSenderAdmin) {
                        console.log('🔰 Remetente é administrador — pulando checagem de violação');
                        await handleGroupMessages(sock, message);
                        continue;
                    }

                    console.log('🔍 Executando checkViolation...');
                    const violation = checkViolation(messageText);
                    console.log('🔍 Resultado:', violation);
                    
                    if (violation.violated) {
                        console.log('\n🚨 ═══════════════════════════════════════════════════════');
                        console.log('🚨 VIOLAÇÃO DETECTADA!');
                        console.log('🚨 Tipo:', violation.type);
                        console.log('🚨 Usuário:', senderId);
                        console.log('🚨 Mensagem:', messageText.substring(0, 50));
                        console.log('🚨 ═══════════════════════════════════════════════════════\n');
                        
                        // Deletar mensagem
                        try {
                            await sock.sendMessage(groupId, {
                                delete: message.key
                            });
                            console.log('✅ ➜ Mensagem deletada com sucesso');
                        } catch (e) {
                            console.error('❌ ➜ Erro ao deletar mensagem:', e.message);
                        }
                        
                        // Obter informações do usuário
                        const userNumber = senderId.split('@')[0];
                        const violationData = {
                            userName: userNumber,
                            userId: senderId,
                            userNumber: userNumber,
                            dateTime: new Date().toLocaleString('pt-BR'),
                            message: messageText
                        };
                        
                        // Notificar admins
                        console.log('📢 ➜ Notificando administradores...');
                        await notifyAdmins(sock, groupId, violationData);
                        
                        // Notificar usuário
                        console.log('📩 ➜ Notificando usuário infrator...');
                        await notifyUser(sock, senderId, groupId, messageText);
                        
                        // Registrar violação
                        logViolation(violationData);
                        incrementViolation(violation.type);
                        
                        // Sistema de strikes
                        console.log('⚖️ ➜ Aplicando sistema de strikes...');
                        const strikeCount = addStrike(senderId, { type: violation.type, message: messageText });
                        console.log(`📊 ➜ Usuário agora tem ${strikeCount} strike(s)`);
                        
                        // Aplicar punição baseada no número de strikes
                        await applyPunishment(sock, groupId, senderId, strikeCount);
                        
                        console.log('✅ ➜ Violação processada completamente\n');
                        
                        continue; // Pular processamento normal
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
