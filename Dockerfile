# The API as Coolify runs it: migrate, then serve, on port 8000.
FROM denoland/deno:2.9.6

WORKDIR /app

# Dependencies first, so a code change does not refetch them.
COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno api ./api
COPY --chown=deno:deno db ./db

# Everything the two entrypoints import, resolved against the lockfile and
# nothing else: a lockfile that has drifted fails the build, not the boot.
USER deno
RUN deno install --entrypoint --frozen api/index.ts db/migrate.ts

# Coolify supplies the commit it actually checks out, not an expected SHA from
# the polling client. A missing/invalid value must fail the build. Native local
# runs have no file; container smoke tests explicitly use a synthetic SHA.
USER root
ARG SOURCE_COMMIT
RUN deno eval 'const sha = Deno.env.get("SOURCE_COMMIT") ?? ""; if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("SOURCE_COMMIT must identify the checked-out source"); Deno.writeTextFileSync("build-revision.txt", sha + "\n")'

USER deno
ENV PORT=8000
EXPOSE 8000

# The image has no curl; Deno fetches the health route itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD deno eval "const r = await fetch('http://127.0.0.1:8000/api/health'); Deno.exit(r.ok ? 0 : 1)"

STOPSIGNAL SIGTERM
CMD ["deno", "task", "start"]
