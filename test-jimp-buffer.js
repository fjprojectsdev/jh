import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');

async function test() {
    try {
        console.log('Criando imagem...');
        const img = new Jimp({ width: 100, height: 100, color: 0xffffffff });
        console.log('Imagem criada.');

        console.log('Gerando buffer PNG...');
        const pngBuffer = await img.getBuffer('image/png');
        fs.writeFileSync('test_out.png', pngBuffer);

        const stats = fs.statSync('test_out.png');
        if (stats.size <= 0) {
            throw new Error('Arquivo gerado vazio');
        }

        console.log('✅ Write sucesso! Tamanho:', stats.size);
    } catch (error) {
        console.error('❌ Falha no write de PNG:', error);
        process.exitCode = 1;
    }
}

await test();
