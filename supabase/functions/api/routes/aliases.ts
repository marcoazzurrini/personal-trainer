import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import { aliasList, body, text } from "../http/schema.ts";

// Exercises, foods and meals all answer to more than one name, and the rule
// is one rule: a synonym never becomes a second row, because that splits one
// thing's history in two. The surface that follows from it is shared too —
// add a name, release a name — so it is written here once and mounted by
// each router rather than copied into each of them.
//
// What is not shared is the prose. Every sentence below comes from the
// caller: the client is a model, and the sentence telling it how to name a
// food is not the sentence telling it how to name an exercise.

interface Aliased {
  id: number;
  name?: string;
}

interface AliasSurface {
  tag: string;
  aliasTable: string;
  foreignKey: string;
  // The entity's own {ref} parameter, carrying its description and example.
  ref: () => z.ZodString;
  resolve: (ref: string) => Promise<Aliased>;
  // The whole response body, reloaded after the write — { exercise: … },
  // { food: … }, { meal: … }. The key is the caller's to choose, which is
  // why it hands back the envelope rather than the row.
  respond: (id: number) => Promise<Record<string, unknown>>;
  responseSchema: z.ZodType;
}

// Both routes answer with the entity as it now stands rather than with the
// alias that changed: the caller's next move needs the full list of names,
// and a second GET to discover it is a round trip the model should not have
// to spend.
export function addAliasRoute(
  router: OpenAPIHono,
  surface: AliasSurface & {
    created: string;
    // Refused when neither field arrives. Foods and exercises do not phrase
    // this alike and neither may change.
    neither: string;
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
      await sql.begin(async (tx) => {
        for (const alias of aliases) {
          await tx`
          insert into ${sql(surface.aliasTable)}
          (${sql(surface.foreignKey)}, alias) values (${id}, ${alias})`;
        }
      });
      // deno-lint-ignore no-explicit-any
      return c.json(await surface.respond(id) as any, 201);
    },
  );
}

// An alias is a pointer, not a fact — removing one loses nothing, and it is
// how a spoken name gets moved to the thing that should own it. Aliases are
// globally unique, so without this a retired food would hold "il solito
// yogurt" forever and no replacement could ever claim it.
export function releaseAliasRoute(
  router: OpenAPIHono,
  surface: AliasSurface & {
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
      const rows = await sql`
      delete from ${sql(surface.aliasTable)}
      where ${sql(surface.foreignKey)} = ${entity.id}
        and lower(alias) = lower(${alias})
      returning id`;
      if (rows.length === 0) {
        throw new ApiError(404, surface.notAnAlias(alias, entity));
      }
      // deno-lint-ignore no-explicit-any
      return c.json(await surface.respond(entity.id) as any);
    },
  );
}
