import catalogue from "./catalogue.json" with { type: "json" };

// Loads the versioned catalogue through the API. Existing rows (409) are skipped.
// Use base_url and a fresh token from the connector's get_api_token tool.
// API_URL=... API_TOKEN=... bun --no-env-file api/tests/fixtures/catalogue.ts
// API_TOKEN is client input, not server configuration. Never save it in .env.
type CatalogueExercise = (typeof catalogue.exercises)[number];

export async function loadCatalogue(base: string, token: string) {
  if (!token.trim()) {
    throw new Error(
      "API_TOKEN is required for catalogue loading. Use the token returned by the connector's get_api_token tool; set API_URL to its base_url."
    );
  }
  async function post(
    path: "/muscles" | "/exercises",
    body: { name: string } | CatalogueExercise
  ): Promise<"created" | "skipped"> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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
  let created = 0;
  let skipped = 0;
  for (const name of catalogue.muscles) {
    if ((await post("/muscles", { name })) === "created") {
      created += 1;
    } else {
      skipped += 1;
    }
  }
  console.log(`muscles: ${created} created, ${skipped} skipped`);
  created = 0;
  skipped = 0;
  for (const exercise of catalogue.exercises) {
    if ((await post("/exercises", exercise)) === "created") {
      created += 1;
    } else {
      skipped += 1;
    }
  }
  console.log(`exercises: ${created} created, ${skipped} skipped`);
}

if (import.meta.main) {
  await loadCatalogue(
    process.env.API_URL ?? "http://127.0.0.1:8000/api",
    process.env.API_TOKEN ?? ""
  );
}
