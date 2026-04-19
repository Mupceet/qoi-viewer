import * as zlib from 'zlib';

export function encode(width: number, height: number, pixels: Uint8ClampedArray): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const rowSize = 1 + width * 4;
    const raw = Buffer.alloc(height * rowSize);
    for (let y = 0; y < height; y++) {
        raw[y * rowSize] = 0; // filter: None
        const srcOffset = y * width * 4;
        raw.set(pixels.subarray(srcOffset, srcOffset + width * 4), y * rowSize + 1);
    }

    const compressed = zlib.deflateSync(raw);

    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrChunk = makeChunk('IHDR', ihdr);
    const idatChunk = makeChunk('IDAT', compressed);
    const iendChunk = makeChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, typeBytes, data, crc]);
}

function crc32(buf: Buffer): number {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return ~crc >>> 0;
}
