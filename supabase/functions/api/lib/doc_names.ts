// A document name is lowercase words joined by hyphens, nested with
// slashes: "programming", "method/hypertrophy". No dots at all, so a name
// can never spell ".." and escape the docs folder.
const DOC_NAME_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

export const MAX_DOC_NAME = 80;

export function isDocName(name: string): boolean {
  return name.length <= MAX_DOC_NAME && DOC_NAME_RE.test(name);
}
