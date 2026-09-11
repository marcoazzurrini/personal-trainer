# The dashboard is installable and remains online-only

ADR-0009 deferred installation until there was a use case. Marco now wants to
open the dashboard from his iPhone Home Screen. This decision supersedes only
that deferral, not the dashboard's read-only role or its privacy boundaries.

The web app serves a static web manifest with a stable root identity, root start
URL and scope, standalone display, and the dashboard's colours. An original PT
monogram supplies the manifest icons and Apple touch icon. The root document
links these public assets. The PNG exports are committed; a script using the
existing Playwright development dependency regenerates them from SVG outlines.
No new runtime dependency, native wrapper, or PWA build plugin is needed.

Installation and offline access are separate capabilities. This version needs
an internet connection. It registers no service worker, persists no training
records in browser storage, and adds no background sync. Private HTML and data
responses retain `Cache-Control: private, no-store`. The existing WorkOS flow,
server-function checks, and API credential policy are unchanged.

Browser tests exercise the production output: the anonymous document links the
manifest and Apple icon, the manifest and PNGs are public without API reads or
session creation, and PNG dimensions match their declarations. An authenticated
browser still has no service worker registrations, Cache Storage entries,
localStorage entries, or IndexedDB databases after reading and refreshing data.
Existing tests continue to check private response headers and authentication.

These tests do not prove iOS Home Screen installation or the hosted provider
flow. Installation, sign-in, reopening, refresh, and sign-out must also be
checked on an iPhone against the hosted HTTPS dashboard. Safari's installation
menu is the entry point; no custom install prompt is added.
