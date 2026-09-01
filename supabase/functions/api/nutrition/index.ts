// What the composition root mounts, as named routers rather than a
// pre-mounted app — see body/index.ts for why that distinction is load-bearing.

export { foods } from "./foods.routes.ts";
export { days, intake } from "./intake.routes.ts";
export { meals } from "./meals.routes.ts";
