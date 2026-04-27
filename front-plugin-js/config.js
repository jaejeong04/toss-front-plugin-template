window.smartdoctor = window.smartdoctor || {};

window.smartdoctor.config = {
  // backend not built yet — placeholder per user direction
  BACKEND_HOST: "TODO",
};

// path must start with "/" — concatenated as-is, no normalization
window.smartdoctor.backendUrl = function (path) {
  return `https://${window.smartdoctor.config.BACKEND_HOST}${path}`;
};

window.smartdoctor.backendWsUrl = function (path) {
  return `wss://${window.smartdoctor.config.BACKEND_HOST}${path}`;
};

window.smartdoctor.PENDING_KEY = "smartdoctor.pendingPayment";

// Returns { sessionId } on a successful recovery send (so the caller can
// dedupe against a concurrent session.reconcile for the same sessionId), or
// null in every other case (no pending entry, corrupt entry, PAYMENT_NOT_FOUND,
// no live ws, or any other error).
window.smartdoctor.runPendingPaymentRecovery = async function ({ ws } = {}) {
  let pendingJson;
  try {
    const res = await sdk.storage.get({ key: window.smartdoctor.PENDING_KEY });
    pendingJson = res && res.value;
  } catch (e) {
    console.warn("[smartdoctor] pending payment storage read failed", e);
    return null;
  }

  if (!pendingJson) {
    return null;
  }

  let pending;
  try {
    pending = JSON.parse(pendingJson);
  } catch (e) {
    console.warn("[smartdoctor] pending payment JSON parse failed", e);
    return null;
  }

  if (!pending || !pending.paymentKey) {
    // Corrupt or partial pending entry — clean it up so we don't retry forever.
    try {
      await sdk.storage.remove({ key: window.smartdoctor.PENDING_KEY });
    } catch (e) {
      console.warn("[smartdoctor] pending payment remove failed", e);
    }
    return null;
  }

  try {
    const result = await sdk.payment.getPayment({
      paymentKey: pending.paymentKey,
    });

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "session.result",
          payload: {
            sessionId: pending.sessionId,
            pointUseAmount: pending.pointUseAmount,
            chargedSupplyValue: pending.chargedSupplyValue,
            chargedTax: pending.chargedTax,
            tossResponse: result,
            late: true,
          },
        }),
      );
      await sdk.storage.remove({ key: window.smartdoctor.PENDING_KEY });
      return { sessionId: pending.sessionId };
    }
    // No ws (or ws not open): keep storage so a later page with a live WS
    // can finish posting session.result. Spec §5.
    return null;
  } catch (e) {
    // TODO(verify-error-shape): SDK error shape isn't publicly documented — verify on real device.
    if (e && e.code === "PAYMENT_NOT_FOUND") {
      // nothing to recover — user aborted or device never approved (spec §5)
      try {
        await sdk.storage.remove({ key: window.smartdoctor.PENDING_KEY });
      } catch (removeErr) {
        console.warn("[smartdoctor] pending payment remove failed", removeErr);
      }
      return null;
    }
    // Any other error: leave storage in place, swallow, log for debug.
    console.warn("[smartdoctor] pending payment recovery error", e);
    return null;
  }
};
