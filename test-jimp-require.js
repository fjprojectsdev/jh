import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const JimpPkg = require('jimp');

console.log('Type of require("jimp"):', typeof JimpPkg);
console.log('Is constructor class?', JimpPkg?.prototype?.constructor === JimpPkg);
console.log('Attempting new JimpPkg(10,10):');
try {
    new JimpPkg(10, 10);
    console.log('Success new JimpPkg(w,h)');
} catch (e) { console.log('Fail:', e.message); }

console.log('JimpPkg.Jimp:', JimpPkg.Jimp);
