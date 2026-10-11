// The one piece of workerd this app reads: the coach's service binding. The
// full Workers type package is not needed for that.
declare module "cloudflare:workers" {
  export const env: {
    COACH?: { fetch: (request: Request) => Promise<Response> };
  };
}
