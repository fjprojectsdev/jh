
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

try {
    const JimpRequire = require('jimp');
    console.log('Type of require("jimp"):', typeof JimpRequire);
    console.log('Keys of require("jimp"):', Object.keys(JimpRequire));
    console.log('Is JimpRequire a constructor?', typeof JimpRequire === 'function' && !!JimpRequire.prototype && !!JimpRequire.prototype.constructor.name);

    if (JimpRequire.default) {
        console.log('Has .default export');
        console.log('Type of .default:', typeof JimpRequire.default);
    }
    if (JimpRequire.Jimp) {
        console.log('Has .Jimp export');
        console.log('Type of .Jimp:', typeof JimpRequire.Jimp);
    }
} catch (e) {
    console.error('Require failed:', e.message);
}

import * as JimpImport from 'jimp';
console.log('Type of import * as Jimp:', typeof JimpImport);
console.log('Keys of import * as Jimp:', Object.keys(JimpImport));
