import { IsQOI, QOIChannels, QOIdecode } from "qoi-img";

const parseStatus = {
  success: "SUCCESS",
  failure: "FAILURE",
};

const parseByteFormat = (byteData: Uint8Array) => {
  let rawBuffer = Buffer.from(byteData);
  if (IsQOI(rawBuffer)) {
    var qoiData, imgType, data, width, height;
    let colorData: { r: number; g: number; b: number; a: number }[] = [];;
    let channel = rawBuffer.subarray(12, 13);
    if (channel.equals(Buffer.of(QOIChannels.RGB))) {
      qoiData = QOIdecode(rawBuffer, QOIChannels.RGB);
      imgType = 'rgb';
      data = qoiData.pixels;
      width = qoiData.width;
      height = qoiData.height;
    
      let pixelIndex = 0, index = 0;
      const totalPixels = width * height;
      while (pixelIndex < totalPixels) {
        colorData.push({
          r: data[index],
          g: data[index + 1],
          b: data[index + 2],
          a: 0xFF
        });
        pixelIndex += 1;
        index += 3;
      }
    } else if (channel.equals(Buffer.of(QOIChannels.RGBA))) {
      qoiData = QOIdecode(rawBuffer, QOIChannels.RGBA);
      imgType = 'rgba';
      data = qoiData.pixels;
      width = qoiData.width;
      height = qoiData.height;

      let pixelIndex = 0, index = 0;
      const totalPixels = width * height;
      while (pixelIndex < totalPixels) {
        colorData.push({
          r: data[index],
          g: data[index + 1],
          b: data[index + 2],
          a: data[index + 3]
        });
        pixelIndex += 1;
        index += 4;
      }
    } else {
      qoiData = QOIdecode(rawBuffer, QOIChannels.RGB);
      imgType = 'unknow';
    }
    // qoiData = QOIdecode(rawBuffer, QOIChannels.RGB);
    return { status: parseStatus.success, colorData, width, height, imgType };
  } else {
    return { status: parseStatus.failure };
  }
};

export default { parseStatus, parseByteFormat };
