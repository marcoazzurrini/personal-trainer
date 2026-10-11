export interface Namespace {
  table: string;
  aliasTable: string;
  foreignKey: string;
  // The refusals, written per namespace rather than filled from one template.
  // Only the rule is shared, not the prose: the client is a model, and the
  // sentence telling it how to add a food it could not find is not the
  // sentence telling it how to add an exercise.
  noSuchId: (ref: number) => string;
  unknownName: (name: string) => string;
  missingRef: string;
  // What one of these is called, and the prefix its aliases hang off — the
  // alias-clash refusal names both.
  what: string;
  route: string;
}
