import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');

async function testMethods() {
    console.log('Testing Jimp methods...');
    try {
        const img = new Jimp({ width: 100, height: 100, color: 0xffffffff });
        console.log('Instance created');

        console.log('Testing setPixelColor...');
        img.setPixelColor(0x000000ff, 10, 10);
        console.log('Pixel set');

        console.log('Testing getBufferAsync...');
        if (img.getBufferAsync) {
            await img.getBufferAsync('image/png');
            console.log('Buffer ok');
        } else if (img.getBuffer) {
            console.log('Has getBuffer (sync/callback)');
        } else {
            console.log('No getBuffer method found!');
            console.log('Methods:', Object.keys(img));
            // Also check prototype
            console.log('Proto methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(img)));
        }


        console.log('Jimp.MIME_PNG:', Jimp.MIME_PNG);
        console.log('Jimp keys:', Object.keys(Jimp));
    } catch (e) {
        console.error('ERROR:', e);
    }
}

testMethods();
