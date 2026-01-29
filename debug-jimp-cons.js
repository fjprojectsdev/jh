
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');

async function test() {
    console.log('Testing Jimp constructor...');

    try {
        // Attempt 1: Old style (will fail based on user report)
        console.log('Trying new Jimp(100, 100, 0xffffffff)...');
        // const img1 = new Jimp(100, 100, 0xffffffff); 
        // console.log('Success 1');
    } catch (e) { console.log('Fail 1:', e.message); }

    try {
        // Attempt 2: Options object
        console.log('Trying new Jimp({ width: 100, height: 100, color: 0xffffffff })...');
        const img2 = new Jimp({ width: 100, height: 100, color: 0xffffffff });
        console.log('Success 2');
    } catch (e) {
        console.log('Fail 2:', e.message);
        // console.log(e);
    }

    try {
        // Attempt 3: Static create method?
        if (Jimp.create) {
            console.log('Trying Jimp.create(100, 100)...');
            const img3 = await Jimp.create(100, 100, 0xffffffff);
            console.log('Success 3');
        }
    } catch (e) { console.log('Fail 3:', e.message); }
}

test();
