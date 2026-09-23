// Replaced by the bundler, never by a caller-controlled runtime binding.
// A dirty local build has no commit revision; its content digest still identifies
// the exact deployed artifact. CI records both the tested commit and the digest.
declare const __BUILD_METADATA__: {
  revision: string | null;
  digest: string;
};

export const buildMetadata = typeof __BUILD_METADATA__ === "undefined"
  ? { revision: null, digest: "local-development" }
  : __BUILD_METADATA__;
