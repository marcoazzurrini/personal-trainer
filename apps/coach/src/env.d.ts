// The bindings this Worker's own code reads; Flue declares its generated ones.
declare namespace Cloudflare {
  interface Env {
    API: Fetcher;
    COACH_AGENT_TOKEN?: string;
  }
}
