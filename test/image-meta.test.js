import assert from "node:assert/strict";
import test from "node:test";
import { stripImageMeta } from "../lib/image-meta.js";

function jpegSegment(marker, payload) {
  const body = Buffer.concat([
    Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
  return Buffer.concat([Buffer.from([0xff, marker]), body]);
}

test("jpeg camera and location metadata is removed and a clean file is left intact", () => {
  const app0 = jpegSegment(0xe0, Buffer.from("JFIF\0clean", "ascii"));
  const exif = jpegSegment(0xe1, Buffer.from("Exif\0\0GPSLatitudeCameraModel", "ascii"));
  const iptc = jpegSegment(0xed, Buffer.from("GPSLongitude", "ascii"));
  const scan = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from("entropy-bytes", "ascii"),
    Buffer.from([0xff, 0xd9]),
  ]);
  const dirty = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, exif, iptc, scan]);
  const cleaned = stripImageMeta(dirty, "image/jpeg");
  assert.equal(cleaned[0], 0xff);
  assert.equal(cleaned[1], 0xd8);
  assert.equal(cleaned.includes(Buffer.from("JFIF")), true);
  assert.equal(cleaned.includes(Buffer.from("Exif")), false);
  assert.equal(cleaned.includes(Buffer.from("GPSLatitude")), false);
  assert.equal(cleaned.includes(Buffer.from("GPSLongitude")), false);
  assert.equal(cleaned.includes(Buffer.from("CameraModel")), false);
  assert.equal(cleaned.includes(Buffer.from("entropy-bytes")), true);

  const plain = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, scan]);
  assert.deepEqual(stripImageMeta(plain, "image/jpeg"), plain);
});

test("png and webp metadata chunks are removed", () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  }
  const ihdr = chunk("IHDR", Buffer.from("header"));
  const exif = chunk("eXIf", Buffer.from("GPSLatitude"));
  const text = chunk("tEXt", Buffer.from("Software"));
  const iend = chunk("IEND", Buffer.alloc(0));
  const png = Buffer.concat([signature, ihdr, exif, text, iend]);
  const cleaned = stripImageMeta(png, "image/png");
  assert.equal(cleaned.includes(Buffer.from("IHDR")), true);
  assert.equal(cleaned.includes(Buffer.from("IEND")), true);
  assert.equal(cleaned.includes(Buffer.from("GPSLatitude")), false);
  assert.equal(cleaned.includes(Buffer.from("Software")), false);
  assert.equal(cleaned.includes(Buffer.from("eXIf")), false);

  const payload = Buffer.from("picture");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  const webp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
    Buffer.from("EXIF"),
    (() => {
      const n = Buffer.alloc(4);
      n.writeUInt32LE(4);
      return n;
    })(),
    Buffer.from("GPS!"),
    Buffer.from("VP8 "),
    size,
    payload,
    Buffer.alloc(payload.length % 2),
  ]);
  webp.writeUInt32LE(webp.length - 8, 4);
  const stripped = stripImageMeta(webp, "image/webp");
  assert.equal(stripped.toString("ascii", 0, 4), "RIFF");
  assert.equal(stripped.toString("ascii", 8, 12), "WEBP");
  assert.equal(stripped.includes(Buffer.from("EXIF")), false);
  assert.equal(stripped.includes(Buffer.from("GPS!")), false);
  assert.equal(stripped.includes(payload), true);
});
