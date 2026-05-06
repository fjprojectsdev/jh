import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendSafeMessage } from './../messageHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAP_IMAGE_PATH = path.join(__dirname, '..', '..', 'assets', 'buy-alert-vellora.png');

const CAPTION = `🚀 O EARN de 10% ao ano em USDT da Vellora já está pegando fogo!
Muita gente já entrou e está aproveitando essa oportunidade.

🤝 Em parceria com o token NIX, o modelo ainda ajuda a gerar mais pressão de queima, fortalecendo todo o ecossistema.

💰 Estamos facilitando o acesso:
✔️ Investimento via PIX ou USDT
✔️ Processo simples e rápido
✔️ Suporte direto pra te ajudar

Se quiser entender melhor ou entrar, me chama no privado 📩

velloracap.com`;

export async function handleCap(sock, message) {
    const chatId = message?.key?.remoteJid;
    if (!chatId) return null;

    if (fs.existsSync(CAP_IMAGE_PATH)) {
        return sendSafeMessage(sock, chatId, {
            image: fs.readFileSync(CAP_IMAGE_PATH),
            caption: CAPTION
        });
    }

    return sendSafeMessage(sock, chatId, { text: CAPTION });
}
