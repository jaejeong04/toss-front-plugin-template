window.smartdoctor = window.smartdoctor || {};

window.smartdoctor.config = {
  // Backend host — must match the Toss project's ACL (URL).
  BACKEND_HOST: "release.api.core.smartdoctor.systems",

  // Dev-only token. Backend confirmed `crm_qalmighty` is accepted on dev for
  // both CRM and plugin sockets (loose dev auth). Production token sourcing is
  // an open question — likely sdk.app.getMerchant() + a separate login HTTP
  // call, or a token issued by the Toss partner-portal device registration.
  // TODO(prod-token): replace this constant with the real token-fetch flow
  // before live deploy. See docs/superpowers/specs/toss-payment-flow.md §1.
  CORE_TOKEN: "crm_qalmighty",
};

window.smartdoctor.backendWsUrl = function (path) {
  return `wss://${window.smartdoctor.config.BACKEND_HOST}${path}`;
};

// Plugin WS B URL builder. Per docs/superpowers/specs/toss-payment-flow.md §1
// the path is `/ws/plugin` (not `/plugin`) and requires both `serial` and
// `token` query params. Centralized so the token-source change later touches
// one line.
window.smartdoctor.pluginWsUrl = function (serialNumber) {
  const path =
    "/ws/plugin?serial=" +
    encodeURIComponent(serialNumber) +
    "&token=" +
    encodeURIComponent(window.smartdoctor.config.CORE_TOKEN);
  return window.smartdoctor.backendWsUrl(path);
};
