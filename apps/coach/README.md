# Coach

The in-app coach: a [Flue](https://flueframework.com) agent on Cloudflare that runs the `personal-trainer` skill from `plugin/` with a model, and reaches the API through its `api` tool. One Durable Object holds Marco's one conversation and compacts it as it grows.

The Worker has no route and no `workers.dev` address. The web app reaches it through its `COACH` service binding after checking who is signed in; the coach reaches the API through its own `API` binding with `COACH_AGENT_TOKEN`.

## Local development

Fill `.env` from `.env.example`, and give the API's local `.env` the same `COACH_AGENT_TOKEN`. Start the API with `bun run dev` from the repository root, then, from `apps/coach/`:

```sh
bun run build
bunx wrangler dev --local
```

`wrangler dev` reads the built output, and its service binding finds the API's local Worker. Talk to the coach directly:

```sh
curl -X POST http://localhost:8787/agents/coach/local \
  -H 'content-type: application/json' -d '{"kind":"user","body":"ciao"}'
curl http://localhost:8787/agents/coach/local
```

`bunx flue docs` prints the Flue documentation for the installed version.
