// Compiled in by `wrangler deploy --define` in CI, never read from a runtime
// binding that could change without the code. Local and test builds have none.
declare const __BUILD_REVISION__: string;

export const buildRevision: string | null =
  // oxlint-disable-next-line anti-slop/no-runtime-typeof, unicorn/no-typeof-undefined -- The bundler declaration has no runtime binding in unstamped builds; only typeof can read an absent global safely.
  typeof __BUILD_REVISION__ === "undefined" ? null : __BUILD_REVISION__;
