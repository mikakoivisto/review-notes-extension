// One-off: generates the PUBLIC key used to pin the extension id (manifest "key").
// The private key is discarded on purpose; it is not needed for unpacked/dev use.
import { generateKeyPairSync, createHash } from 'node:crypto';
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const id = [...createHash('sha256').update(der).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
console.log(JSON.stringify({ key: der.toString('base64'), id }, null, 2));
