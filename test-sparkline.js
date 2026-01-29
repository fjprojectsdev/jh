import { renderSparklinePng } from './functions/crypto/chart.js';
import fs from 'fs';

async function test() {
    console.log('Testando renderSparklinePng...');
    const points = [
        { priceUsd: 100 },
        { priceUsd: 105 },
        { priceUsd: 102 },
        { priceUsd: 110 }
    ];

    try {
        const pngBuffer = await renderSparklinePng(points, { width: 700, height: 360 });
        console.log('✅ Buffer gerado com sucesso. Tamanho:', pngBuffer.length);
        fs.writeFileSync('test_chart.png', pngBuffer);
        console.log('✅ Imagem salva como test_chart.png');
    } catch (e) {
        console.error('❌ Erro renderSparklinePng:', e);
        process.exit(1);
    }
}

test();
