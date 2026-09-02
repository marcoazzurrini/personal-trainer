// The coaching documents: what a name may be, and where the files are.
//
// The documents are the product, and the whole point of bundling them with the
// function is that updating the coach's knowledge is a git push.

// A document name is lowercase words joined by hyphens, nested with
// slashes: "programming", "method/hypertrophy". No dots at all, so a name
// can never spell ".." and escape the docs folder.
const DOC_NAME_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

export const MAX_DOC_NAME = 80;

export function isDocName(name: string): boolean {
  return name.length <= MAX_DOC_NAME && DOC_NAME_RE.test(name);
}

// Where the documents live, defined once, for the route that serves them.
export function docUrl(name: string): URL {
  // Up one, because the markdown lives at api/docs/ and this file is in
  // api/surfaces/. The folder could not be renamed to match: docs/ is already
  // the documents themselves.
  return new URL(`../docs/${name}.md`, import.meta.url);
}
