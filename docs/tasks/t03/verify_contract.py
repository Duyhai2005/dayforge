"""Validate documentation contracts; this is not a product test runner.

Run from the repository root:
    python docs/tasks/t03/verify_contract.py

Requires the development tool jsonschema (Draft 2020-12 support).
No network, application server, account, or email service is used.
"""

import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from jsonschema import Draft202012Validator, FormatChecker

CONTRACT_DIR = Path(__file__).resolve().parent


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON property: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)


def main() -> None:
    schema = load_json(CONTRACT_DIR / "contract.schema.json")
    examples = load_json(CONTRACT_DIR / "contract-examples.json")
    Draft202012Validator.check_schema(schema)
    fixtures = examples["fixtures"]
    covered_actions = set()
    for fixture in fixtures:
        definition = fixture["definition"]
        if definition not in schema["$defs"]:
            raise AssertionError(f"Unknown definition: {definition}")
        selected = {
            "$schema": schema["$schema"],
            "$defs": schema["$defs"],
            "$ref": f"#/$defs/{definition}",
        }
        validator = Draft202012Validator(selected, format_checker=FormatChecker())
        actual = validator.is_valid(fixture["value"])
        if actual != fixture["valid"]:
            errors = [error.message for error in validator.iter_errors(fixture["value"])]
            raise AssertionError(f"{fixture['name']}: expected {fixture['valid']}, got {actual}: {errors}")
        if actual and definition == "Command":
            covered_actions.add(fixture["value"]["action"])

    action_names = {item["properties"]["action"]["const"] for item in schema["$defs"]["Command"]["oneOf"]}
    if action_names != covered_actions:
        raise AssertionError(f"Actions without a valid fixture: {action_names - covered_actions}")

    vector = examples["id_vector"]
    names = {
        "occurrence_id": f"occurrence:{vector['original_date']}",
        "override_id": f"override:{vector['original_date']}",
        "detached_task_id": f"detached:{vector['original_date']}",
        "segment_id": f"segment:{vector['operation_id']}:{vector['command_index']}",
    }
    for key, name in names.items():
        derived = str(uuid.uuid5(uuid.UUID(vector["root_id"]), name))
        if derived != vector["expected"][key]:
            raise AssertionError(f"UUIDv5 vector differs: {key}")
    hash_vector = examples["hash_vector"]
    canonical = hash_vector["canonical_json"]
    if load_json_value(canonical) != hash_vector["value"]:
        raise AssertionError("Canonical hash vector has different semantic content")
    if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != hash_vector["sha256"]:
        raise AssertionError("SHA-256 vector differs")

    links_checked = 0
    markdown_files = sorted(CONTRACT_DIR.glob("*.md"))
    for path in markdown_files:
        source = path.read_text(encoding="utf-8")
        if re.search(r"^(<<<<<<<|=======|>>>>>>>)", source, re.MULTILINE):
            raise AssertionError(f"Conflict marker in {path.name}")
        for target in re.findall(r"\]\(([^)]+)\)", source):
            if re.match(r"[a-z][a-z0-9+.-]*:", target, re.IGNORECASE):
                continue
            relative_path = unquote(target.split("#", 1)[0])
            if not relative_path:
                continue
            if not (path.parent / relative_path).resolve().exists():
                raise AssertionError(f"Missing local link in {path.name}: {target}")
            links_checked += 1

    passed = sum(item["valid"] for item in fixtures)
    rejected = len(fixtures) - passed
    print(
        f"PASS: schema; {len(fixtures)} fixtures "
        f"({passed} accepted, {rejected} rejected as expected); "
        f"{len(action_names)} actions covered; {links_checked} local links."
    )
    print("Documentation checks only; product behavior and acceptance tests have not run.")


def load_json_value(source: str) -> dict[str, Any]:
    return json.loads(source, object_pairs_hook=unique_object)


if __name__ == "__main__":
    main()
