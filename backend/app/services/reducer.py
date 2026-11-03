"""Canonical reducer v1 server port for the non-recurring root operations."""

import copy
import hashlib
import re
import unicodedata
from datetime import date
from typing import Any
from uuid import UUID, uuid5

from app.services.canonical_json import canonicalize

COLORS = {
    "neutral",
    "earth",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "coral",
    "sand",
}
PERIODS = {"morning", "afternoon", "evening"}
NO_OP_REASONS = {
    "duplicate_target",
    "reference_unavailable",
    "target_retired",
    "precondition_failed",
    "undo_not_applicable",
}
INT64_MIN = -(2**63)
INT64_MAX = 2**63 - 1
HASH = re.compile(r"[0-9a-f]{64}")
ORDER = re.compile(r"(?:0|-?[1-9][0-9]*)")


class ReducerValidationError(ValueError):
    """The operation is not a valid protocol-v1 business command."""


class _NoOp(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ReducerValidationError(f"{label}_fields")
    return value


def _uuid(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value
    ):
        raise ReducerValidationError(f"{label}_uuid")
    return value


def _date(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ReducerValidationError(f"{label}_date")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ReducerValidationError(f"{label}_date") from None
    return value


def _text(value: Any, label: str, maximum: int, *, note: bool = False) -> str:
    if not isinstance(value, str):
        raise ReducerValidationError(f"{label}_text")
    normalized = unicodedata.normalize("NFC", value)
    canonical = normalized.replace("\r\n", "\n").replace("\r", "\n") if note else normalized.strip()
    if canonical != value or len(value) > maximum or (not note and len(value) < 1):
        raise ReducerValidationError(f"{label}_text")
    controls = re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]" if note else r"[\x00-\x1f\x7f]", value)
    if controls or (not note and ("\r" in value or "\n" in value)):
        raise ReducerValidationError(f"{label}_control")
    return value


def _color(value: Any, label: str) -> str:
    if not isinstance(value, str) or value not in COLORS:
        raise ReducerValidationError(f"{label}_color")
    return value


def _plan_data(value: Any, label: str) -> dict[str, Any]:
    item = _exact(value, {"name", "color_id"}, label)
    _text(item["name"], f"{label}_name", 100)
    _color(item["color_id"], f"{label}_color")
    return item


def _milestone_data(value: Any, label: str) -> dict[str, Any]:
    item = _exact(
        value,
        {
            "title",
            "date",
            "period",
            "note",
            "plan_id",
            "standalone_color_id",
            "show_in_work_calendar",
        },
        label,
    )
    _text(item["title"], f"{label}_title", 120)
    _date(item["date"], f"{label}_date")
    if item["period"] is not None and (not isinstance(item["period"], str) or item["period"] not in PERIODS):
        raise ReducerValidationError(f"{label}_period")
    _text(item["note"], f"{label}_note", 4000, note=True)
    _nullable_uuid(item["plan_id"], f"{label}_plan_id")
    _color(item["standalone_color_id"], f"{label}_standalone_color")
    if type(item["show_in_work_calendar"]) is not bool:
        raise ReducerValidationError(f"{label}_show_in_work_calendar")
    return item


def _task_data(value: Any, label: str) -> dict[str, Any]:
    item = _exact(
        value,
        {
            "title",
            "date",
            "period",
            "duration_minutes",
            "plan_id",
            "standalone_color_id",
            "status",
            "order_key",
        },
        label,
    )
    _text(item["title"], f"{label}_title", 120)
    _date(item["date"], f"{label}_date")
    if not isinstance(item["period"], str) or item["period"] not in PERIODS:
        raise ReducerValidationError(f"{label}_period")
    duration = item["duration_minutes"]
    if duration is not None and (type(duration) is not int or not 1 <= duration <= 1440):
        raise ReducerValidationError(f"{label}_duration")
    _nullable_uuid(item["plan_id"], f"{label}_plan_id")
    _color(item["standalone_color_id"], f"{label}_standalone_color")
    if item["status"] not in ("pending", "completed"):
        raise ReducerValidationError(f"{label}_status")
    _order_key(item["order_key"], f"{label}_order_key")
    return item


def _nullable_uuid(value: Any, label: str) -> str | None:
    return None if value is None else _uuid(value, label)


def _recurrence_rule(value: Any, label: str) -> dict[str, Any]:
    rule = _exact(value, {"weekdays"}, label)
    weekdays = rule["weekdays"]
    if (
        not isinstance(weekdays, list)
        or not 1 <= len(weekdays) <= 7
        or any(type(day) is not int or not 1 <= day <= 7 for day in weekdays)
        or weekdays != sorted(set(weekdays))
    ):
        raise ReducerValidationError(f"{label}_weekdays")
    return rule


def _task_template_data(value: Any, label: str) -> dict[str, Any]:
    item = _exact(
        value,
        {
            "title",
            "period",
            "duration_minutes",
            "plan_id",
            "standalone_color_id",
            "order_key",
        },
        label,
    )
    _text(item["title"], f"{label}_title", 120)
    if not isinstance(item["period"], str) or item["period"] not in PERIODS:
        raise ReducerValidationError(f"{label}_period")
    duration = item["duration_minutes"]
    if duration is not None and (type(duration) is not int or not 1 <= duration <= 1440):
        raise ReducerValidationError(f"{label}_duration")
    _nullable_uuid(item["plan_id"], f"{label}_plan_id")
    _color(item["standalone_color_id"], f"{label}_standalone_color")
    _order_key(item["order_key"], label)
    return item


def _validate_family_integrity(root_id: str, root: dict[str, Any]) -> None:
    _exact(
        root,
        {"owner_id", "deleted", "kind", "single", "segment_origins", "family"},
        "work_item_family",
    )
    if root["kind"] != "recurrence_family" or root["single"] is not None or type(root["deleted"]) is not bool:
        raise ReducerValidationError("work_item_family_shape")
    if not isinstance(root["segment_origins"], list) or not isinstance(root["family"], dict):
        raise ReducerValidationError("work_item_family_collections")
    family = _exact(
        root["family"],
        {"segments", "overrides", "order_overrides", "detached"},
        "family",
    )
    if any(not isinstance(family[key], list) for key in family):
        raise ReducerValidationError("family_collections")

    origins: dict[str, dict[str, Any]] = {}
    for origin in root["segment_origins"]:
        origin = _exact(
            origin,
            {
                "segment_id",
                "born_from_date",
                "created_by_operation_id",
                "command_index",
            },
            "segment_origin",
        )
        segment_id = _uuid(origin["segment_id"], "segment_origin_id")
        born = _date(origin["born_from_date"], "segment_origin_born_from_date")
        operation_id = _uuid(origin["created_by_operation_id"], "segment_origin_operation_id")
        command_index = origin["command_index"]
        if (
            type(command_index) is not int
            or command_index < 0
            or segment_id != _uuid5(root_id, f"segment:{operation_id}:{command_index}")
        ):
            raise ReducerValidationError("segment_origin_provenance")
        if segment_id in origins:
            raise ReducerValidationError("duplicate_segment_origin")
        origins[segment_id] = {**origin, "born_from_date": born}

    for segment in family["segments"]:
        if not isinstance(segment, dict):
            raise ReducerValidationError("invalid_rule_segment")
        _uuid(segment.get("segment_id"), "rule_segment_id")
        _date(segment.get("from_date"), "segment_from_date")
    segments = sorted(
        family["segments"],
        key=lambda entry: (entry["from_date"], UUID(entry["segment_id"]).bytes),
    )
    prior_segment: dict[str, Any] | None = None
    for segment in segments:
        segment = _exact(
            segment,
            {"segment_id", "from_date", "until_date", "rule", "template"},
            "rule_segment",
        )
        segment_id = _uuid(segment["segment_id"], "rule_segment_id")
        from_date = _date(segment["from_date"], "segment_from_date")
        until_date = None if segment["until_date"] is None else _date(segment["until_date"], "segment_until_date")
        if until_date is not None and from_date >= until_date:
            raise ReducerValidationError("empty_segment_interval")
        _recurrence_rule(segment["rule"], "segment_rule")
        _task_template_data(segment["template"], "segment_template")
        origin = origins.get(segment_id)
        if origin is None or origin["born_from_date"] != from_date:
            raise ReducerValidationError("missing_segment_origin")
        if prior_segment is not None and (
            prior_segment["until_date"] is None or from_date < prior_segment["until_date"]
        ):
            raise ReducerValidationError("overlapping_segments")
        prior_segment = {"from_date": from_date, "until_date": until_date}

    override_dates: set[str] = set()
    for override in family["overrides"]:
        override = _exact(
            override,
            {
                "override_id",
                "original_date",
                "source_segment_id",
                "kind",
                "replacement",
                "detached_task_id",
            },
            "occurrence_override",
        )
        requested = _date(override["original_date"], "override_date")
        override_id = _uuid(override["override_id"], "override_id")
        source_id = _uuid(override["source_segment_id"], "override_source")
        if override_id != _override_id(root_id, requested) or requested in override_dates or source_id not in origins:
            raise ReducerValidationError("invalid_occurrence_override")
        override_dates.add(requested)
        if override["kind"] == "replacement":
            if override["replacement"] is None or override["detached_task_id"] is not None:
                raise ReducerValidationError("invalid_replacement_override")
            _task_data(override["replacement"], "override_replacement")
            segment = _matching_segment(root, requested)
            if segment is None or segment["segment_id"] != source_id:
                raise ReducerValidationError("replacement_source_mismatch")
        elif override["kind"] == "deleted":
            if override["replacement"] is not None or override["detached_task_id"] is not None:
                raise ReducerValidationError("invalid_deleted_override")
        elif override["kind"] == "detached":
            if override["replacement"] is not None:
                raise ReducerValidationError("invalid_detached_override")
            _uuid(override["detached_task_id"], "detached_override_task_id")
        else:
            raise ReducerValidationError("unsupported_override_kind")

    rank_dates: set[str] = set()
    for rank in family["order_overrides"]:
        rank = _exact(
            rank,
            {"original_date", "source_segment_id", "order_key"},
            "occurrence_order_override",
        )
        requested = _date(rank["original_date"], "order_override_date")
        source_id = _uuid(rank["source_segment_id"], "order_override_source")
        _order_key(rank["order_key"], "order_override")
        if requested in rank_dates or requested in override_dates or source_id not in origins:
            raise ReducerValidationError("invalid_order_override")
        rank_dates.add(requested)
        segment = _matching_segment(root, requested)
        if segment is None or segment["segment_id"] != source_id:
            raise ReducerValidationError("order_override_source_mismatch")

    detached_ids: set[str] = set()
    for child in family["detached"]:
        child = _exact(
            child,
            {"task_id", "source_occurrence_id", "original_date", "data", "deleted"},
            "detached_task",
        )
        task_id = _uuid(child["task_id"], "detached_task_id")
        requested = _date(child["original_date"], "detached_original_date")
        source_id = _uuid(child["source_occurrence_id"], "detached_source_occurrence")
        _task_data(child["data"], "detached_data")
        if (
            type(child["deleted"]) is not bool
            or task_id != _detached_id(root_id, requested)
            or source_id != _occurrence_id(root_id, requested)
        ):
            raise ReducerValidationError("invalid_detached_task")
        if task_id in detached_ids:
            raise ReducerValidationError("duplicate_detached_task")
        detached_ids.add(task_id)

    for override in family["overrides"]:
        if override["kind"] == "detached":
            child = _find_detached(root, override["detached_task_id"])
            if (
                not child
                or child["original_date"] != override["original_date"]
                or child["source_occurrence_id"] != _occurrence_id(root_id, override["original_date"])
            ):
                raise ReducerValidationError("detached_override_reference")


def _order_key(value: Any, label: str) -> int:
    if not isinstance(value, str) or not ORDER.fullmatch(value):
        raise ReducerValidationError(f"{label}_order_key")
    number = int(value)
    if not INT64_MIN <= number <= INT64_MAX:
        raise ReducerValidationError(f"{label}_order_key")
    return number


def _root_key(root: dict[str, str]) -> str:
    return f"{root['kind']}:{root['id']}"


def _root(state: dict[str, Any], root: dict[str, str]) -> dict[str, Any] | None:
    return state["roots"].get(_root_key(root))


def _put(state: dict[str, Any], root: dict[str, str], value: dict[str, Any]) -> None:
    state["roots"][_root_key(root)] = value


def _plan_exists(state: dict[str, Any], plan_id: str | None) -> None:
    if plan_id is None:
        return
    plan = _root(state, {"kind": "plan", "id": plan_id})
    if plan is None or plan["deleted"]:
        raise _NoOp("reference_unavailable")


def _semantic_state(root: dict[str, str], value: dict[str, Any] | None) -> Any:
    if value is None:
        return None
    if root["kind"] in ("plan", "milestone"):
        return {
            "owner_id": value["owner_id"],
            "deleted": value["deleted"],
            "data": value["data"],
        }
    if value["kind"] == "single":
        return {
            "owner_id": value["owner_id"],
            "deleted": value["deleted"],
            "kind": "single",
            "single": value["single"],
            "segment_origins": sorted(
                value["segment_origins"],
                key=lambda entry: UUID(entry["segment_id"]).bytes,
            ),
            "family": None,
        }
    if value["kind"] == "recurrence_family":
        family = copy.deepcopy(value)
        _sort_family(family)
        return {
            "owner_id": family["owner_id"],
            "deleted": family["deleted"],
            "kind": "recurrence_family",
            "single": None,
            "segment_origins": family["segment_origins"],
            "family": family["family"],
        }
    raise ReducerValidationError("work_item_kind")


def _uuid5(root_id: str, name: str) -> str:
    return str(uuid5(UUID(root_id), name))


def _iso_weekday(value: str) -> int:
    return date.fromisoformat(value).isoweekday()


def _date_in_segment(requested: str, segment: dict[str, Any]) -> bool:
    return segment["from_date"] <= requested and (segment["until_date"] is None or requested < segment["until_date"])


def _sort_family(root: dict[str, Any]) -> None:
    root["segment_origins"].sort(key=lambda entry: UUID(entry["segment_id"]).bytes)
    root["family"]["segments"].sort(key=lambda entry: (entry["from_date"], UUID(entry["segment_id"]).bytes))
    root["family"]["overrides"].sort(key=lambda entry: entry["original_date"])
    root["family"]["order_overrides"].sort(key=lambda entry: entry["original_date"])
    root["family"]["detached"].sort(key=lambda entry: UUID(entry["task_id"]).bytes)


def _matching_segment(root: dict[str, Any], requested: str) -> dict[str, Any] | None:
    matches = [
        segment
        for segment in root["family"]["segments"]
        if _date_in_segment(requested, segment) and _iso_weekday(requested) in segment["rule"]["weekdays"]
    ]
    if len(matches) > 1:
        raise ReducerValidationError("overlapping_occurrences")
    return matches[0] if matches else None


def _find_override(root: dict[str, Any], requested: str) -> dict[str, Any] | None:
    return next(
        (entry for entry in root["family"]["overrides"] if entry["original_date"] == requested),
        None,
    )


def _find_detached(root: dict[str, Any], task_id: str) -> dict[str, Any] | None:
    return next(
        (entry for entry in root["family"]["detached"] if entry["task_id"] == task_id),
        None,
    )


def _active_order_override(root: dict[str, Any], requested: str, segment_id: str) -> dict[str, Any] | None:
    return next(
        (
            entry
            for entry in root["family"]["order_overrides"]
            if entry["original_date"] == requested and entry["source_segment_id"] == segment_id
        ),
        None,
    )


def _task_from_template(template: dict[str, Any], requested: str) -> dict[str, Any]:
    return {
        "title": template["title"],
        "date": requested,
        "period": template["period"],
        "duration_minutes": template["duration_minutes"],
        "plan_id": template["plan_id"],
        "standalone_color_id": template["standalone_color_id"],
        "status": "pending",
        "order_key": template["order_key"],
    }


def _task_template(data: dict[str, Any]) -> dict[str, Any]:
    return {
        key: data[key]
        for key in (
            "title",
            "period",
            "duration_minutes",
            "plan_id",
            "standalone_color_id",
            "order_key",
        )
    }


def _occurrence_id(root_id: str, requested: str) -> str:
    return _uuid5(root_id, f"occurrence:{requested}")


def _override_id(root_id: str, requested: str) -> str:
    return _uuid5(root_id, f"override:{requested}")


def _detached_id(root_id: str, requested: str) -> str:
    return _uuid5(root_id, f"detached:{requested}")


def _make_segment(
    root_id: str,
    operation: dict[str, Any],
    command_index: int,
    from_date: str,
    rule: dict[str, Any],
    template: dict[str, Any],
) -> dict[str, Any]:
    segment_id = _uuid5(root_id, f"segment:{operation['operation_id']}:{command_index}")
    return {
        "segment_id": segment_id,
        "from_date": from_date,
        "until_date": None,
        "rule": copy.deepcopy(rule),
        "template": copy.deepcopy(template),
    }


def _put_override(root: dict[str, Any], override: dict[str, Any]) -> None:
    entries = root["family"]["overrides"]
    existing = next(
        (index for index, item in enumerate(entries) if item["original_date"] == override["original_date"]),
        None,
    )
    if existing is None:
        entries.append(override)
    else:
        entries[existing] = override


def _remove_order_override(root: dict[str, Any], requested: str) -> None:
    root["family"]["order_overrides"] = [
        entry for entry in root["family"]["order_overrides"] if entry["original_date"] != requested
    ]


def _source_origin(root: dict[str, Any], source_id: str, cutoff: str) -> dict[str, Any]:
    origin = next(
        (entry for entry in root["segment_origins"] if entry["segment_id"] == source_id),
        None,
    )
    if origin is None or cutoff < origin["born_from_date"]:
        raise _NoOp("target_retired")
    return origin


def _occurrence_data(root: dict[str, Any], segment: dict[str, Any], requested: str) -> dict[str, Any] | None:
    override = _find_override(root, requested)
    if override:
        if override["kind"] != "replacement" or override["replacement"] is None:
            return None
        return copy.deepcopy(override["replacement"])
    data = _task_from_template(segment["template"], requested)
    rank = _active_order_override(root, requested, segment["segment_id"])
    if rank:
        data["order_key"] = rank["order_key"]
    return data


def semantic_root_hash(root: dict[str, str], value: dict[str, Any] | None) -> str:
    content = canonicalize({"root": root, "state": _semantic_state(root, value)}).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def _bucket_cards(state: dict[str, Any], requested_date: str, period: str) -> list[dict[str, str]]:
    cards = []
    for key, value in state["roots"].items():
        kind, root_id = key.split(":", 1)
        if kind != "work_item" or value["deleted"]:
            continue
        if value["kind"] == "single":
            data = value["single"]
            if data["date"] == requested_date and data["period"] == period:
                cards.append(
                    {
                        "root_id": root_id,
                        "card_id": root_id,
                        "date": requested_date,
                        "period": period,
                        "order_key": data["order_key"],
                    }
                )
            continue
        for child in value["family"]["detached"]:
            data = child["data"]
            if not child["deleted"] and data["date"] == requested_date and data["period"] == period:
                cards.append(
                    {
                        "root_id": root_id,
                        "card_id": child["task_id"],
                        "date": requested_date,
                        "period": period,
                        "order_key": data["order_key"],
                    }
                )
        for override in value["family"]["overrides"]:
            data = override["replacement"]
            if (
                override["kind"] == "replacement"
                and data
                and data["date"] == requested_date
                and data["period"] == period
            ):
                cards.append(
                    {
                        "root_id": root_id,
                        "card_id": _occurrence_id(root_id, override["original_date"]),
                        "date": requested_date,
                        "period": period,
                        "order_key": data["order_key"],
                    }
                )
        segment = _matching_segment(value, requested_date)
        if segment is None or _find_override(value, requested_date):
            continue
        data = _task_from_template(segment["template"], requested_date)
        rank = _active_order_override(value, requested_date, segment["segment_id"])
        if rank:
            data["order_key"] = rank["order_key"]
        if data["period"] == period:
            cards.append(
                {
                    "root_id": root_id,
                    "card_id": _occurrence_id(root_id, requested_date),
                    "date": requested_date,
                    "period": period,
                    "order_key": data["order_key"],
                }
            )
    cards.sort(key=lambda item: (int(item["order_key"]), UUID(item["card_id"]).bytes))
    return cards


def bucket_order_hash(state: dict[str, Any], requested_date: str, period: str) -> str:
    content = canonicalize(
        {
            "date": requested_date,
            "period": period,
            "cards": _bucket_cards(state, requested_date, period),
        }
    ).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def _set_order_bucket(state: dict[str, Any], command: dict[str, Any]) -> tuple[str, str] | None:
    root = command.get("root")
    if not isinstance(root, dict):
        return None
    value = _root(state, root)
    if value is None or value.get("deleted"):
        return None
    target = command.get("payload", {}).get("target") if isinstance(command.get("payload"), dict) else None
    if not isinstance(target, dict) or value.get("kind") not in (
        "single",
        "recurrence_family",
    ):
        return None
    if value["kind"] == "single":
        data = value["single"]
        return (data["date"], data["period"]) if target.get("kind") == "single" else None
    if target.get("kind") == "detached" and isinstance(target.get("task_id"), str):
        child = _find_detached(value, target["task_id"])
        return (child["data"]["date"], child["data"]["period"]) if child and not child["deleted"] else None
    if target.get("kind") == "occurrence" and isinstance(target.get("original_date"), str):
        requested = target["original_date"]
        override = _find_override(value, requested)
        if override and override["kind"] == "detached":
            child = _find_detached(value, override["detached_task_id"])
            return (child["data"]["date"], child["data"]["period"]) if child and not child["deleted"] else None
        if override and override["kind"] == "deleted":
            return None
        segment = _matching_segment(value, requested)
        if not segment or (
            isinstance(target.get("source_segment_id"), str) and segment["segment_id"] != target["source_segment_id"]
        ):
            return None
        data = (
            override["replacement"]
            if override and override["kind"] == "replacement"
            else _task_from_template(segment["template"], requested)
        )
        return (data["date"], data["period"]) if data else None
    return None


def _preconditions_match(state: dict[str, Any], operation: dict[str, Any]) -> list[tuple[str, str, str]]:
    root_conditions: list[tuple[dict[str, str], str]] = []
    bucket_conditions: list[tuple[str, str, str]] = []
    for command in operation["commands"]:
        condition = command["precondition"]
        if condition is None:
            continue
        if (
            not isinstance(condition, dict)
            or set(condition) - {"expected_root_hash", "expected_bucket"}
            or not condition
        ):
            raise ReducerValidationError("precondition_shape")
        if "expected_root_hash" in condition:
            expected = condition["expected_root_hash"]
            if not isinstance(expected, str) or not HASH.fullmatch(expected):
                raise ReducerValidationError("expected_root_hash")
            root_conditions.append((command["root"], expected))
        if "expected_bucket" in condition:
            bucket = _exact(
                condition["expected_bucket"],
                {"date", "period", "order_hash"},
                "expected_bucket",
            )
            _date(bucket["date"], "expected_bucket")
            if (
                not isinstance(bucket["period"], str)
                or bucket["period"] not in PERIODS
                or not isinstance(bucket["order_hash"], str)
                or not HASH.fullmatch(bucket["order_hash"])
            ):
                raise ReducerValidationError("expected_bucket")
            bucket_conditions.append((bucket["date"], bucket["period"], bucket["order_hash"]))
        if command["action"] == "set_order" and (
            not isinstance(condition, dict) or "expected_root_hash" not in condition
        ):
            raise ReducerValidationError("set_order_precondition_required")

    for root, expected in root_conditions:
        if semantic_root_hash(root, _root(state, root)) != expected:
            raise _NoOp("precondition_failed")
    seen = set()
    for requested_date, period, expected in bucket_conditions:
        key = (requested_date, period)
        if key in seen:
            continue
        seen.add(key)
        if bucket_order_hash(state, requested_date, period) != expected:
            raise _NoOp("precondition_failed")
    bucket_keys = {(requested_date, period) for requested_date, period, _ in bucket_conditions}
    for command in operation["commands"]:
        if command["action"] != "set_order":
            continue
        target_bucket = _set_order_bucket(state, command)
        if target_bucket is not None and target_bucket not in bucket_keys:
            raise ReducerValidationError("set_order_bucket_precondition_required")
        if target_bucket is None and not bucket_conditions:
            raise ReducerValidationError("set_order_bucket_precondition_required")
    return bucket_conditions


def _apply_occurrence_edit(
    state: dict[str, Any],
    root_ref: dict[str, str],
    root: dict[str, Any],
    action: str,
    source_id: str,
    requested: str,
    data: dict[str, Any] | None,
) -> None:
    if root["deleted"]:
        raise _NoOp("target_retired")
    existing = _find_override(root, requested)
    if existing and existing["kind"] == "detached":
        child = _find_detached(root, existing["detached_task_id"])
        if child is None:
            raise ReducerValidationError("detached_mapping_missing_child")
        if action == "occurrence.delete":
            child["deleted"] = True
        else:
            assert data is not None
            _plan_exists(state, data["plan_id"])
            child["data"] = copy.deepcopy(data)
            child["deleted"] = False
        return
    segment = _matching_segment(root, requested)
    if segment is None or segment["segment_id"] != source_id:
        raise _NoOp("target_retired")
    _put_override(
        root,
        {
            "override_id": _override_id(root_ref["id"], requested),
            "original_date": requested,
            "source_segment_id": source_id,
            "kind": "deleted" if action == "occurrence.delete" else "replacement",
            "replacement": None if data is None else copy.deepcopy(data),
            "detached_task_id": None,
        },
    )
    _remove_order_override(root, requested)


def _apply_series_edit(
    root_id: str,
    root: dict[str, Any],
    operation: dict[str, Any],
    command_index: int,
    cutoff: str,
    source_id: str,
    rule: dict[str, Any] | None,
    template: dict[str, Any] | None,
    edit_future: bool,
) -> None:
    if root["deleted"]:
        raise _NoOp("target_retired")
    _source_origin(root, source_id, cutoff)
    prior_root = copy.deepcopy(root)
    kept_segments: list[dict[str, Any]] = []
    for segment in root["family"]["segments"]:
        if segment["until_date"] is not None and segment["until_date"] <= cutoff:
            kept_segments.append(copy.deepcopy(segment))
        elif segment["from_date"] < cutoff:
            kept_segments.append({**copy.deepcopy(segment), "until_date": cutoff})

    next_overrides: list[dict[str, Any]] = []
    next_children = copy.deepcopy(root["family"]["detached"])
    for override in root["family"]["overrides"]:
        if override["original_date"] < cutoff:
            next_overrides.append(copy.deepcopy(override))
        elif not edit_future:
            if override["kind"] == "replacement":
                next_overrides.append(
                    {
                        **override,
                        "kind": "deleted",
                        "replacement": None,
                        "detached_task_id": None,
                    }
                )
            else:
                next_overrides.append(copy.deepcopy(override))
        elif override["kind"] == "replacement":
            child_id = _detached_id(root_id, override["original_date"])
            child = {
                "task_id": child_id,
                "source_occurrence_id": _occurrence_id(root_id, override["original_date"]),
                "original_date": override["original_date"],
                "data": copy.deepcopy(override["replacement"]),
                "deleted": False,
            }
            child_index = next(
                (index for index, existing in enumerate(next_children) if existing["task_id"] == child_id),
                None,
            )
            if child_index is None:
                next_children.append(child)
            else:
                next_children[child_index] = child
            next_overrides.append(
                {
                    **override,
                    "kind": "detached",
                    "replacement": None,
                    "detached_task_id": child_id,
                }
            )
        else:
            next_overrides.append(copy.deepcopy(override))

    next_ranks: list[dict[str, Any]] = []
    for rank in root["family"]["order_overrides"]:
        if rank["original_date"] < cutoff:
            next_ranks.append(copy.deepcopy(rank))
            continue
        if not edit_future or rule is None or template is None:
            continue
        prior_segment = _matching_segment(prior_root, rank["original_date"])
        if prior_segment is None or _iso_weekday(rank["original_date"]) not in rule["weekdays"]:
            continue
        if (
            prior_segment["template"]["period"] != template["period"]
            or prior_segment["template"]["order_key"] != template["order_key"]
        ):
            continue
        successor = _make_segment(root_id, operation, command_index, cutoff, rule, template)
        next_ranks.append({**copy.deepcopy(rank), "source_segment_id": successor["segment_id"]})

    root["family"]["segments"] = kept_segments
    root["family"]["overrides"] = next_overrides
    root["family"]["order_overrides"] = next_ranks
    root["family"]["detached"] = next_children
    if edit_future:
        assert rule is not None and template is not None
        segment = _make_segment(root_id, operation, command_index, cutoff, rule, template)
        root["family"]["segments"].append(segment)
        root["segment_origins"].append(
            {
                "segment_id": segment["segment_id"],
                "born_from_date": cutoff,
                "created_by_operation_id": operation["operation_id"],
                "command_index": command_index,
            }
        )
        for rank in root["family"]["order_overrides"]:
            if (
                rank["original_date"] >= cutoff
                and rank["source_segment_id"] != segment["segment_id"]
                and _iso_weekday(rank["original_date"]) in rule["weekdays"]
            ):
                rank["source_segment_id"] = segment["segment_id"]


def _apply_command(
    state: dict[str, Any],
    owner_id: str,
    operation: dict[str, Any],
    command: dict[str, Any],
    command_index: int,
) -> None:
    root = _exact(command["root"], {"kind", "id"}, "root")
    if root["kind"] not in ("plan", "milestone", "work_item"):
        raise ReducerValidationError("root_kind")
    _uuid(root["id"], "root_id")
    action = command["action"]
    payload = command["payload"]
    current = _root(state, root)

    if action in ("plan.create", "plan.replace"):
        if root["kind"] != "plan":
            raise ReducerValidationError("plan_root_kind")
        data = _plan_data(_exact(payload, {"data"}, action)["data"], action)
        if action == "plan.create" and current is not None:
            raise _NoOp("duplicate_target")
        if action == "plan.replace" and current is None:
            raise _NoOp("reference_unavailable")
        if action == "plan.replace" and current is not None and "kind" in current:
            raise ReducerValidationError("plan_id_conflicts_with_work_item")
        _put(
            state,
            root,
            {"owner_id": owner_id, "deleted": False, "data": copy.deepcopy(data)},
        )
        return

    if action.startswith("milestone."):
        if root["kind"] != "milestone":
            raise ReducerValidationError("milestone_root_kind")
        if action in ("milestone.create", "milestone.replace"):
            data = _milestone_data(_exact(payload, {"data"}, action)["data"], action)
            if action == "milestone.create" and current is not None:
                raise _NoOp("duplicate_target")
            if action == "milestone.replace" and current is None:
                raise _NoOp("reference_unavailable")
            if action == "milestone.replace" and current is not None and "kind" in current:
                raise ReducerValidationError("milestone_id_conflicts_with_work_item")
            _plan_exists(state, data["plan_id"])
            _put(
                state,
                root,
                {"owner_id": owner_id, "deleted": False, "data": copy.deepcopy(data)},
            )
            return
        if action == "milestone.delete":
            _exact(payload, set(), action)
            if current is None:
                raise _NoOp("reference_unavailable")
            if current["deleted"]:
                raise _NoOp("target_retired")
            _put(state, root, {**current, "deleted": True})
            return
        raise ReducerValidationError("unsupported_milestone_action")

    if action.startswith(("work_item.", "single.", "occurrence.", "detached.", "series.")) or action == "set_order":
        if root["kind"] != "work_item":
            raise ReducerValidationError("work_item_root_kind")
        if action == "work_item.create_single":
            data = _task_data(_exact(payload, {"data"}, action)["data"], action)
            if current is not None:
                raise _NoOp("duplicate_target")
            _plan_exists(state, data["plan_id"])
            _put(
                state,
                root,
                {
                    "owner_id": owner_id,
                    "deleted": False,
                    "kind": "single",
                    "single": copy.deepcopy(data),
                    "segment_origins": [],
                    "family": None,
                },
            )
            return
        if action == "single.replace":
            data = _task_data(_exact(payload, {"data"}, action)["data"], action)
            if current is None:
                raise _NoOp("reference_unavailable")
            if current["kind"] != "single":
                raise _NoOp("target_retired")
            _plan_exists(state, data["plan_id"])
            _put(
                state,
                root,
                {**current, "deleted": False, "single": copy.deepcopy(data)},
            )
            return
        if action == "single.delete":
            _exact(payload, set(), action)
            if current is None:
                raise _NoOp("reference_unavailable")
            if current["kind"] != "single" or current["deleted"]:
                raise _NoOp("target_retired")
            _put(state, root, {**current, "deleted": True})
            return
        if action == "work_item.create_recurrence":
            payload = _exact(payload, {"start_date", "rule", "template"}, action)
            start_date = _date(payload["start_date"], "recurrence_start")
            rule = _recurrence_rule(payload["rule"], "recurrence_rule")
            template = _task_template_data(payload["template"], "recurrence_template")
            if current is not None:
                raise _NoOp("duplicate_target")
            _plan_exists(state, template["plan_id"])
            segment = _make_segment(root["id"], operation, command_index, start_date, rule, template)
            _put(
                state,
                root,
                {
                    "owner_id": owner_id,
                    "deleted": False,
                    "kind": "recurrence_family",
                    "single": None,
                    "segment_origins": [
                        {
                            "segment_id": segment["segment_id"],
                            "born_from_date": start_date,
                            "created_by_operation_id": operation["operation_id"],
                            "command_index": command_index,
                        }
                    ],
                    "family": {
                        "segments": [segment],
                        "overrides": [],
                        "order_overrides": [],
                        "detached": [],
                    },
                },
            )
            return
        if action == "work_item.enable_recurrence":
            payload = _exact(payload, {"data", "rule"}, action)
            data = _task_data(payload["data"], "enable_recurrence_data")
            rule = _recurrence_rule(payload["rule"], "enable_recurrence_rule")
            if current is None:
                raise _NoOp("reference_unavailable")
            if current.get("kind") != "single" or current["deleted"]:
                raise _NoOp("target_retired")
            if _iso_weekday(data["date"]) not in rule["weekdays"]:
                raise ReducerValidationError("enable_recurrence_date_weekday")
            _plan_exists(state, data["plan_id"])
            segment = _make_segment(
                root["id"],
                operation,
                command_index,
                data["date"],
                rule,
                _task_template(data),
            )
            family_root = {
                "owner_id": owner_id,
                "deleted": False,
                "kind": "recurrence_family",
                "single": None,
                "segment_origins": [
                    {
                        "segment_id": segment["segment_id"],
                        "born_from_date": data["date"],
                        "created_by_operation_id": operation["operation_id"],
                        "command_index": command_index,
                    }
                ],
                "family": {
                    "segments": [segment],
                    "overrides": [
                        {
                            "override_id": _override_id(root["id"], data["date"]),
                            "original_date": data["date"],
                            "source_segment_id": segment["segment_id"],
                            "kind": "replacement",
                            "replacement": copy.deepcopy(data),
                            "detached_task_id": None,
                        }
                    ],
                    "order_overrides": [],
                    "detached": [],
                },
            }
            family_root["segment_origins"] = copy.deepcopy(current["segment_origins"]) + family_root["segment_origins"]
            _put(state, root, family_root)
            return
        if action in ("occurrence.replace", "occurrence.delete"):
            fields = (
                {"source_segment_id", "original_date", "data"}
                if action == "occurrence.replace"
                else {"source_segment_id", "original_date"}
            )
            payload = _exact(payload, fields, action)
            source_id = _uuid(payload["source_segment_id"], "occurrence_source")
            requested = _date(payload["original_date"], "occurrence_date")
            occurrence_data = _task_data(payload["data"], "occurrence_data") if action == "occurrence.replace" else None
            if occurrence_data:
                _plan_exists(state, occurrence_data["plan_id"])
            if current is None:
                raise _NoOp("reference_unavailable")
            if current.get("kind") != "recurrence_family":
                raise _NoOp("target_retired")
            _apply_occurrence_edit(state, root, current, action, source_id, requested, occurrence_data)
            return
        if action in ("detached.replace", "detached.delete"):
            payload = _exact(
                payload,
                {"task_id", "data"} if action == "detached.replace" else {"task_id"},
                action,
            )
            task_id = _uuid(payload["task_id"], "detached_task_id")
            detached_data = _task_data(payload["data"], "detached_data") if action == "detached.replace" else None
            if detached_data:
                _plan_exists(state, detached_data["plan_id"])
            if current is None or current.get("kind") != "recurrence_family" or current["deleted"]:
                raise _NoOp("target_retired" if current is not None else "reference_unavailable")
            child = _find_detached(current, task_id)
            if child is None:
                raise _NoOp("target_retired")
            if action == "detached.delete":
                child["deleted"] = True
            else:
                child["data"] = copy.deepcopy(detached_data)
                child["deleted"] = False
            return
        if action in ("series.edit_future", "series.stop_future"):
            fields = (
                {"source_segment_id", "cutoff_original_date", "rule", "template"}
                if action == "series.edit_future"
                else {"source_segment_id", "cutoff_original_date"}
            )
            payload = _exact(payload, fields, action)
            source_id = _uuid(payload["source_segment_id"], "series_source")
            cutoff = _date(payload["cutoff_original_date"], "series_cutoff")
            series_rule: dict[str, Any] | None = None
            series_template: dict[str, Any] | None = None
            if action == "series.edit_future":
                series_rule = _recurrence_rule(payload["rule"], "series_rule")
                series_template = _task_template_data(payload["template"], "series_template")
                _plan_exists(state, series_template["plan_id"])
            if current is None:
                raise _NoOp("reference_unavailable")
            if current.get("kind") != "recurrence_family" or current["deleted"]:
                raise _NoOp("target_retired")
            _apply_series_edit(
                root["id"],
                current,
                operation,
                command_index,
                cutoff,
                source_id,
                series_rule,
                series_template,
                action == "series.edit_future",
            )
            return
        if action == "set_order":
            payload = _exact(payload, {"target", "order_key", "intent"}, action)
            _order_key(payload["order_key"], "set_order")
            if payload["intent"] not in ("user_reorder", "rank_maintenance"):
                raise ReducerValidationError("set_order_intent")
            target = payload["target"]
            if not isinstance(target, dict):
                raise ReducerValidationError("set_order_target")
            if current is None:
                raise _NoOp("reference_unavailable")
            if current.get("deleted") or current.get("kind") not in (
                "single",
                "recurrence_family",
            ):
                raise _NoOp("target_retired")
            if current["kind"] == "single":
                target = _exact(target, {"kind"}, "set_order_target")
                if target["kind"] != "single":
                    raise ReducerValidationError("set_order_target_kind")
                current["single"]["order_key"] = payload["order_key"]
                return
            if target.get("kind") == "detached":
                target = _exact(target, {"kind", "task_id"}, "set_order_target")
                task_id = _uuid(target["task_id"], "set_order_task_id")
                child = _find_detached(current, task_id)
                if child is None or child["deleted"]:
                    raise _NoOp("target_retired")
                child["data"]["order_key"] = payload["order_key"]
                return
            if target.get("kind") != "occurrence":
                raise ReducerValidationError("set_order_target_kind")
            target = _exact(
                target,
                {"kind", "source_segment_id", "original_date"},
                "set_order_target",
            )
            source_id = _uuid(target["source_segment_id"], "set_order_source")
            requested = _date(target["original_date"], "set_order_date")
            override = _find_override(current, requested)
            if override and override["kind"] == "detached":
                child = _find_detached(current, override["detached_task_id"])
                if child is None or child["deleted"]:
                    raise _NoOp("target_retired")
                child["data"]["order_key"] = payload["order_key"]
                return
            current_segment = _matching_segment(current, requested)
            if (
                current_segment is None
                or current_segment["segment_id"] != source_id
                or (override and override["kind"] == "deleted")
            ):
                raise _NoOp("target_retired")
            if override and override["kind"] == "replacement":
                override["replacement"]["order_key"] = payload["order_key"]
                return
            if payload["intent"] == "rank_maintenance":
                rank = _active_order_override(current, requested, current_segment["segment_id"])
                if rank:
                    rank["order_key"] = payload["order_key"]
                else:
                    current["family"]["order_overrides"].append(
                        {
                            "original_date": requested,
                            "source_segment_id": current_segment["segment_id"],
                            "order_key": payload["order_key"],
                        }
                    )
            else:
                data = _task_from_template(current_segment["template"], requested)
                rank = _active_order_override(current, requested, current_segment["segment_id"])
                if rank:
                    data["order_key"] = rank["order_key"]
                data["order_key"] = payload["order_key"]
                _put_override(
                    current,
                    {
                        "override_id": _override_id(root["id"], requested),
                        "original_date": requested,
                        "source_segment_id": current_segment["segment_id"],
                        "kind": "replacement",
                        "replacement": data,
                        "detached_task_id": None,
                    },
                )
                _remove_order_override(current, requested)
            return

    raise ReducerValidationError("action_not_supported_by_server_reducer")


def _validate_projection(state: dict[str, Any]) -> None:
    _uuid(state["owner_id"], "projection_owner_id")
    roots = state.get("roots")
    if not isinstance(roots, dict):
        raise ReducerValidationError("projection_roots")
    for key, value in roots.items():
        kind, separator, root_id = key.partition(":")
        if not separator or kind not in ("plan", "milestone", "work_item"):
            raise ReducerValidationError("projection_root_key")
        _uuid(root_id, "projection_root_id")
        if (
            not isinstance(value, dict)
            or value.get("owner_id") != state["owner_id"]
            or type(value.get("deleted")) is not bool
        ):
            raise ReducerValidationError("projection_root_metadata")
        if kind == "plan":
            _exact(value, {"owner_id", "deleted", "data"}, "plan_root")
            _plan_data(value["data"], "plan_data")
            continue
        if kind == "milestone":
            _exact(value, {"owner_id", "deleted", "data"}, "milestone_root")
            data = _milestone_data(value["data"], "milestone_data")
            if not value["deleted"]:
                _plan_exists(state, data["plan_id"])
            continue
        if value.get("kind") == "single":
            _exact(
                value,
                {"owner_id", "deleted", "kind", "single", "segment_origins", "family"},
                "single_work_item",
            )
            if value["family"] is not None or not isinstance(value["segment_origins"], list):
                raise ReducerValidationError("single_work_item_shape")
            data = _task_data(value["single"], "single_data")
            if not value["deleted"]:
                _plan_exists(state, data["plan_id"])
            for origin in value["segment_origins"]:
                origin = _exact(
                    origin,
                    {
                        "segment_id",
                        "born_from_date",
                        "created_by_operation_id",
                        "command_index",
                    },
                    "segment_origin",
                )
                segment_id = _uuid(origin["segment_id"], "origin_segment_id")
                _date(origin["born_from_date"], "origin_born_from_date")
                operation_id = _uuid(origin["created_by_operation_id"], "origin_operation_id")
                command_index = origin["command_index"]
                if (
                    type(command_index) is not int
                    or command_index < 0
                    or segment_id != _uuid5(root_id, f"segment:{operation_id}:{command_index}")
                ):
                    raise ReducerValidationError("single_segment_origin")
            continue
        if value.get("kind") != "recurrence_family":
            raise ReducerValidationError("work_item_kind")
        _validate_family_integrity(root_id, value)
        if not value["deleted"]:
            for segment in value["family"]["segments"]:
                _plan_exists(state, segment["template"]["plan_id"])
            for override in value["family"]["overrides"]:
                if override["kind"] == "replacement":
                    _plan_exists(state, override["replacement"]["plan_id"])
            for child in value["family"]["detached"]:
                if not child["deleted"]:
                    _plan_exists(state, child["data"]["plan_id"])


def _verify_rank_maintenance(
    before: dict[str, Any],
    after: dict[str, Any],
    operation: dict[str, Any],
    buckets: list[tuple[str, str, str]],
) -> None:
    commands = [command for command in operation["commands"] if command["action"] == "set_order"]
    if not commands:
        return
    has_user_reorder = any(command["payload"]["intent"] == "user_reorder" for command in commands)
    user_targets: set[str] = set()
    for command in commands:
        if command["payload"]["intent"] != "user_reorder":
            continue
        target = command["payload"]["target"]
        if not isinstance(target, dict):
            continue
        root = command["root"]
        if target.get("kind") == "single":
            user_targets.add(root["id"])
        elif target.get("kind") == "detached" and isinstance(target.get("task_id"), str):
            user_targets.add(target["task_id"])
        elif target.get("kind") == "occurrence" and isinstance(target.get("original_date"), str):
            value = _root(before, root)
            override = (
                _find_override(value, target["original_date"])
                if value and value.get("kind") == "recurrence_family"
                else None
            )
            user_targets.add(
                override["detached_task_id"]
                if override and override["kind"] == "detached"
                else _occurrence_id(root["id"], target["original_date"])
            )
    for requested, period, _ in buckets:
        previous = [card["card_id"] for card in _bucket_cards(before, requested, period)]
        following = [card["card_id"] for card in _bucket_cards(after, requested, period)]
        if not has_user_reorder:
            if previous != following:
                raise _NoOp("precondition_failed")
            continue
        prior_untouched = [card_id for card_id in previous if card_id not in user_targets]
        next_untouched = [card_id for card_id in following if card_id not in user_targets]
        if prior_untouched != next_untouched:
            raise _NoOp("precondition_failed")


def _merge_origins(current: dict[str, Any], restored: dict[str, Any]) -> dict[str, Any]:
    by_id: dict[str, dict[str, Any]] = {}
    for origin in [*current["segment_origins"], *restored["segment_origins"]]:
        existing = by_id.get(origin["segment_id"])
        if existing is not None and canonicalize(existing) != canonicalize(origin):
            raise _NoOp("undo_not_applicable")
        by_id[origin["segment_id"]] = copy.deepcopy(origin)
    restored["segment_origins"] = sorted(by_id.values(), key=lambda entry: UUID(entry["segment_id"]).bytes)
    return restored


def _has_live_plan_reference(state: dict[str, Any], plan_id: str) -> bool:
    for value in state["roots"].values():
        if value["deleted"]:
            continue
        if value.get("kind") is None:
            if value["data"]["plan_id"] == plan_id:
                return True
            continue
        if value["kind"] == "single":
            if value["single"]["plan_id"] == plan_id:
                return True
            continue
        if any(segment["template"]["plan_id"] == plan_id for segment in value["family"]["segments"]):
            return True
        if any(
            override["kind"] == "replacement" and override["replacement"]["plan_id"] == plan_id
            for override in value["family"]["overrides"]
        ):
            return True
        if any(not child["deleted"] and child["data"]["plan_id"] == plan_id for child in value["family"]["detached"]):
            return True
    return False


def _apply_undo(
    state: dict[str, Any],
    operation: dict[str, Any],
    command: dict[str, Any],
    history: dict[str, dict[str, Any]],
    latest_by_root: dict[str, str],
) -> None:
    if len(operation["commands"]) != 1 or command["action"] != "undo":
        raise ReducerValidationError("undo_requires_single_command")
    payload = _exact(command["payload"], {"original_operation_id", "expected_states"}, "undo_payload")
    original_id = _uuid(payload["original_operation_id"], "undo_original_operation_id")
    if not isinstance(payload["expected_states"], list):
        raise ReducerValidationError("undo_expected_states")
    if original_id not in operation["dependencies"]:
        raise ReducerValidationError("undo_missing_dependency")
    original = history.get(original_id)
    if not original or original["effect"] != "applied" or not original["roots"]:
        raise _NoOp("undo_not_applicable")
    if not any(
        root["kind"] == command["root"]["kind"] and root["id"] == command["root"]["id"] for root in original["roots"]
    ):
        raise _NoOp("undo_not_applicable")
    expected: dict[str, str] = {}
    for entry in payload["expected_states"]:
        if not isinstance(entry, dict):
            raise ReducerValidationError("undo_expected_state")
        entry = _exact(entry, {"root", "hash"}, "undo_expected_state")
        root = _exact(entry["root"], {"kind", "id"}, "undo_expected_root")
        if root["kind"] not in ("plan", "milestone", "work_item"):
            raise ReducerValidationError("undo_expected_root_kind")
        _uuid(root["id"], "undo_expected_root_id")
        if not isinstance(entry["hash"], str) or not HASH.fullmatch(entry["hash"]):
            raise ReducerValidationError("undo_expected_hash")
        key = _root_key(root)
        if key in expected:
            raise ReducerValidationError("undo_duplicate_expected_root")
        expected[key] = entry["hash"]
    if len(expected) != len(original["roots"]) or any(_root_key(root) not in expected for root in original["roots"]):
        raise _NoOp("undo_not_applicable")
    for root in original["roots"]:
        key = _root_key(root)
        if latest_by_root.get(key) != original_id or semantic_root_hash(root, _root(state, root)) != expected[key]:
            raise _NoOp("undo_not_applicable")

    inverse = copy.deepcopy(state)
    for root in original["roots"]:
        key = _root_key(root)
        previous = original["before"].get(key)
        current = _root(state, root)
        if previous is None:
            if current is None:
                raise _NoOp("undo_not_applicable")
            inverse["roots"][key] = {**copy.deepcopy(current), "deleted": True}
        elif (
            isinstance(previous, dict)
            and current is not None
            and previous.get("kind") in ("single", "recurrence_family")
            and current.get("kind") in ("single", "recurrence_family")
        ):
            inverse["roots"][key] = _merge_origins(copy.deepcopy(current), copy.deepcopy(previous))
        else:
            inverse["roots"][key] = copy.deepcopy(previous)
    if any(root["kind"] == "plan" and _has_live_plan_reference(inverse, root["id"]) for root in original["roots"]):
        raise _NoOp("undo_not_applicable")
    try:
        _validate_projection(inverse)
    except ReducerValidationError, _NoOp:
        raise _NoOp("undo_not_applicable") from None
    state["roots"] = inverse["roots"]


def _operation_key(operation: dict[str, Any]) -> tuple[int, int, int, bytes, bytes]:
    deleting = any(
        command["action"].endswith(".delete") or command["action"] == "series.stop_future"
        for command in operation["commands"]
    )
    return (
        operation["edit_time"]["physical_ms"],
        operation["edit_time"]["logical"],
        int(deleting),
        UUID(operation["device_id"]).bytes,
        UUID(operation["operation_id"]).bytes,
    )


def replay(operations: list[dict[str, Any]], owner_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if any(operation["owner_id"] != owner_id for operation in operations):
        raise ReducerValidationError("owner_mismatch")
    by_id = {operation["operation_id"]: operation for operation in operations}
    if len(by_id) != len(operations):
        raise ReducerValidationError("duplicate_operation_id")
    for operation in operations:
        if any(dependency not in by_id for dependency in operation["dependencies"]):
            raise ReducerValidationError("missing_dependency")
        if any(
            _operation_key(by_id[dependency]) >= _operation_key(operation) for dependency in operation["dependencies"]
        ):
            raise ReducerValidationError("dependency_order")

    state: dict[str, Any] = {"owner_id": owner_id, "roots": {}}
    outcomes = []
    history: dict[str, dict[str, Any]] = {}
    latest_by_root: dict[str, str] = {}
    for operation in sorted(operations, key=_operation_key):
        before = copy.deepcopy(state)
        working = copy.deepcopy(state)
        effect = "applied"
        reason = None
        try:
            buckets = _preconditions_match(state, operation)
            if any(command["action"] == "undo" for command in operation["commands"]):
                _apply_undo(
                    working,
                    operation,
                    operation["commands"][0],
                    history,
                    latest_by_root,
                )
            else:
                for index, command in enumerate(operation["commands"]):
                    _apply_command(working, owner_id, operation, command, index)
                _validate_projection(working)
                _verify_rank_maintenance(state, working, operation, buckets)
        except _NoOp as error:
            effect, reason, working = "no_op", error.reason, before
        changed_keys = (
            sorted(
                (
                    key
                    for key in set(before["roots"]) | set(working["roots"])
                    if canonicalize(before["roots"].get(key)) != canonicalize(working["roots"].get(key))
                ),
                key=lambda key: (
                    key.split(":", 1)[0],
                    UUID(key.split(":", 1)[1]).bytes,
                ),
            )
            if effect == "applied"
            else []
        )
        changed = [{"kind": key.split(":", 1)[0], "id": key.split(":", 1)[1]} for key in changed_keys]
        state = working
        outcomes.append(
            {
                "operation_id": operation["operation_id"],
                "effect": effect,
                "reason": reason,
                "changed_roots": changed,
            }
        )
        history[operation["operation_id"]] = {
            "effect": effect,
            "roots": changed,
            "before": {key: copy.deepcopy(before["roots"].get(key)) for key in changed_keys},
        }
        for key in changed_keys:
            latest_by_root[key] = operation["operation_id"]
    return state, outcomes


def effect_at_commit(
    existing: list[dict[str, Any]], candidate: dict[str, Any], owner_id: str
) -> tuple[str, str | None]:
    before_state, _ = replay(existing, owner_id)
    after_state, outcomes = replay([*existing, candidate], owner_id)
    outcome = next(result for result in outcomes if result["operation_id"] == candidate["operation_id"])
    if outcome["effect"] == "no_op":
        return "no_op", outcome["reason"]
    if canonicalize(before_state) == canonicalize(after_state):
        return "superseded", None
    return "applied", None
