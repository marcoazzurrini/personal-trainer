import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError } from "../http/errors.ts";
import { addAliases, releaseAlias } from "./aliases.ts";
import { aliasList, body, query, text } from "../http/schema.ts";

// Exercises, foods and meals all answer to more than one name, and the rule
// is one rule: a synonym never becomes a second row, because that splits one
// thing's history in two. The surface that follows from it is shared too —
// add a name, release a name — so it is written here once and mounted by
// each router rather than copied into each of them.
//
// What is not shared is the prose. Every sentence below comes from the
// caller: the client is a model, and the sentence telling it how to name a
// food is not the sentence telling it how to name an exercise.
//
// The two writes are in aliases.ts beside this, for the reason every topic
// splits the same way: a file that declares HTTP routes may not reach the
// database. This one belongs to no topic — it is mounted five times across
// three of them — so it shares a home rather than joining one.

interface Aliased {
  id: number;
  name?: string;
}

// Body is the shape the entity answers with, and it is a type parameter so
// that the reload and the declared schema are checked against each other.
// Without it both sides widen to unknown, the handler needs a cast to return
// anything at all, and the response declaration stops catching the drift it
// was added to catch — which ADR-0002 records as the reason for declaring
// responses in the first place.
interface AliasSurface<Body> {
  tag: string;
  aliasTable: string;
  foreignKey: string;
  // The entity's own {ref} parameter, carrying its description and example.
  ref: () => z.ZodString;
  resolve: (ref: string) => Promise<Aliased>;
  // The whole response body, reloaded after the write — { exercise: … },
  // { food: … }, { meal: … }. The key is the caller's to choose, which is
  // why it hands back the envelope rather than the row.
  respond: (id: number) => Promise<Body>;
  responseSchema: z.ZodType<Body>;
}

// Both routes answer with the entity as it now stands rather than with the
// alias that changed: the caller's next move needs the full list of names,
// and a second GET to discover it is a round trip the model should not have
// to spend.
export function addAliasRoute<Body>(
  router: OpenAPIHono,
  surface: AliasSurface<Body> & {
    created: string;
    // Refused when neither field arrives. Foods and exercises do not phrase
    // this alike and neither may change.
    neither: string;
    // Refuses the call naming the alias and its current owner, before the
    // insert reaches a constraint that knows neither.
    assertFree: (aliases: readonly string[]) => Promise<void>;
  },
) {
  router.openapi(
    createRoute({
      method: "post",
      path: "/{ref}/aliases",
      tags: [surface.tag],
      summary: "Add a synonym",
      request: {
        params: z.object({ ref: surface.ref() }),
        query: query({}),
        body: {
          content: {
            "application/json": {
              schema: body({ alias: text().optional(), aliases: aliasList() }),
            },
          },
        },
      },
      responses: {
        201: {
          description: surface.created,
          content: {
            "application/json": { schema: surface.responseSchema },
          },
        },
        409: { description: "That alias already points at something." },
        422: { description: "Neither alias nor aliases was sent." },
      },
    }),
    async (c) => {
      const { id } = await surface.resolve(c.req.valid("param").ref);
      const b = c.req.valid("json");
      const aliases = b.alias !== undefined ? [b.alias] : (b.aliases ?? []);
      if (aliases.length === 0) throw new ApiError(422, surface.neither);
      await surface.assertFree(aliases);
      await addAliases(surface.aliasTable, surface.foreignKey, id, aliases);
      return c.json(await surface.respond(id), 201);
    },
  );
}

// An alias is a pointer, not a fact — removing one loses nothing, and it is
// how a spoken name gets moved to the thing that should own it. Aliases are
// globally unique, so without this a retired food would hold "il solito
// yogurt" forever and no replacement could ever claim it.
export function releaseAliasRoute<Body>(
  router: OpenAPIHono,
  surface: AliasSurface<Body> & {
    summary: string;
    description?: string;
    removed: string;
    notAnAliasResponse: string;
    notAnAlias: (alias: string, entity: Aliased) => string;
  },
) {
  router.openapi(
    createRoute({
      method: "delete",
      path: "/{ref}/aliases/{alias}",
      tags: [surface.tag],
      summary: surface.summary,
      ...(surface.description === undefined
        ? {}
        : { description: surface.description }),
      request: {
        params: z.object({ ref: surface.ref(), alias: z.string().min(1) }),
        query: query({}),
      },
      responses: {
        200: {
          description: surface.removed,
          content: {
            "application/json": { schema: surface.responseSchema },
          },
        },
        404: { description: surface.notAnAliasResponse },
      },
    }),
    async (c) => {
      const { ref: reference, alias: rawAlias } = c.req.valid("param");
      const entity = await surface.resolve(reference);
      const alias = decodeURIComponent(rawAlias);
      await releaseAlias({
        table: surface.aliasTable,
        foreignKey: surface.foreignKey,
        id: entity.id,
        alias,
        notAnAlias: surface.notAnAlias(alias, entity),
      });
      return c.json(await surface.respond(entity.id));
    },
  );
}
