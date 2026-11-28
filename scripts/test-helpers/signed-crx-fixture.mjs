import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.bytes ?? '');
    const method = entry.method ?? 8;
    const packed = entry.packed ?? (method === 0 ? bytes : deflateRawSync(bytes, entry.deflate));
    const crc = entry.crc ?? crc32(bytes), expandedSize = entry.expandedSize ?? bytes.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(expandedSize, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(expandedSize, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(entry.externalAttributes ?? 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); central.push(directory, name); offset += local.length + name.length + packed.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}

function varint(value) {
  const result = [];
  do { const part = value & 127; value >>>= 7; result.push(value ? part | 128 : part); } while (value);
  return Buffer.from(result);
}
function field(number, bytes) { return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]); }

export function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ format: 'der', type: 'spki' });
  const idBytes = createHash('sha256').update(key).digest().subarray(0, 16);
  const id = [...idBytes].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  return {
    id, key,
    package(entries) {
      const archive = zip(entries), signedData = field(1, idBytes), length = Buffer.alloc(4);
      length.writeUInt32LE(signedData.length);
      const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signedData, archive]), privateKey);
      const header = Buffer.concat([field(2, Buffer.concat([field(1, key), field(2, signature)])), field(10000, signedData)]);
      const prefix = Buffer.alloc(12); prefix.write('Cr24'); prefix.writeUInt32LE(3, 4); prefix.writeUInt32LE(header.length, 8);
      return Buffer.concat([prefix, header, archive]);
    }
  };
}
