import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('jimp');

console.log('START SEARCH');
if (typeof pkg === 'function') console.log('FOUND: Root is constructor');
if (pkg.Jimp && typeof pkg.Jimp === 'function') console.log('FOUND: pkg.Jimp is constructor');
if (pkg.default && typeof pkg.default === 'function') console.log('FOUND: pkg.default is constructor');
console.log('END SEARCH');
