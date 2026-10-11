import { DatabaseFailureError } from "./errors.ts";

// Leave headroom below D1's 2 MB string/blob parameter limit.
const MAX_JSON_BIND_BYTES = 1536 * 1024;
export function jsonChunks(
  values: readonly unknown[]
): { json: string; count: number; offset: number }[] {
  const chunks: { json: string; count: number; offset: number }[] = [];
  const encoder = new TextEncoder();
  let parts: string[] = [];
  let bytes = 2;
  let offset = 0;
  const flush = () => {
    chunks.push({ json: `[${parts.join(",")}]`, count: parts.length, offset });
    offset += parts.length;
    parts = [];
    bytes = 2;
  };
  for (const value of values) {
    const part = JSON.stringify(value);
    if (part === undefined) {
      throw new Error("Cannot encode an undefined write item.");
    }
    const size = encoder.encode(part).byteLength;
    if (size + 2 > MAX_JSON_BIND_BYTES) {
      throw new DatabaseFailureError("too_large", "");
    }
    if (parts.length && bytes + size + 1 > MAX_JSON_BIND_BYTES) {
      flush();
    }
    bytes += size + (parts.length ? 1 : 0);
    parts.push(part);
  }
  if (parts.length || chunks.length === 0) {
    flush();
  }
  return chunks;
}
