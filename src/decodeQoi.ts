const QOI_MAGIC_STR = 'qoif';
const QOI_MAGIC = QOI_MAGIC_STR.charCodeAt(0) << 24 |
    QOI_MAGIC_STR.charCodeAt(1) << 16 |
    QOI_MAGIC_STR.charCodeAt(2) << 8 |
    QOI_MAGIC_STR.charCodeAt(3);

const QOI_OP_INDEX = 0x00; // 00xxxxxx
const QOI_OP_DIFF = 0x40; // 01xxxxxx
const QOI_OP_LUMA = 0x80; // 10xxxxxx
const QOI_OP_RUN = 0xc0; // 11xxxxxx
const QOI_OP_RGBA = 0xff; // 11111111
const QOI_OP_RGB = 0xfe; // 11111110
const QOI_MASK_2 = 0xc0; // 11000000

const QOI_HEADER_SIZE = 14;
const QOI_PADDING = [0, 0, 0, 0, 0, 0, 0, 1];

/* 2GB is the max file size that this implementation can safely handle. We guard
against anything larger than that, assuming the worst case with 5 bytes per
pixel, rounded down to a nice clean value. 400 million pixels ought to be
enough for anybody. */
const QOI_PIXELS_MAX = 400000000;

export enum QOIChannels {
    RGB = 3,
    RGBA = 4
}

export enum QOIColorSpace {
    SRGB = 0,
    Linear = 1
}

interface QOIFile {
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    channels: QOIChannels;
    colorspace: QOIColorSpace;
}

export interface QOIHeader {
    width: number;
    height: number;
    channels: number;
    colorspace: number;
    fileSize: number;
}

function colorHash(r: number, g: number, b: number, a: number): number {
    return (r * 3 + g * 5 + b * 7 + a * 11) % 64;
}

export function parseHeader(data: Uint8Array): QOIHeader {
    if (data.length < QOI_HEADER_SIZE + QOI_PADDING.length) {
        throw new Error('QOI.decode: file too short');
    }

    const magic = data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3];
    if (magic !== QOI_MAGIC) {
        throw new Error('QOI.decode: The signature of the QOI file is invalid');
    }

    const width = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
    const height = ((data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11]) >>> 0;
    const channels = data[12];
    const colorspace = data[13];

    if (width === 0) {
        throw new Error(`QOI.decode: illegal width: ${width}`);
    }
    if (height === 0) {
        throw new Error(`QOI.decode: illegal height: ${height}`);
    }
    if (width * height > QOI_PIXELS_MAX) {
        throw new Error('QOI.decode: file is too large.');
    }
    if (channels !== 3 && channels !== 4) {
        throw new Error(`QOI.decode: illegal number of channels: ${channels}`);
    }
    if (0xf0 & colorspace) {
        throw new Error(`QOI.decode: illegal color space: 0x${colorspace.toString(16)}`);
    }

    return { width, height, channels, colorspace, fileSize: data.length };
}

export function decode(data: Uint8Array): QOIFile {
    const { width, height, channels, colorspace } = parseHeader(data);

    let pixelLength = width * height * 4; // we always decode to RGBA, even if the file is RGB
    let result = new Uint8ClampedArray(pixelLength);
    let index = new Uint8Array(64 * 4);
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 255;

    const chunksLength = data.length - QOI_PADDING.length;
    let run = 0;
    let dataPosition = QOI_HEADER_SIZE;
    let indexPosition = 0;
    for (let pixelPosition = 0; pixelPosition < pixelLength; pixelPosition += 4) {
        if (run > 0) {
            run--;
        } else if (dataPosition < chunksLength) {
            let byte1 = data[dataPosition++];

            if (byte1 === QOI_OP_RGB) {
                red = data[dataPosition++];
                green = data[dataPosition++];
                blue = data[dataPosition++];
            } else if (byte1 === QOI_OP_RGBA) {
                red = data[dataPosition++];
                green = data[dataPosition++];
                blue = data[dataPosition++];
                alpha = data[dataPosition++];
            } else if ((byte1 & QOI_MASK_2) === QOI_OP_INDEX) {
                const idx = byte1 * 4;
                red = index[idx];
                green = index[idx + 1];
                blue = index[idx + 2];
                alpha = index[idx + 3];
            } else if ((byte1 & QOI_MASK_2) === QOI_OP_DIFF) {
                red = (red + ((byte1 >> 4) & 0x03) - 2) & 0xff;
                green = (green + ((byte1 >> 2) & 0x03) - 2) & 0xff;
                blue = (blue + (byte1 & 0x03) - 2) & 0xff;
            } else if ((byte1 & QOI_MASK_2) === QOI_OP_LUMA) {
                let byte2 = data[dataPosition++];
                let vg = (byte1 & 0x3f) - 32;
                red = (red + vg - 8 + ((byte2 >> 4) & 0x0f)) & 0xff;
                green = (green + vg) & 0xff;
                blue = (blue + vg - 8 + (byte2 & 0x0f)) & 0xff;
            } else if ((byte1 & QOI_MASK_2) === QOI_OP_RUN) {
                run = byte1 & 0x3f;
            }

            indexPosition = colorHash(red, green, blue, alpha) * 4;
            index[indexPosition] = red;
            index[indexPosition + 1] = green;
            index[indexPosition + 2] = blue;
            index[indexPosition + 3] = alpha;
        }

        result[pixelPosition] = red;
        result[pixelPosition + 1] = green;
        result[pixelPosition + 2] = blue;
        result[pixelPosition + 3] = alpha;
    }

    return {
        pixels: result,
        width: width,
        height: height,
        colorspace: colorspace,
        channels: channels,
    };
}

/**
 * Streaming variant of decode: decodes in row-chunk batches and invokes
 * `onChunk` for each batch instead of allocating one giant pixel buffer.
 * The first callback includes the parsed header.
 */
export function decodeStreaming(
    data: Uint8Array,
    onChunk: (pixels: Uint8ClampedArray, offsetY: number, rowCount: number, header?: QOIHeader) => void,
    chunkByteLimit: number
): void {
    const header = parseHeader(data);
    const { width, height } = header;

    const rowBytes = width * 4;
    const chunkRowCount = Math.max(1, Math.floor(chunkByteLimit / rowBytes));
    const chunkSize = chunkRowCount * rowBytes;

    let chunk = new Uint8ClampedArray(chunkSize);
    let chunkRowOffset = 0;
    let chunkPixelIndex = 0;
    let isFirstChunk = true;

    const pixelLength = width * height * 4;
    const index = new Uint8Array(64 * 4);
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 255;

    const chunksLength = data.length - QOI_PADDING.length;
    let run = 0;
    let dataPosition = QOI_HEADER_SIZE;

    for (let pixelPosition = 0; pixelPosition < pixelLength; pixelPosition += 4) {
        if (run > 0) {
            run--;
        } else if (dataPosition < chunksLength) {
            let byte1 = data[dataPosition++];

            if (byte1 === QOI_OP_RGB) {
                red = data[dataPosition++];
                green = data[dataPosition++];
                blue = data[dataPosition++];
            } else if (byte1 === QOI_OP_RGBA) {
                red = data[dataPosition++];
                green = data[dataPosition++];
                blue = data[dataPosition++];
                alpha = data[dataPosition++];
            } else if ((byte1 & QOI_MASK_2) === QOI_OP_INDEX) {
                const idx = byte1 * 4;
                red = index[idx];
                green = index[idx + 1];
                blue = index[idx + 2];
                alpha = index[idx + 3];
            } else if ((byte1 & QOI_MASK_2) === QOI_OP_DIFF) {
                red = (red + ((byte1 >> 4) & 0x03) - 2) & 0xff;
                green = (green + ((byte1 >> 2) & 0x03) - 2) & 0xff;
                blue = (blue + (byte1 & 0x03) - 2) & 0xff;
            } else if ((byte1 & QOI_MASK_2) === QOI_OP_LUMA) {
                let byte2 = data[dataPosition++];
                let vg = (byte1 & 0x3f) - 32;
                red = (red + vg - 8 + ((byte2 >> 4) & 0x0f)) & 0xff;
                green = (green + vg) & 0xff;
                blue = (blue + vg - 8 + (byte2 & 0x0f)) & 0xff;
            } else if ((byte1 & QOI_MASK_2) === QOI_OP_RUN) {
                run = byte1 & 0x3f;
            }

            const indexPosition = colorHash(red, green, blue, alpha) * 4;
            index[indexPosition] = red;
            index[indexPosition + 1] = green;
            index[indexPosition + 2] = blue;
            index[indexPosition + 3] = alpha;
        }

        const pos = chunkPixelIndex * 4;
        chunk[pos] = red;
        chunk[pos + 1] = green;
        chunk[pos + 2] = blue;
        chunk[pos + 3] = alpha;
        chunkPixelIndex++;

        if (chunkPixelIndex === chunkRowCount * width) {
            onChunk(chunk, chunkRowOffset, chunkRowCount, isFirstChunk ? header : undefined);
            isFirstChunk = false;
            chunkRowOffset += chunkRowCount;
            chunkPixelIndex = 0;
            chunk = new Uint8ClampedArray(chunkSize);
        }
    }

    // Flush last partial chunk
    if (chunkPixelIndex > 0) {
        const remainingRows = Math.ceil(chunkPixelIndex / width);
        onChunk(chunk.subarray(0, chunkPixelIndex * 4), chunkRowOffset, remainingRows, isFirstChunk ? header : undefined);
    }
}
