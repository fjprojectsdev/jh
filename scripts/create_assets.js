import { Jimp } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const TARGET_FILE = path.join(ASSETS_DIR, 'whatsapp-invite-thumb.jpg');

async function createAsset() {
    try {
        // Criar imagem 100x100 verde, similar ao WhatsApp
        const image = new Jimp({ width: 100, height: 100, color: '#25D366' });

        await image.write(TARGET_FILE);
        console.log('Asset criado com sucesso:', TARGET_FILE);
    } catch (e) {
        console.error('Erro criando asset:', e);
    }
}

createAsset();
