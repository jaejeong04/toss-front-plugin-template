window.smartdoctor = window.smartdoctor || {};

window.smartdoctor.config = {
  // Backend host — must match the Toss project's ACL (URL).
  BACKEND_HOST: "develop.api.core.smartdoctor.systems",

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

// Serial port setup for NICE 카드단말기 reader-mode bridge.
// Per Toss Slack guidance (channel C0ANAJW463E msg 1778737088, 2026-05-14):
// - Plugin opens serial at baudRate 115200 with intercept: true
// - Listener forwards every serial frame to sdk.van.write (Toss internal VAN module)
// - Toss FRONT firmware auto-overlays its 통합결제창 when NICE triggers
// - Page-scoped: each page that calls this also gets a beforeunload close.
//   Called from home.html main() and order.html main() so the serial port
//   is alive from boot through the medicash UI into reader mode.
//   payment.html does NOT call this — it's only entered for 100%-메디캐시
//   (NICE bypassed entirely).
window.smartdoctor.initSerialPort = function () {
  // Split sdk.serial.open vs. sdk.serial.listen failure modes so an
  // open-succeeded-but-listen-threw case can't leak an orphan port.

  try {
    sdk.serial.open({ baudRate: 115200, intercept: true });
  } catch (e) {
    // Port never opened. Nothing to clean up; skip registering beforeunload.
    console.warn("[smartdoctor] sdk.serial.open failed", e);
    return;
  }

  let unlisten = null;
  try {
    unlisten = sdk.serial.listen((params) => {
      try {
        sdk.van.write(params);
      } catch (e) {
        console.warn("[smartdoctor] sdk.van.write failed", e);
      }
    });
  } catch (e) {
    // Port is open but no listener. Still need to close on unload.
    console.warn("[smartdoctor] sdk.serial.listen failed", e);
  }

  // Cleanup on unload. Port is definitely open at this point (the
  // open-failure branch above returned early). If listen threw,
  // unlisten stays null and we just close the port.
  window.addEventListener("beforeunload", () => {
    try {
      sdk.serial.close();
      if (unlisten !== null) unlisten();
    } catch (e) {
      console.warn("[smartdoctor] sdk.serial.close failed", e);
    }
  });
};
