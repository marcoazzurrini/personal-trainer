import { ApiError } from "./errors.ts";

export const MAX_BODY_BYTES = 1024 * 1024;

// Bound bytes before any clone, JSON parser, authentication or public webhook
// can buffer them. Content-Length is only an early refusal, never the proof.
export async function boundedBody(req: Request): Promise<Request> {
  if (!req.body) return req;
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) {
    await req.body.cancel();
    throw new ApiError(
      413,
      `Request body exceeds ${MAX_BODY_BYTES} bytes. Split the operation into smaller requests with distinct write IDs.`,
    );
  }
  let size = 0;
  const limited = req.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) {
          throw new ApiError(
            413,
            `Request body exceeds ${MAX_BODY_BYTES} bytes. Split the operation into smaller requests with distinct write IDs.`,
          );
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const bytes = await new Response(limited).arrayBuffer();
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: bytes.byteLength ? bytes : null,
    signal: req.signal,
  });
}
