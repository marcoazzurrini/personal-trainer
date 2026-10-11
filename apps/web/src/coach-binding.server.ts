// The service binding exists only inside workerd. Under the Node development
// server there is none, and the proxy answers that the coach is not connected.
export async function coachBinding(): Promise<
  ((request: Request) => Promise<Response>) | undefined
> {
  try {
    const { env } = await import("cloudflare:workers");
    const coach = env.COACH;
    return coach ? (request) => coach.fetch(request) : undefined;
  } catch {
    return undefined;
  }
}
