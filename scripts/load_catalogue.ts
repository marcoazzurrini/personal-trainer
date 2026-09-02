// Loads scripts/catalogue.json into an API instance. Idempotent: rows that
// already exist (409) are skipped, so re-running is safe.
//
// Usage:
//   API_URL=... API_TOKEN=... deno run --allow-net --allow-read --allow-env scripts/load_catalogue.ts

export async function loadCatalogue(base: string, token: string) {
  const catalogue = JSON.parse(
    await Deno.readTextFile(new URL("./catalogue.json", import.meta.url)),
  );

  async function post(
    path: string,
    body: unknown,
  ): Promise<"created" | "skipped"> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 201 || res.status === 409) {
      await res.body?.cancel();
      return res.status === 201 ? "created" : "skipped";
    }
    throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  }

  let created = 0, skipped = 0;
  for (const name of catalogue.muscles) {
    (await post("/muscles", { name })) === "created" ? created++ : skipped++;
  }
  console.log(`muscles: ${created} created, ${skipped} skipped`);

  created = 0, skipped = 0;
  for (const exercise of catalogue.exercises) {
    (await post("/exercises", exercise)) === "created" ? created++ : skipped++;
  }
  console.log(`exercises: ${created} created, ${skipped} skipped`);
}

if (import.meta.main) {
  await loadCatalogue(
    Deno.env.get("API_URL") ?? "http://127.0.0.1:8000/api",
    Deno.env.get("API_TOKEN") ?? "local-dev-token",
  );
}
