// A runtime environment variable is not build provenance. Only the image build
// writes this file; local native runs deliberately have no release revision.
export function readBuildRevision(
  read: () => string = () =>
    Deno.readTextFileSync(new URL("../../build-revision.txt", import.meta.url)),
): string | null {
  let revision: string;
  try {
    revision = read().trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error(
      "The image's build revision must be a full lowercase commit SHA.",
    );
  }
  return revision;
}
