// A document name is lowercase words joined by hyphens, nested with
// slashes: "programming", "method/hypertrophy". No dots at all, so a name
// can never spell ".." and escape the docs folder.
const DOC_NAME_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

export const MAX_DOC_NAME = 80;

export function isDocName(name: string): boolean {
  return name.length <= MAX_DOC_NAME && DOC_NAME_RE.test(name);
}

// Where the documents live, defined once. Two callers now: the docs route
// serves them, and /training-state has to say whether a track's method
// document exists yet — a plan on a track with no method document is coached
// from general knowledge, and the API states that rather than leaving the
// coach to discover it.
export function docUrl(name: string): URL {
  return new URL(`../docs/${name}.md`, import.meta.url);
}

// Reads the file rather than stat-ing it: the edge runtime serves Deno.stat
// no better than a missing file, so a stat-based check reported every method
// document absent and quietly told the coach it was working from general
// knowledge about a track that has a document. The documents are a few
// kilobytes and this runs once per active plan.
export async function docExists(name: string): Promise<boolean> {
  if (!isDocName(name)) return false;
  try {
    await Deno.readTextFile(docUrl(name));
    return true;
  } catch {
    return false;
  }
}
