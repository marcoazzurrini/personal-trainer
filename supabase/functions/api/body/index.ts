// What the composition root mounts. A barrel of named routers, deliberately
// not a pre-mounted sub-app.
//
// The reason is the Withings split. withingsWebhook is registered above the
// bearer-token middleware because Withings cannot send our token, and
// withingsAdmin below it because the manual trigger must stay behind one. Both
// answer on /withings. A topic index that mounted its own app would have to
// choose one side for the whole prefix, and getting it wrong would make the
// sync trigger public — silently, and in production. Mount order is the auth
// property, so it stays where the middleware is, in index.ts.

export { bodyfat } from "./bodyfat.routes.ts";
export { bodyweight } from "./bodyweight.routes.ts";
export { withingsAdmin, withingsWebhook } from "./withings.routes.ts";
