#!/usr/bin/env python3

"""Run one local, PIN-free WebAuthn touch probe against a FIDO key."""

from __future__ import annotations

import argparse
import base64
import os
import sys
import threading

from fido2.client import DefaultClientDataCollector, Fido2Client, UserInteraction
from fido2.hid import CtapHidDevice
from fido2.webauthn import PublicKeyCredentialCreationOptions


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


class TouchInteraction(UserInteraction):
    def prompt_up(self) -> None:
        print(
            "\n\a\033[1;33mTOUCH THIS YUBIKEY NOW\033[0m — local sensor probe",
            file=sys.stderr,
            flush=True,
        )

    def request_pin(self, permissions: object, rp_id: str | None) -> str | None:
        del permissions, rp_id
        raise RuntimeError("touch probe unexpectedly requested a PIN")

    def request_uv(self, permissions: object, rp_id: str | None) -> bool:
        del permissions, rp_id
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout-ms", type=int, default=120_000)
    parser.add_argument("device")
    return parser.parse_args()


def select_device(path: str) -> CtapHidDevice:
    expected = path.removeprefix("ioreg://")
    matches = [
        device for device in CtapHidDevice.list_devices()
        if str(device.descriptor.path) == expected
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one authenticator at {path}; found {len(matches)}"
        )
    return matches[0]


def main() -> int:
    args = parse_args()
    if not 10_000 <= args.timeout_ms <= 300_000:
        raise ValueError("timeout must be between 10000 and 300000 ms")

    options = PublicKeyCredentialCreationOptions.from_dict({
        "rp": {
            "id": "remote-fido-touch-probe.invalid",
            "name": "Remote FIDO touch probe",
        },
        "user": {
            "id": b64url(os.urandom(32)),
            "name": "local-touch-probe",
            "displayName": "Local touch probe",
        },
        "challenge": b64url(os.urandom(32)),
        "pubKeyCredParams": [{"type": "public-key", "alg": -7}],
        "timeout": args.timeout_ms,
        "authenticatorSelection": {
            "authenticatorAttachment": "cross-platform",
            "residentKey": "discouraged",
            "userVerification": "discouraged",
        },
        "attestation": "none",
    })

    device = select_device(args.device)
    cancel = threading.Event()
    timer = threading.Timer(args.timeout_ms / 1000, cancel.set)
    timer.daemon = True
    timer.start()
    try:
        client = Fido2Client(
            device,
            DefaultClientDataCollector(
                "https://remote-fido-touch-probe.invalid"
            ),
            TouchInteraction(),
        )
        client.make_credential(options, cancel)
        print("TOUCH ACCEPTED — local CTAP user presence works", flush=True)
        return 0
    finally:
        timer.cancel()
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"touch probe failed: {type(error).__name__}: {error}",
              file=sys.stderr)
        raise SystemExit(1)
