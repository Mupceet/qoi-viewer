import { parentPort } from 'worker_threads';
import { decode, decodeStreaming, parseHeader } from './decodeQoi';

const CHUNK_BYTE_LIMIT = 4 * 1024 * 1024; // 4MB per streamed chunk

parentPort?.on('message', (msg: { type: 'decode'; data: ArrayBuffer; streamThreshold: number }) => {
    if (msg.type !== 'decode') return;
    const t0 = Date.now();
    const fileData = new Uint8Array(msg.data);

    try {
        const header = parseHeader(fileData);
        const decodedSize = header.width * header.height * 4;

        if (decodedSize <= msg.streamThreshold) {
            // Small file: full decode, single result
            const image = decode(fileData);
            const decodeMs = Date.now() - t0;
            const pixels = image.pixels;
            const ab = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) as ArrayBuffer;
            parentPort?.postMessage({
                type: 'result',
                success: true,
                image: { pixels: ab, width: image.width, height: image.height, channels: image.channels, colorspace: image.colorspace },
                timing: { decode: decodeMs },
            }, [ab]);
        } else {
            // Large file: streaming decode
            let chunkCount = 0;
            decodeStreaming(fileData, (pixels, offsetY, rowCount, hdr) => {
                chunkCount++;
                if (hdr) {
                    parentPort?.postMessage({
                        type: 'streamInit',
                        width: hdr.width, height: hdr.height,
                        channels: hdr.channels, colorspace: hdr.colorspace,
                        fileSize: hdr.fileSize,
                        timing: { firstChunk: Date.now() - t0 },
                    });
                }
                const ab = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) as ArrayBuffer;
                parentPort?.postMessage({
                    type: 'streamChunk',
                    offsetY, rowCount, data: ab,
                }, [ab]);
            }, CHUNK_BYTE_LIMIT);

            parentPort?.postMessage({
                type: 'streamDone',
                timing: { decode: Date.now() - t0 },
                chunkCount,
            });
        }
    } catch (e) {
        parentPort?.postMessage({
            type: 'streamError',
            errorMessage: e instanceof Error ? e.message : String(e),
            timing: { decode: Date.now() - t0 },
        });
    }
});
