/**
 * Drop location and camera metadata before a letter face is stored.
 * The picture itself is kept. APP1 holds EXIF (including GPS) and XMP.
 * APP13 holds IPTC. PNG and WebP use their own metadata chunks.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

function stripJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;
  const parts = [buffer.subarray(0, 2)];
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      parts.push(buffer.subarray(offset));
      break;
    }
    const markerPos = offset;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) {
      parts.push(buffer.subarray(markerPos));
      break;
    }
    const marker = buffer[offset];
    offset += 1;
    const standalone = marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
    if (standalone) {
      parts.push(buffer.subarray(markerPos, offset));
      continue;
    }
    if (marker === 0xd9) {
      parts.push(buffer.subarray(markerPos, offset));
      break;
    }
    if (marker === 0xda) {
      parts.push(buffer.subarray(markerPos));
      break;
    }
    if (offset + 2 > buffer.length) {
      parts.push(buffer.subarray(markerPos));
      break;
    }
    const size = buffer.readUInt16BE(offset);
    if (size < 2 || offset + size > buffer.length) {
      parts.push(buffer.subarray(markerPos));
      break;
    }
    const end = offset + size;
    const drop = marker === 0xe1 || marker === 0xed;
    if (!drop) parts.push(buffer.subarray(markerPos, end));
    offset = end;
  }
  return Buffer.concat(parts);
}

function stripPng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer;
  const parts = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) {
      parts.push(buffer.subarray(offset));
      break;
    }
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!PNG_DROP.has(type)) parts.push(buffer.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(parts);
}

function stripWebp(buffer) {
  if (buffer.length < 12) return buffer;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return buffer;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return buffer;
  const parts = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const tag = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > buffer.length) break;
    if (tag !== "EXIF" && tag !== "XMP ") parts.push(buffer.subarray(offset, end));
    offset = end;
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

export function stripImageMeta(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer;
  let next = buffer;
  if (mime === "image/jpeg") next = stripJpeg(buffer);
  else if (mime === "image/png") next = stripPng(buffer);
  else if (mime === "image/webp") next = stripWebp(buffer);
  if (!next.length) return buffer;
  return next;
}
