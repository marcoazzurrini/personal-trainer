import {
  Cause,
  Clock,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Logger,
  References,
  Tracer,
} from "effect";

import type {
  Bindings,
  Invocation as WorkerInvocation,
} from "../environment.ts";
import type { Diagnostic } from "./errors.ts";
import { spanRecorder } from "./tracing.ts";
import type { SpanRecord } from "./tracing.ts";

// Hono and the Worker entry points speak promises; everything below them is
// Effect. This module is the bridge: it builds what one invocation runs with —
// its configuration, clock, logger and execution context — and runs an Effect
// in it.

/** The Worker's execution context for this invocation: waitUntil and friends. */
export class Invocation extends Context.Service<Invocation, WorkerInvocation>()(
  "trainer/Invocation"
) {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Effect hands a logger whatever the call site logged; only its text is kept.
function text(message: unknown): string {
  return Array.isArray(message)
    ? message.map(String).join(" ")
    : String(message);
}

// One JSON object per line, with the fiber's annotations flattened beside the
// message, so Workers Logs can filter on any of them.
//
// The cause is never printed, whatever the call site passes. Database and
// provider errors can embed credentials, SQL and personal input; a log line
// carries only the sentence and the annotations written for it.
export const jsonLogger = Logger.make(({ message, logLevel, fiber }) => {
  const line = JSON.stringify({
    level: logLevel,
    message: text(message),
    ...fiber.getRef(References.CurrentLogAnnotations),
  });
  if (logLevel === "Fatal" || logLevel === "Error" || logLevel === "Warn") {
    console.error(line);
  } else {
    console.log(line);
  }
});

export interface InvocationScope {
  readonly env: Bindings;
  readonly invocation: WorkerInvocation;
  readonly diagnostic: Diagnostic;
  /** Only tests replace the wall clock; production reads the system time. */
  readonly clock?: Clock.Clock;
  /** Where the invocation's finished spans are kept, when they are logged. */
  readonly spans?: SpanRecord[];
}

/**
 * Everything an Effect needs for one invocation. Bindings are read through the
 * ConfigProvider, never globally, so no environment's secrets survive into
 * another environment's request.
 */
export function invocationContext(
  scope: InvocationScope
): Context.Context<Invocation> {
  const context = Context.make(Invocation, scope.invocation).pipe(
    Context.add(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(scope.env)
    ),
    Context.add(Logger.CurrentLoggers, new Set([jsonLogger])),
    Context.add(References.CurrentLogAnnotations, {
      diagnostic_id: scope.diagnostic.id,
    }),
    Context.add(Tracer.Tracer, spanRecorder(scope.spans ?? []))
  );
  return scope.clock === undefined
    ? context
    : Context.add(context, Clock.Clock, scope.clock);
}

/**
 * Run an Effect at a promise boundary. A refusal is thrown as itself, for the
 * error handler to answer with its sentence; a defect is thrown as the value
 * that caused it, for the diagnostic envelope.
 */
export async function run<A, E>(
  context: Context.Context<Invocation>,
  effect: Effect.Effect<A, E, Invocation>
): Promise<A> {
  const exit = await Effect.runPromiseExitWith(context)(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.findErrorOption(exit.cause);
  throw failure._tag === "Some" ? failure.value : Cause.squash(exit.cause);
}

/**
 * Hand work to the runtime after the response has gone. It keeps this
 * invocation's clock, configuration and log annotations. Its failures are the
 * caller's to log; a defect is reported without its details.
 */
export function background(
  work: Effect.Effect<void, never, Invocation>
): Effect.Effect<void, never, Invocation> {
  return Effect.gen(function* () {
    const context = yield* Effect.context<Invocation>();
    const invocation = yield* Invocation;
    invocation.waitUntil(
      Effect.runPromiseWith(context)(
        work.pipe(
          Effect.catchCause(() =>
            Effect.logError("Background work failed; details withheld.")
          )
        )
      )
    );
  });
}
