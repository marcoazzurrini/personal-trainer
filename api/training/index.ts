// What the composition root mounts. Named routers, not a pre-mounted app —
// see body/index.ts for why that distinction is load-bearing.

export { blocks } from "./blocks.routes.ts";
export { exercises, muscles } from "./exercises.routes.ts";
export { mesocycles } from "./mesocycles.routes.ts";
export { sessions } from "./sessions.routes.ts";
export { trainingState } from "./state.routes.ts";
export { userContext } from "./user_context.routes.ts";
export { sets } from "./sets.routes.ts";
export { weeklyExerciseSets, weeklyVolume } from "./volume.routes.ts";
export { weekSchedule } from "./week_schedule.routes.ts";
