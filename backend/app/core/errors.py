"""Safe Problem responses; validation diagnostics never copy request values."""

from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError, ResponseValidationError
from pydantic import BaseModel, TypeAdapter
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

from app.core.values import format_utc_timestamp
from app.schemas.problem import FieldError, Problem


# Only server-defined codes and static text can reach responses or request logs.
_TEXT = {
    "validation_failed": ("Validation failed", "One or more fields are invalid."),
    "malformed_request": ("Malformed request", "The request is malformed."),
    "not_found": ("Not found", "The requested resource was not found."),
    "method_not_allowed": ("Method not allowed", "The request method is not allowed."),
    "internal_error": ("Internal error", "An unexpected error occurred."),
    "service_unavailable": ("Service unavailable", "The service is temporarily unavailable."),
    "rate_limited": ("Rate limited", "Too many requests. Try again later."),
    "payload_too_large": ("Payload too large", "The request body exceeds the allowed size."),
    "unsupported_media_type": ("Unsupported media type", "The request media type is unsupported."),
    "authentication_required": ("Authentication required", "Authentication is required."),
    "forbidden": ("Forbidden", "The request is not permitted."),
}

_STATUS_CODES = {
    400: "malformed_request", 401: "authentication_required", 403: "forbidden",
    404: "not_found", 405: "method_not_allowed", 413: "payload_too_large",
    415: "unsupported_media_type", 422: "validation_failed", 429: "rate_limited",
    503: "service_unavailable",
}

_VALIDATION_CODES = {
    "missing": "required", "extra_forbidden": "unknown_field",
    "string_too_long": "too_long", "too_long": "too_long",
    "string_too_short": "too_short", "too_short": "too_short",
    "int_type": "invalid_type", "int_parsing": "invalid_type",
    "string_type": "invalid_type", "bool_type": "invalid_type",
    "list_type": "invalid_type", "model_type": "invalid_type",
}


class ProblemHTTPException(HTTPException):
    def __init__(self, *, status_code: int, code: str,
                 field_errors: list[FieldError] | None = None,
                 retry_after_seconds: int | None = None):
        super().__init__(status_code=status_code)
        self.code = code
        self.field_errors = field_errors
        self.retry_after_seconds = retry_after_seconds


def make_problem(request: Request, *, status_code: int, code: str,
                 field_errors: list[FieldError] | None = None,
                 retry_after_seconds: int | None = None) -> JSONResponse:
    if code not in _TEXT:
        status_code, code = 500, "internal_error"
    title, detail = _TEXT[code]
    now = datetime.now(timezone.utc)
    now = now.replace(microsecond=(now.microsecond // 1000) * 1000)
    retry_after = retry_after_seconds if status_code == 429 else None
    problem = Problem(
        type=f"/api/v1/problems/{code}", title=title, status=status_code, detail=detail,
        instance=f"/api/v1/requests/{request.state.request_id}", code=code,
        request_id=request.state.request_id, retryable=status_code in (429, 503),
        server_time=format_utc_timestamp(now), field_errors=field_errors,
        retry_after_seconds=retry_after,
    )
    request.state.error_code = code
    headers = {"Cache-Control": "no-store"}
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return JSONResponse(problem.model_dump(exclude_none=True), status_code=status_code,
                        media_type="application/problem+json", headers=headers)


def _parameter_schema(dependant, location: str) -> dict:
    properties = {}
    definitions = {}
    for field in getattr(dependant, f"{location}_params", []):
        annotation = field.field_info.annotation
        schema = TypeAdapter(annotation).json_schema()
        definitions.update(schema.pop("$defs", {}))
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            # FastAPI validates Query models against the flat parameter mapping.
            properties.update(schema.get("properties", {}))
        else:
            properties[field.validation_alias or field.alias] = schema
    for child in dependant.dependencies:
        schema = _parameter_schema(child, location)
        properties.update(schema["properties"])
        definitions.update(schema["$defs"])
    return {"type": "object", "properties": properties, "$defs": definitions}


def _dereference(schema: dict, root: dict) -> dict:
    reference = schema.get("$ref", "")
    if reference.startswith("#/$defs/"):
        return root.get("$defs", {}).get(reference.removeprefix("#/$defs/"), {})
    return schema


def _union_branches_for_label(schema: dict, label: str, root: dict) -> list[dict]:
    schema = _dereference(schema, root)
    matches = []
    discriminator_reference = schema.get("discriminator", {}).get("mapping", {}).get(label)
    for candidate in schema.get("anyOf", schema.get("oneOf", [])):
        branch = _dereference(candidate, root)
        reference = candidate.get("$ref")
        names = {branch.get("title")}
        if reference:
            names.add(reference.rsplit("/", 1)[-1])
        if label in names or (discriminator_reference and reference == discriminator_reference):
            matches.append(branch)
    return matches


def _resolve(schema: dict, root: dict) -> list[dict]:
    if "$ref" in schema:
        reference = schema["$ref"]
        if reference.startswith("#/$defs/"):
            return _resolve(root.get("$defs", {}).get(reference.removeprefix("#/$defs/"), {}), root)
        return []
    if "anyOf" in schema or "oneOf" in schema:
        return [branch for candidate in schema.get("anyOf", schema.get("oneOf", []))
                for branch in _resolve(candidate, root)]
    return [schema]


def _validation_pointer(request: Request, location: tuple) -> str:
    if not location:
        return ""
    source, *parts = location
    route = request.scope.get("route")
    prefix = []
    if source == "body" and getattr(route, "body_field", None) is not None:
        root = TypeAdapter(route.body_field.field_info.annotation).json_schema()
    elif source in ("query", "path") and getattr(route, "dependant", None) is not None:
        root = _parameter_schema(route.dependant, source)
        prefix = [source]
    else:
        return ""
    candidates = [root]
    for part in parts:
        if isinstance(part, str):
            branches = [branch for schema in candidates
                        for branch in _union_branches_for_label(schema, part, root)]
            if branches:
                # Skip only schema-confirmed diagnostics, then stay in that branch.
                candidates = branches
                continue
        next_candidates = []
        for schema in candidates:
            for branch in _resolve(schema, root):
                if isinstance(part, str) and part in branch.get("properties", {}):
                    next_candidates.append(branch["properties"][part])
                elif type(part) is int and part >= 0 and branch.get("type") == "array":
                    next_candidates.append(branch.get("items", {}))
        if not next_candidates:
            break  # Unknown keys and union diagnostics never become wire paths.
        prefix.append(str(part))
        candidates = next_candidates
    return "".join("/" + part.replace("~", "~0").replace("/", "~1") for part in prefix)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def validation(request: Request, exception: RequestValidationError):
        errors = [FieldError(path=_validation_pointer(request, tuple(error.get("loc", ()))),
                             code=_VALIDATION_CODES.get(error.get("type"), "invalid_value"))
                  for error in exception.errors()]
        return make_problem(request, status_code=422, code="validation_failed", field_errors=errors)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exception: StarletteHTTPException):
        if isinstance(exception, ProblemHTTPException):
            return make_problem(request, status_code=exception.status_code, code=exception.code,
                                field_errors=exception.field_errors,
                                retry_after_seconds=exception.retry_after_seconds)
        code = _STATUS_CODES.get(exception.status_code, "internal_error")
        retry_after = None
        if exception.status_code == 429:
            delay = next((value for name, value in (exception.headers or {}).items()
                          if name.lower() == "retry-after"), None)
            if isinstance(delay, str) and delay.isascii() and delay.isdecimal():
                try:
                    retry_after = int(delay)
                except ValueError:
                    pass  # Reject oversized integer strings without reflecting the header.
        response = make_problem(request, status_code=exception.status_code, code=code,
                                retry_after_seconds=retry_after)
        for name, value in (exception.headers or {}).items():
            if name.lower() in ("allow", "www-authenticate"):
                response.headers[name] = value
        return response

    @app.exception_handler(ResponseValidationError)
    async def invalid_response(request: Request, _exception: ResponseValidationError):
        return make_problem(request, status_code=500, code="internal_error")
