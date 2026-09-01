// The two surfaces that belong to no training or nutrition topic: the
// coaching documents the coach reads, and the channel it files problems on.
//
// They share no table and no function, and ADR-0006 left open whether that
// makes them one folder. What settles it for now is that neither belongs
// anywhere else and each needs somewhere: docs/ is already the name of the
// markdown itself, so the two sit together rather than each taking a folder
// for one file. Revisit if either grows.

export { docs } from "./docs.routes.ts";
export { issues } from "./issues.routes.ts";
