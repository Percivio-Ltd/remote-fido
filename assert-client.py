#!/usr/bin/env python3

"""Run one WebAuthn assertion with Yubico's browser-like Fido2Client."""

from __future__ import annotations

import argparse
import getpass
import json
import logging
import os
import signal
import sys
import threading
from typing import Any

from fido2.client import (
    ClientError,
    DefaultClientDataCollector,
    Fido2Client,
    UserInteraction,
)
from fido2.ctap import CtapError
from fido2.ctap2.pin import ClientPin
from fido2.hid import CtapHidDevice
from fido2.webauthn import PublicKeyCredentialRequestOptions


class AssertionCancelled(Exception):
    """Raised on supervised shutdown so getpass can restore Terminal state."""


def handle_cancel(_signum: int, _frame: object) -> None:
    raise AssertionCancelled("remote ceremony was canceled")


class LocalInteraction(UserInteraction):
    def __init__(self) -> None:
        self.pin_prompts = 0

    def prompt_up(self) -> None:
        print(
            "\n\a\033[1;33mTOUCH YUBIKEY NOW\033[0m — the authenticator "
            "has requested user presence. Repeated taps do not cancel it.",
            file=sys.stderr,
            flush=True,
        )

    def request_pin(self, permissions: Any, rp_id: str | None) -> str | None:
        del permissions
        self.pin_prompts += 1
        scope = f" for {rp_id}" if rp_id else ""
        retry = f" (attempt {self.pin_prompts}/3)" if self.pin_prompts > 1 else ""
        pin = getpass.getpass(
            f"YubiKey PIN{scope}{retry} (local; not stored): "
        )
        return pin or None

    def request_uv(self, permissions: Any, rp_id: str | None) -> bool:
        del permissions, rp_id
        return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout-ms", type=int, default=180_000)
    parser.add_argument("--uv", choices=("required", "preferred", "discouraged"),
                        default="preferred")
    parser.add_argument("device")
    return parser.parse_args()


def select_device(path: str) -> CtapHidDevice:
    expected = path.removeprefix("ioreg://")
    devices = list(CtapHidDevice.list_devices())
    matches = [device for device in devices if str(device.descriptor.path) == expected]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one authenticator at {path}; found {len(matches)}"
        )
    return matches[0]


def pin_invalid(error: Exception) -> bool:
    return (
        isinstance(error, ClientError)
        and isinstance(error.cause, CtapError)
        and error.cause.code == CtapError.ERR.PIN_INVALID
    )


def pin_blocked(error: Exception) -> bool:
    if not (
        isinstance(error, ClientError)
        and isinstance(error.cause, CtapError)
    ):
        return False
    blocked_codes = {
        getattr(CtapError.ERR, "PIN_BLOCKED", None),
        getattr(CtapError.ERR, "PIN_AUTH_BLOCKED", None),
    }
    return error.cause.code in blocked_codes


def main() -> int:
    args = parse_args()
    if not 30_000 <= args.timeout_ms <= 300_000:
        raise ValueError("timeout must be between 30000 and 300000 ms")
    if os.environ.get("REMOTE_FIDO_DEBUG"):
        logging.basicConfig(level=logging.DEBUG)
    signal.signal(signal.SIGTERM, handle_cancel)

    payload = json.load(sys.stdin)
    if not isinstance(payload, dict) or not isinstance(payload.get("origin"), str):
        raise TypeError("invalid assertion-client input")
    options_data = payload.get("options")
    if not isinstance(options_data, dict):
        raise TypeError("missing WebAuthn request options")
    if options_data.get("userVerification") != args.uv:
        raise ValueError("user-verification policy changed between exporter and client")

    options = PublicKeyCredentialRequestOptions.from_dict(options_data)
    device = select_device(args.device)
    event = threading.Event()
    timer = threading.Timer(args.timeout_ms / 1000, event.set)
    timer.daemon = True
    timer.start()
    try:
        interaction = LocalInteraction()
        client = Fido2Client(
            device,
            DefaultClientDataCollector(payload["origin"]),
            interaction,
        )
        while True:
            try:
                selection = client.get_assertion(options, event)
                break
            except ClientError as error:
                if pin_blocked(error):
                    print(
                        "The YubiKey has temporarily blocked PIN authentication. "
                        "Unplug and reinsert it before trying again.",
                        file=sys.stderr,
                        flush=True,
                    )
                    raise
                if not pin_invalid(error) or interaction.pin_prompts >= 3:
                    raise
                backend = getattr(client, "_backend", None)
                ctap2 = getattr(backend, "ctap2", None)
                if ctap2 is None:
                    raise
                retries, _ = ClientPin(ctap2).get_pin_retries()
                if retries <= 1:
                    print(
                        f"Incorrect PIN; only {retries} retry remains. "
                        "Stopping before the key can be blocked.",
                        file=sys.stderr,
                        flush=True,
                    )
                    raise
                print(
                    f"Incorrect PIN; {retries} retries remain. Try again.",
                    file=sys.stderr,
                    flush=True,
                )
        response = selection.get_response(0)
        print(json.dumps(dict(response), separators=(",", ":")), flush=True)
        return 0
    finally:
        timer.cancel()
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionCancelled as error:
        print(f"assertion client canceled: {error}", file=sys.stderr)
        raise SystemExit(2)
    except Exception as error:
        print(f"assertion client failed: {type(error).__name__}: {error}",
              file=sys.stderr)
        raise SystemExit(1)
