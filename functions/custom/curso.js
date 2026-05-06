import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendSafeMessage } from './../messageHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CURSO_IMAGE_PATH = path.join(__dirname, '..', '..', 'assets', 'curso-lamina.png');
const CURSO_CAPTION = `🚨 A maioria perde dinheiro em cripto porque entra sem estratégia.

Compra por hype, segue os outros e chega tarde.

Foi por isso que nasceu a Vellora Bitcoin School: um treinamento para quem quer entender o mercado de verdade, montar uma carteira estratégica e tomar decisões melhores.

No curso você aprende a identificar oportunidades, proteger seu capital, entender os ciclos do mercado e evitar erros comuns.

Além disso, recebe acesso à comunidade, ferramentas, análises e checklist de segurança.

Hoje o acesso está em condição especial por R$59,90.

👉 https://lp.appvellora.com/cursovellora

O próximo ciclo vai acontecer.
A pergunta é: você vai estar preparado ou só assistindo? 🚀`;

export async function handleCurso(sock, message) {
    const chatId = message?.key?.remoteJid;
    if (!chatId || !fs.existsSync(CURSO_IMAGE_PATH)) return null;

    return sendSafeMessage(sock, chatId, {
        image: fs.readFileSync(CURSO_IMAGE_PATH),
        caption: CURSO_CAPTION
    });
}
