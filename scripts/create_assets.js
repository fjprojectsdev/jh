
import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

async function createWhatsAppInviteThumb() {
    const targetPath = path.join(ASSETS_DIR, 'whatsapp-invite-thumb.jpg');

    // Create a NEW image 100x100 (standard thumb size)
    // Green color #25D366 (WhatsApp Green)
    const image = new Jimp({ width: 100, height: 100, color: 0x25D366FF });

    await image.write(targetPath);
    console.log(`✅ Thumbnail criada em: ${targetPath}`);
}

createWhatsAppInviteThumb();
