"""RFC 8785 canonical JSON for the protocol's strict JSON value domain."""

import json
import math
from decimal import Decimal
from typing import Any


def _quote(value: str) -> str:
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("invalid_unicode")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _number(value: int | float) -> str:
    if type(value) is int:
        if abs(value) > 9_007_199_254_740_991:
            raise ValueError("unsafe_json_integer")
        return str(value)
    if not math.isfinite(value):
        raise ValueError("invalid_json_number")
    if value == 0:
        return "0"

    decimal = Decimal(repr(value))
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        fixed = format(decimal, "f")
        if "." in fixed:
            fixed = fixed.rstrip("0").rstrip(".")
        return fixed

    normalized = decimal.normalize()
    parts = normalized.as_tuple()
    if not isinstance(parts.exponent, int):
        raise ValueError("invalid_json_number")
    digits = "".join(str(digit) for digit in parts.digits)
    exponent = len(digits) + parts.exponent - 1
    mantissa = digits[0] + (f".{digits[1:]}" if len(digits) > 1 else "")
    sign = "-" if parts.sign else ""
    exponent_text = f"+{exponent}" if exponent >= 0 else str(exponent)
    return f"{sign}{mantissa}e{exponent_text}"


def _sort_key(value: str) -> bytes:
    # JCS sorts property names by UTF-16 code units, independent of Python's
    # Unicode scalar-value ordering.
    return value.encode("utf-16-be")


def canonicalize(value: Any) -> str:
    def serialize(item: Any) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if type(item) in (int, float):
            return _number(item)
        if isinstance(item, str):
            return _quote(item)
        if isinstance(item, list):
            return "[" + ",".join(serialize(child) for child in item) + "]"
        if isinstance(item, dict) and all(isinstance(key, str) for key in item):
            members = (
                _quote(key) + ":" + serialize(item[key])
                for key in sorted(item, key=_sort_key)
            )
            return "{" + ",".join(members) + "}"
        raise ValueError("invalid_json_value")

    return serialize(value)
