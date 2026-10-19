'use strict';

const fs = require('fs');

/**
 * A minimal ZIP writer, streamed.
 *
 * Written rather than installed for two reasons. This application has kept to two dependencies so
 * it still starts after a year of nobody touching it, and the job here is narrow: bundle a report
 * with the screenshots it refers to. Entries are STORED rather than deflated because almost all of
 * the bytes are PNGs, which are already compressed — deflating them again costs CPU and saves
 * essentially nothing.
 *
 * It streams because a bundle is large. A batch covering every set of tests can carry several
 * hundred screenshots at better than half a megabyte each, and holding that in memory to hand back
 * in one piece would be a few hundred megabytes of buffer per download.
 *
 * No zip64: entries and totals must stay under 4 GB, which `planBundle` is used to check before
 * anything is written.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date/time, which is what the format stores. */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(0, 8); // stored
  head.writeUInt16LE(entry.time, 10);
  head.writeUInt16LE(entry.day, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.size, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name]);
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(entry.time, 12);
  head.writeUInt16LE(entry.day, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.size, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk
  head.writeUInt16LE(0, 36); // internal attrs
  head.writeUInt32LE(0, 38); // external attrs
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

/**
 * Writes a zip of `entries` to `out`.
 *
 * Each entry is `{ name, path }` for a file on disk, or `{ name, data }` for a buffer or string.
 * A file that cannot be read is skipped rather than failing the whole download — a missing
 * screenshot should cost one image, not the report someone is waiting for.
 */
async function writeZip(out, entries) {
  const written = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  const push = (buffer) =>
    new Promise((resolve, reject) => {
      if (out.write(buffer)) return resolve();
      out.once('drain', resolve);
      out.once('error', reject);
      return undefined;
    });

  for (const entry of entries) {
    let data;
    if (entry.data !== undefined) {
      data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    } else {
      try {
        data = fs.readFileSync(entry.path);
      } catch {
        continue;
      }
    }
    const record = { name: entry.name, crc: crc32(data), size: data.length, offset, ...now };
    const header = localHeader(record);
    await push(header);
    await push(data);
    offset += header.length + data.length;
    written.push(record);
  }

  const central = Buffer.concat(written.map(centralHeader));
  await push(central);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(written.length, 8);
  end.writeUInt16LE(written.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await push(end);

  return { entries: written.length, bytes: offset + central.length + end.length };
}

/** Rough size of a bundle before building it, so an impossible one can be refused up front. */
function planBundle(entries) {
  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (entry.data !== undefined) {
      bytes += Buffer.byteLength(entry.data);
      files += 1;
      continue;
    }
    try {
      bytes += fs.statSync(entry.path).size;
      files += 1;
    } catch {
      // Counted as absent; writeZip skips it too.
    }
  }
  // Headers are a rounding error next to the payload, but keep the estimate honest.
  return { files, bytes: bytes + files * 120 };
}

module.exports = { writeZip, planBundle, crc32 };
