// Binary container reader: u32 header length, JSON header [{name,dtype,len,off}], raw arrays.
export type Arrays = Record<string, Float32Array | Float64Array | Int32Array | Uint8Array>;

export function parseBin(buf: ArrayBuffer): Arrays {
  const dv = new DataView(buf);
  const hlen = dv.getUint32(0, true);
  const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen))) as
    { name: string; dtype: string; len: number; off: number }[];
  const base = 4 + hlen;
  const sizes: Record<string, number> = { float32: 4, float64: 8, int32: 4, uint8: 1 };
  const out: Arrays = {};
  for (const h of hdr) {
    const slice = buf.slice(base + h.off, base + h.off + h.len * sizes[h.dtype]);   // copy: alignment-safe
    out[h.name] = h.dtype === "float32" ? new Float32Array(slice) : h.dtype === "float64" ? new Float64Array(slice)
      : h.dtype === "int32" ? new Int32Array(slice) : new Uint8Array(slice);
  }
  return out;
}

export async function gunzip(data: ArrayBuffer | ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const stream = data instanceof ArrayBuffer ? new Blob([data]).stream() : data;
  return await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

export const loadBin = async (d: ArrayBuffer | ReadableStream<Uint8Array>) => parseBin(await gunzip(d));
export const loadJson = async <T>(d: ArrayBuffer | ReadableStream<Uint8Array>) =>
  JSON.parse(new TextDecoder().decode(await gunzip(d))) as T;
