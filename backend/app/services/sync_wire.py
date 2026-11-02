"""Contract validation and RFC 8785 hashing for immutable sync envelopes."""

import hashlib
import json
import unicodedata
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import UUID

from jsonschema import Draft202012Validator, FormatChecker, ValidationError  # type: ignore[import-untyped]
from pydantic import ValidationError as PydanticValidationError

from app.schemas.problem import FieldError
from app.schemas.sync import OperationEnvelope

OPERATION_BYTES_LIMIT = 2_097_152
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_DEVICE_SEQUENCE = 18_446_744_073_709_551_615
_JS_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
SCHEMA_PATH = Path(__file__).resolve().parents[3] / "docs" / "tasks" / "t03" / "contract.schema.json"


class SyncWireError(ValueError):
    """A safe, stable validation failure that never retains request values."""

    def __init__(self, code: str, field_errors: list[FieldError] | None = None):
        super().__init__(code)
        self.code = code
        self.field_errors = field_errors


@dataclass(frozen=True)
class ValidatedOperation:
    envelope: dict[str, Any]
    canonical_envelope: bytes
    request_hash: bytes
    operation_id: UUID
    owner_id: UUID
    device_id: UUID
    device_sequence: int
    physical_ms: int
    logical: int
    calibration_id: UUID
    raw_wall_ms: int
    quality: str
    dependencies: tuple[UUID, ...]
    delete_rank: int


@lru_cache(maxsize=1)
def _operation_validator() -> Draft202012Validator:
    document = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    schema = {"$ref": "#/$defs/Operation", "$defs": document["$defs"]}
    return Draft202012Validator(schema, format_checker=FormatChecker())


@lru_cache(maxsize=1)
def _operation_property_names() -> frozenset[str]:
    pending = [_operation_validator().schema]
    names: set[str] = set()
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            properties = value.get("properties")
            if isinstance(properties, dict):
                names.update(key for key in properties if isinstance(key, str))
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return frozenset(names)


def _reject_value(value: Any) -> None:
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise SyncWireError("malformed_request")
        return
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        if not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            raise SyncWireError("malformed_request")
        return
    if type(value) is float:
        raise SyncWireError("malformed_request")
    if isinstance(value, list):
        for item in value:
            _reject_value(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise SyncWireError("malformed_request")
            _reject_value(key)
            _reject_value(item)
        return
    raise SyncWireError("malformed_request")


def _utf16_sort_key(value: str) -> bytes:
    try:
        return value.encode("utf-16-be")
    except UnicodeEncodeError:
        raise SyncWireError("malformed_request") from None


def _ordered_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _ordered_json(value[key]) for key in sorted(value, key=_utf16_sort_key)}
    if isinstance(value, list):
        return [_ordered_json(item) for item in value]
    return value


def canonical_json(value: Any) -> bytes:
    """Serialize the supported T03 JSON domain using RFC 8785 key ordering."""
    _reject_value(value)
    try:
        return json.dumps(
            _ordered_json(value),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except TypeError, ValueError, UnicodeEncodeError:
        raise SyncWireError("malformed_request") from None


def hash_envelope(canonical_envelope: bytes) -> bytes:
    return hashlib.sha256(canonical_envelope).digest()


def _json_pointer(parts) -> str:
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def _safe_json_pointer(parts) -> str:
    known_properties = _operation_property_names()
    safe_parts: list[int | str] = []
    for part in parts:
        if type(part) is int and part >= 0:
            safe_parts.append(part)
        elif isinstance(part, str) and part in known_properties:
            safe_parts.append(part)
        else:
            break
    return _json_pointer(safe_parts)


def _schema_field_errors(errors: list[ValidationError]) -> list[FieldError]:
    output = []
    for error in errors[:50]:
        output.append(FieldError(path=_safe_json_pointer(error.absolute_path), code="invalid_value"))
    return output


def _model_field_errors(error: PydanticValidationError) -> list[FieldError]:
    output = []
    for item in error.errors(include_url=False)[:50]:
        output.append(FieldError(path=_safe_json_pointer(item.get("loc", ())), code="invalid_value"))
    return output


def _delete_rank(envelope: dict[str, Any]) -> int:
    for command in envelope["commands"]:
        action = command["action"]
        if action.endswith(".delete") or action == "series.stop_future":
            return 1
    return 0


def _semantic_field_error(path: str) -> FieldError:
    return FieldError(path=path, code="invalid_value")


def _is_canonical_single_line(value: str) -> bool:
    normalized = unicodedata.normalize("NFC", value)
    return (
        value == normalized
        and value == value.strip(_JS_WHITESPACE)
        and not any(line_break in value for line_break in ("\n", "\r", "\u2028", "\u2029"))
    )


def _is_canonical_note(value: str) -> bool:
    normalized_newlines = value.replace("\r\n", "\n").replace("\r", "\n")
    return value == unicodedata.normalize("NFC", normalized_newlines)


def _is_int64(value: str) -> bool:
    if len(value) > 20:
        return False
    number = int(value)
    return -(1 << 63) <= number <= (1 << 63) - 1


def _command_semantic_errors(envelope: dict[str, Any]) -> list[FieldError]:
    errors: list[FieldError] = []
    task_data_actions = {
        "work_item.create_single",
        "work_item.enable_recurrence",
        "single.replace",
        "occurrence.replace",
        "detached.replace",
    }
    template_actions = {"work_item.create_recurrence", "series.edit_future"}

    for index, command in enumerate(envelope["commands"]):
        action = command["action"]
        payload = command["payload"]
        prefix = f"/commands/{index}/payload"

        if action in ("plan.create", "plan.replace"):
            name = payload["data"]["name"]
            if not _is_canonical_single_line(name):
                errors.append(_semantic_field_error(f"{prefix}/data/name"))
        elif action in ("milestone.create", "milestone.replace"):
            data = payload["data"]
            if not _is_canonical_single_line(data["title"]):
                errors.append(_semantic_field_error(f"{prefix}/data/title"))
            if not _is_canonical_note(data["note"]):
                errors.append(_semantic_field_error(f"{prefix}/data/note"))

        if action in task_data_actions:
            data = payload["data"]
            if not _is_canonical_single_line(data["title"]):
                errors.append(_semantic_field_error(f"{prefix}/data/title"))
            if not _is_int64(data["order_key"]):
                errors.append(_semantic_field_error(f"{prefix}/data/order_key"))

        if action in template_actions:
            template = payload["template"]
            if not _is_canonical_single_line(template["title"]):
                errors.append(_semantic_field_error(f"{prefix}/template/title"))
            if not _is_int64(template["order_key"]):
                errors.append(_semantic_field_error(f"{prefix}/template/order_key"))

        if action == "set_order" and not _is_int64(payload["order_key"]):
            errors.append(_semantic_field_error(f"{prefix}/order_key"))

        if action in template_actions | {"work_item.enable_recurrence"}:
            weekdays = payload["rule"]["weekdays"]
            if any(current <= previous for previous, current in zip(weekdays, weekdays[1:])):
                errors.append(_semantic_field_error(f"{prefix}/rule/weekdays"))
            if (
                action == "work_item.enable_recurrence"
                and date.fromisoformat(payload["data"]["date"]).isoweekday() not in weekdays
            ):
                errors.append(_semantic_field_error(f"{prefix}/rule/weekdays"))

    return errors[:50]


def validate_operation(value: Any) -> ValidatedOperation:
    if not isinstance(value, dict):
        raise SyncWireError("validation_failed")
    for version_field in ("protocol_version", "reducer_version"):
        version = value.get(version_field)
        if type(version) is int and version != 1:
            raise SyncWireError("client_update_required")

    canonical_envelope = canonical_json(value)
    if len(canonical_envelope) > OPERATION_BYTES_LIMIT:
        raise SyncWireError("payload_too_large")

    try:
        wire = OperationEnvelope.model_validate(value)
    except PydanticValidationError as error:
        raise SyncWireError("validation_failed", _model_field_errors(error)) from None

    schema_errors = sorted(
        _operation_validator().iter_errors(value),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    if schema_errors:
        raise SyncWireError("validation_failed", _schema_field_errors(schema_errors))

    semantic_errors = _command_semantic_errors(value)
    if semantic_errors:
        raise SyncWireError("validation_failed", semantic_errors)

    sequence = int(wire.device_sequence)
    if sequence > MAX_DEVICE_SEQUENCE:
        raise SyncWireError("validation_failed", [FieldError(path="/device_sequence", code="out_of_range")])

    return ValidatedOperation(
        envelope=value,
        canonical_envelope=canonical_envelope,
        request_hash=hash_envelope(canonical_envelope),
        operation_id=UUID(wire.operation_id),
        owner_id=UUID(wire.owner_id),
        device_id=UUID(wire.device_id),
        device_sequence=sequence,
        physical_ms=wire.edit_time.physical_ms,
        logical=wire.edit_time.logical,
        calibration_id=UUID(wire.edit_time.calibration_id),
        raw_wall_ms=wire.edit_time.raw_wall_ms,
        quality=wire.edit_time.quality,
        dependencies=tuple(UUID(value) for value in wire.dependencies),
        delete_rank=_delete_rank(value),
    )
