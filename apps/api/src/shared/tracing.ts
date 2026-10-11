import { Exit, Tracer } from "effect";

/** One finished span, as the request's log record carries it. */
export interface SpanRecord {
  readonly name: string;
  readonly ms: number;
  readonly failed?: true;
}

// Enough to see where one request spent its time; a runaway loop cannot grow
// the log line without bound.
const MAX_SPANS = 50;

// Every Effect.fn names a span. Without an exporter they would end unseen, so
// each invocation keeps the ones that ended — name, duration, and whether it
// failed, never attributes or causes — for its single log record. Workers
// advance the clock only across I/O, so a duration is time spent waiting on
// the database or a provider.
class RecordedSpan extends Tracer.NativeSpan {
  readonly #spans: SpanRecord[];

  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    spans: SpanRecord[]
  ) {
    super(options);
    this.#spans = spans;
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    if (this.#spans.length < MAX_SPANS) {
      const ms = Math.round(Number(endTime - this.startTime) / 100_000) / 10;
      this.#spans.push(
        Exit.isFailure(exit)
          ? { name: this.name, ms, failed: true }
          : { name: this.name, ms }
      );
    }
  }
}

export function spanRecorder(spans: SpanRecord[]): Tracer.Tracer {
  return Tracer.make({ span: (options) => new RecordedSpan(options, spans) });
}
