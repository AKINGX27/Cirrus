interface ZipSource {
  name: string;
  size: number;
  uploadedAt: string;
  body: ReadableStream<Uint8Array> | (() => Promise<ReadableStream<Uint8Array> | null>);
}

interface CentralEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const UINT32_MAX = 0xffffffff;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_FLAGS = ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8;

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c >>> 0;
}

function updateCrc(crc: number, chunk: Uint8Array) {
  let next = crc;
  for (const byte of chunk) {
    next = crcTable[(next ^ byte) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

function view(length: number) {
  const bytes = new Uint8Array(length);
  return {
    bytes,
    data: new DataView(bytes.buffer),
  };
}

function dosDateTime(value: string) {
  const parsed = new Date(value);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);

  return {
    date: dosDate,
    time: dosTime,
  };
}

function localHeader(nameLength: number, time: number, date: number) {
  const { bytes, data } = view(30);
  data.setUint32(0, 0x04034b50, true);
  data.setUint16(4, 20, true);
  data.setUint16(6, ZIP_FLAGS, true);
  data.setUint16(8, 0, true);
  data.setUint16(10, time, true);
  data.setUint16(12, date, true);
  data.setUint32(14, 0, true);
  data.setUint32(18, 0, true);
  data.setUint32(22, 0, true);
  data.setUint16(26, nameLength, true);
  data.setUint16(28, 0, true);
  return bytes;
}

function dataDescriptor(crc: number, size: number) {
  const { bytes, data } = view(16);
  data.setUint32(0, 0x08074b50, true);
  data.setUint32(4, crc >>> 0, true);
  data.setUint32(8, size >>> 0, true);
  data.setUint32(12, size >>> 0, true);
  return bytes;
}

function centralHeader(entry: CentralEntry) {
  const { bytes, data } = view(46);
  data.setUint32(0, 0x02014b50, true);
  data.setUint16(4, 20, true);
  data.setUint16(6, 20, true);
  data.setUint16(8, ZIP_FLAGS, true);
  data.setUint16(10, 0, true);
  data.setUint16(12, entry.time, true);
  data.setUint16(14, entry.date, true);
  data.setUint32(16, entry.crc >>> 0, true);
  data.setUint32(20, entry.size >>> 0, true);
  data.setUint32(24, entry.size >>> 0, true);
  data.setUint16(28, entry.name.length, true);
  data.setUint16(30, 0, true);
  data.setUint16(32, 0, true);
  data.setUint16(34, 0, true);
  data.setUint16(36, 0, true);
  data.setUint32(38, 0, true);
  data.setUint32(42, entry.offset >>> 0, true);
  return bytes;
}

function endOfCentralDirectory(entries: number, centralSize: number, centralOffset: number) {
  const { bytes, data } = view(22);
  data.setUint32(0, 0x06054b50, true);
  data.setUint16(4, 0, true);
  data.setUint16(6, 0, true);
  data.setUint16(8, entries, true);
  data.setUint16(10, entries, true);
  data.setUint32(12, centralSize >>> 0, true);
  data.setUint32(16, centralOffset >>> 0, true);
  data.setUint16(20, 0, true);
  return bytes;
}

function cleanZipName(name: string) {
  return (
    name
      .replace(/[\/\\]+/g, "_")
      .replace(/[\u0000-\u001f\u007f]+/g, "")
      .trim() || "untitled"
  );
}

function uniqueName(name: string, used: Set<string>) {
  const cleaned = cleanZipName(name);
  if (!used.has(cleaned)) {
    used.add(cleaned);
    return cleaned;
  }

  const dot = cleaned.lastIndexOf(".");
  const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  let index = 2;
  let candidate = `${base} (${index})${ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base} (${index})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

export function createStoredZipStream(sources: ZipSource[]) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const central: CentralEntry[] = [];
      const usedNames = new Set<string>();
      let offset = 0;

      try {
        for (const source of sources) {
          if (source.size > UINT32_MAX) {
            throw new Error("暂不支持单个文件超过 4GB 的 ZIP 下载");
          }
          if (offset > UINT32_MAX) {
            throw new Error("暂不支持超过 4GB 的 ZIP 下载");
          }

          const body = typeof source.body === "function" ? await source.body() : source.body;
          if (!body) continue;
          const { date, time } = dosDateTime(source.uploadedAt);
          const name = encoder.encode(uniqueName(source.name, usedNames));
          const localOffset = offset;
          const header = localHeader(name.length, time, date);

          controller.enqueue(header);
          controller.enqueue(name);
          offset += header.length + name.length;

          let crc = 0xffffffff;
          let written = 0;
          const reader = body.getReader();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value?.byteLength) continue;

              crc = updateCrc(crc, value);
              written += value.byteLength;
              offset += value.byteLength;
              controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
          }

          if (written > UINT32_MAX) {
            throw new Error("暂不支持单个文件超过 4GB 的 ZIP 下载");
          }

          const finalCrc = (crc ^ 0xffffffff) >>> 0;
          const descriptor = dataDescriptor(finalCrc, written);
          controller.enqueue(descriptor);
          offset += descriptor.length;

          central.push({
            name,
            crc: finalCrc,
            size: written,
            offset: localOffset,
            time,
            date,
          });
        }

        const centralOffset = offset;
        for (const entry of central) {
          const header = centralHeader(entry);
          controller.enqueue(header);
          controller.enqueue(entry.name);
          offset += header.length + entry.name.length;
        }

        const centralSize = offset - centralOffset;
        if (central.length > 0xffff || centralSize > UINT32_MAX || centralOffset > UINT32_MAX) {
          throw new Error("暂不支持超过 ZIP32 限制的批量下载");
        }

        controller.enqueue(endOfCentralDirectory(central.length, centralSize, centralOffset));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
