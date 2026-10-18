"""External imports stay explicit in M4: emitted verbatim with provenance
warnings; the stdlib registry maps them in M5 (S2 will report the unresolved
modules honestly, capping the claim level)."""

import json


def encode(value: dict) -> str:
    return json.dumps(value)
