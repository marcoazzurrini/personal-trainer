import { Effect } from "effect";

import { BadRequest, TooLarge } from "./refusals.ts";

export const MAX_BODY_BYTES = 1024 * 1024;

const tooLarge = () =>
  new TooLarge({
    message: `Request body exceeds ${MAX_BODY_BYTES} bytes. Split the operation into smaller requests with distinct write IDs.`,
  });

// Bound bytes before any clone, JSON parser, authentication or public webhook
// can buffer them. Content-Length is only an early refusal, never the proof.
export function boundedBody(
  req: Request
): Effect.Effect<Request, TooLarge | BadRequest> {
  const { body } = req;
  if (!body) {
    return Effect.succeed(req);
  }
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) {
    return Effect.promise(() => body.cancel()).pipe(
      Effect.andThen(Effect.fail(tooLarge()))
    );
  }
  return Effect.tryPromise({
    try: async () => {
      let size = 0;
      const limited = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.byteLength;
            if (size > MAX_BODY_BYTES) {
              controller.error(tooLarge());
              return;
            }
            controller.enqueue(chunk);
          },
        })
      );
      return await new Response(limited).arrayBuffer();
    },
    catch: (failure) =>
      failure instanceof TooLarge
        ? failure
        : new BadRequest({
            message:
              "Request body could not be read. Send a complete request body.",
          }),
  }).pipe(
    Effect.map(
      (bytes) =>
        new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: bytes.byteLength ? bytes : null,
          signal: req.signal,
        })
    )
  );
}
