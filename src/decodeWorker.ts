import { parentPort } from 'worker_threads';
import { decode } from './decodeQoi';

parentPort?.on('message', (msg: { type: 'decode'; data: ArrayBuffer }) => {
    if (msg.type !== 'decode') return;
    const t0 = Date.now();
    try {
        const fileData = new Uint8Array(msg.data);
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
    } catch (e) {
        parentPort?.postMessage({
            type: 'result',
            success: false,
            errorMessage: e instanceof Error ? e.message : String(e),
            timing: { decode: Date.now() - t0 },
        });
    }
});
