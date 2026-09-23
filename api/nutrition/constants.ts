export const SOURCES = ["label", "crea", "usda", "off", "estimate"] as const;
export const FLAGS = ["incomplete"] as const;
export const KINDS = [
  "creatine_start",
  "phase_switch",
  "program_change",
  "logging_change",
  "other",
] as const;
export const CLIP_REASONS = [
  "rate",
  "deficit",
  "recomp_deficit",
  "surplus",
] as const;
