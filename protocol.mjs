import net from "node:net";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 9471;
export const MAX_FRAME_BYTES = 1024 * 1024;

export function isTailscaleIPv4(address) {
  if (!net.isIPv4(address)) {
    return false;
  }
  const octets = address.split(".").map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function encodeFrame(value, byteOrder = "BE") {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new RangeError("frame exceeds the one-megabyte limit");
  }
  const header = Buffer.alloc(4);
  if (byteOrder === "LE") {
    header.writeUInt32LE(payload.length);
  } else if (byteOrder === "BE") {
    header.writeUInt32BE(payload.length);
  } else {
    throw new TypeError("byteOrder must be BE or LE");
  }
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  constructor(byteOrder = "BE") {
    if (byteOrder !== "BE" && byteOrder !== "LE") {
      throw new TypeError("byteOrder must be BE or LE");
    }
    this.byteOrder = byteOrder;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      chunk = Buffer.from(chunk);
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values = [];
    while (this.buffer.length >= 4) {
      const length = this.byteOrder === "LE"
        ? this.buffer.readUInt32LE(0)
        : this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new RangeError("incoming frame exceeds the one-megabyte limit");
      }
      if (this.buffer.length < 4 + length) {
        break;
      }
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      values.push(JSON.parse(payload.toString("utf8")));
    }
    return values;
  }
}
