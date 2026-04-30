#!/usr/bin/env python3
"""
Drives a 100%-medicash payment session: plugin claims, sends chargeContext
with full pointUseAmount, then sends session.result with tossResponse: null.
Verifies backend accepts the null-tossResponse shape produced by FE
front-plugin-js/payment.html when charged === 0.

Usage:
  python3 tools/100pct-medicash-test.py \
    --base-url wss://develop.api.core.smartdoctor.systems \
    --serial TF-DEV-JJ-001 \
    --token crm_qalmighty
"""
import argparse
import asyncio
import json

import websockets


async def heartbeat(ws):
    while True:
        await asyncio.sleep(20)
        await ws.send(json.dumps({"type": "ping", "payload": {}}))


async def main(args):
    uri = (
        f"{args.base_url.rstrip('/')}/ws/plugin"
        f"?serial={args.serial}&token={args.token}"
    )
    async with websockets.connect(uri) as ws:
        print(f"connected {uri}")
        await ws.send(
            json.dumps(
                {
                    "type": "device.register",
                    "payload": {"serialNumber": args.serial, "sdkVersion": "v0"},
                }
            )
        )
        asyncio.create_task(heartbeat(ws))

        async for raw in ws:
            msg = json.loads(raw)
            print(json.dumps(msg, ensure_ascii=False, indent=2))
            if msg.get("type") != "session.dispatch":
                continue
            payload = msg["payload"]
            if payload.get("kind") != "payment":
                continue

            session_id = payload["sessionId"]
            amount = payload["amount"]
            treatment_total = (
                int(amount["supplyValue"]) + int(amount["tax"]) + int(amount["tip"])
            )
            # Force 100% point coverage: pointUseAmount == treatment_total.
            # Validation: pointUseAmount + 0 + 0 + 0 == supplyValue + tax + tip → passes.
            await ws.send(
                json.dumps({"type": "session.claim", "payload": {"sessionId": session_id}})
            )
            await asyncio.sleep(0.3)
            await ws.send(
                json.dumps(
                    {
                        "type": "session.chargeContext",
                        "payload": {
                            "sessionId": session_id,
                            "pointUseAmount": treatment_total,
                            "chargedSupplyValue": 0,
                            "chargedTax": 0,
                        },
                    }
                )
            )
            await asyncio.sleep(0.3)
            await ws.send(
                json.dumps(
                    {
                        "type": "session.result",
                        "payload": {
                            "sessionId": session_id,
                            "pointUseAmount": treatment_total,
                            "chargedSupplyValue": 0,
                            "chargedTax": 0,
                            "tossResponse": None,
                        },
                    }
                )
            )
            print(f"sent 100%-medicash session.result for {session_id}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="wss://develop.api.core.smartdoctor.systems")
    ap.add_argument("--serial", default="TF-DEV-JJ-001")
    ap.add_argument("--token", required=True)
    asyncio.run(main(ap.parse_args()))
