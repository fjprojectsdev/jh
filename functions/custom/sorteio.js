import { sendSafeMessage } from './../messageHandler.js';

const sorteiosAtivos = new Map();

export async function handleSorteio(sock, message, text) {
  console.log('🎲 handleSorteio EXECUTADO - text:', text);
  const chatId = message.key.remoteJid;
  const senderId = message.key.participant || message.key.remoteJid;
  const normalizedText = text.toLowerCase();
  console.log('🎲 chatId:', chatId, 'senderId:', senderId);

  if (normalizedText.includes('!participar')) {
    if (!sorteiosAtivos.has(chatId)) {
      await sendSafeMessage(sock, chatId, { text: '❌ Nenhum sorteio ativo!' });
      return;
    }
    const sorteio = sorteiosAtivos.get(chatId);
    if (!sorteio.participantes.includes(senderId)) {
      sorteio.participantes.push(senderId);
      await sendSafeMessage(sock, chatId, { text: `✅ Você entrou! Total: ${sorteio.participantes.length}` });
    } else {
      await sendSafeMessage(sock, chatId, { text: '⚠️ Você já está participando!' });
    }
    return;
  }

  if (sorteiosAtivos.has(chatId)) {
    await sendSafeMessage(sock, chatId, { text: '⚠️ Já existe um sorteio ativo!' });
    return;
  }

  const duracao = 60;
  sorteiosAtivos.set(chatId, { participantes: [], iniciador: senderId });

  await sendSafeMessage(sock, chatId, {
    text: `🎲 *SORTEIO INICIADO!*\n\n📝 Digite *!participar* para entrar\n⏰ Duração: ${duracao}s`
  });

  setTimeout(async () => {
    const sorteio = sorteiosAtivos.get(chatId);
    if (!sorteio || sorteio.participantes.length === 0) {
      await sendSafeMessage(sock, chatId, { text: '❌ Sorteio cancelado - sem participantes' });
      sorteiosAtivos.delete(chatId);
      return;
    }

    const vencedor = sorteio.participantes[Math.floor(Math.random() * sorteio.participantes.length)];
    const numero = vencedor.split('@')[0];

    await sendSafeMessage(sock, chatId, {
      text: `🎉 *VENCEDOR DO SORTEIO!*\n\n🏆 @${numero}\n\n👥 Participantes: ${sorteio.participantes.length}`,
      mentions: [vencedor]
    });

    sorteiosAtivos.delete(chatId);
  }, duracao * 1000);
}