// How a food or a meal is named, and what is said when the name is unknown.
//
// The ranked-union law is shared/resolve.ts's; what is here is the pair of
// namespaces this topic owns and the refusals that go with them. Those
// sentences are the reason the namespaces are declared beside their tables
// rather than in one list: they are addressed to a model, and the one telling
// it how to add a food it could not find is not the one telling it how to add
// an exercise.

import {
  assertAliasesFree,
  type Namespace,
  resolveNamed,
} from "../shared/resolve.ts";

const FOODS: Namespace = {
  table: "foods",
  aliasTable: "food_aliases",
  foreignKey: "food_id",
  noSuchId: (ref) =>
    `No food with id ${ref}. GET /foods?q=<search> lists them.`,
  unknownName: (name) =>
    `Unknown food "${name}". GET /foods?q=<search> lists what exists — use the id, canonical name, or an alias. A food that genuinely does not exist yet is sourced (label, CREA, USDA, Open Food Facts) and saved with POST /foods — never invented. A synonym of a food that exists gets an alias instead: POST /foods/:ref/aliases.`,
  missingRef: '"food" is required: a food id, canonical name, or alias.',
  what: "food",
  route: "/foods",
};

const MEALS: Namespace = {
  table: "meals",
  aliasTable: "meal_aliases",
  foreignKey: "meal_id",
  noSuchId: (ref) => `No meal with id ${ref}. GET /meals lists them.`,
  unknownName: (name) =>
    `Unknown meal "${name}". GET /meals lists what exists — use the id, canonical name, or an alias. A meal that has become a routine is saved with POST /meals. A one-off variation on a saved meal is not a new meal — log the meal and log the difference as a separate entry.`,
  missingRef: '"meal" is required: a meal id, canonical name, or alias.',
  what: "meal",
  route: "/meals",
};

export function resolveFoodId(ref: unknown): Promise<number> {
  return resolveNamed(FOODS, ref);
}

export function resolveMealId(ref: unknown): Promise<number> {
  return resolveNamed(MEALS, ref);
}

export const assertFoodAliasesFree = (aliases: readonly string[]) =>
  assertAliasesFree(FOODS, aliases);
export const assertMealAliasesFree = (aliases: readonly string[]) =>
  assertAliasesFree(MEALS, aliases);
