// The page where Marco says yes. Supabase's sign-in server sends the browser
// here with an authorization_id when a client — the plugin's connector — asks
// to act for him. The page signs him in with Google if he is not already,
// shows who is asking, and on Approve hands the browser back to the client
// with the answer. Supabase requires the page to exist and to be ours; this
// is the least of it.
//
// Served by the function rather than hosted elsewhere for the same reason the
// reference page is: the project has no other web host, and a page that is a
// single file with no build step does not deserve one. supabase-js arrives
// from a CDN the way Scalar does. The only value rendered in is the anon key,
// which every browser client of this project holds and which authorizes
// nothing on its own.
//
// Nothing here is a template literal placeholder except the key: the page's
// own JavaScript avoids backticks so the two languages do not interleave.

export function consentPage(anonKey: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Coach sign-in</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; max-width: 32rem; margin-inline: auto; color: #222; }
      h1 { font-size: 1.25rem; margin: 0 0 1rem; }
      button { font: inherit; padding: 0.5rem 1.25rem; margin-right: 0.5rem; cursor: pointer; }
      #status { color: #555; }
    </style>
  </head>
  <body>
    <h1>Personal trainer</h1>
    <p id="status">Checking your sign-in…</p>
    <div id="consent" hidden>
      <p>Allow <strong id="client">the connector</strong> to use the coach API as <span id="who"></span>?</p>
      <button id="approve">Approve</button>
      <button id="deny">Deny</button>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
    <script>
      var ANON_KEY = ${JSON.stringify(anonKey)};
      var status = document.getElementById("status");
      var consent = document.getElementById("consent");
      function say(text) { status.hidden = false; status.textContent = text; }

      var authorizationId = new URLSearchParams(location.search).get("authorization_id");
      if (!authorizationId) {
        say("Open this page from the sign-in flow: it needs an authorization_id, and there is nothing to approve without one.");
      } else {
        var client = supabase.createClient(location.origin, ANON_KEY);
        client.auth.getSession().then(function (got) {
          var session = got.data && got.data.session;
          if (!session) {
            say("Sending you to Google to sign in…");
            return client.auth.signInWithOAuth({
              provider: "google",
              options: { redirectTo: location.href },
            }).then(function (res) {
              if (res.error) say("Sign-in failed: " + res.error.message);
            });
          }
          return client.auth.oauth.getAuthorizationDetails(authorizationId).then(function (res) {
            if (res.error) { say("Could not read the request: " + res.error.message); return; }
            var details = res.data || {};
            var name = (details.client && details.client.name) || details.client_name;
            if (name) document.getElementById("client").textContent = name;
            document.getElementById("who").textContent = session.user.email;
            status.hidden = true;
            consent.hidden = false;
            document.getElementById("approve").onclick = function () {
              client.auth.oauth.approveAuthorization(authorizationId).then(function (r) {
                if (r.error) { say("Approval failed: " + r.error.message); return; }
                location.href = r.data.redirect_url;
              });
            };
            document.getElementById("deny").onclick = function () {
              client.auth.oauth.denyAuthorization(authorizationId).then(function (r) {
                if (r.error) { say("Could not deny: " + r.error.message); return; }
                location.href = r.data.redirect_url;
              });
            };
          });
        }).catch(function (err) { say("Something went wrong: " + err.message); });
      }
    </script>
  </body>
</html>
`;
}
