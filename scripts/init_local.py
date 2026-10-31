from __future__ import annotations

import secrets
import sys
from pathlib import Path

TEMPLATE_OUTPUTS = (
    (Path(".env.example"), Path(".env")),
    (Path("backend/.env.example"), Path("backend/.env")),
    (Path("frontend/.env.example"), Path("frontend/.env.local")),
)


def initialize_local(repo_root: Path) -> tuple[Path, Path, Path]:
    root = Path(repo_root)
    outputs = tuple(root / output for _, output in TEMPLATE_OUTPUTS)
    existing = tuple(path.exists() for path in outputs)

    if all(existing):
        return outputs

    if any(existing):
        missing = [
            output.as_posix()
            for (_, output), exists in zip(TEMPLATE_OUTPUTS, existing, strict=True)
            if not exists
        ]
        raise FileExistsError(
            "Refusing to replace partial local configuration; missing files: "
            + ", ".join(missing)
        )

    templates = tuple(
        (root / template).read_text(encoding="utf-8")
        for template, _ in TEMPLATE_OUTPUTS
    )
    app_password = secrets.token_urlsafe(32)
    root_password = secrets.token_urlsafe(32)
    replacements = (
        {
            "__GENERATE_MYSQL_PASSWORD__": app_password,
            "__GENERATE_MYSQL_ROOT_PASSWORD__": root_password,
        },
        {"__GENERATE_MYSQL_PASSWORD__": app_password},
        {},
    )

    rendered: list[str] = []
    for template, mapping in zip(templates, replacements, strict=True):
        output = template
        for placeholder, value in mapping.items():
            if output.count(placeholder) != 1:
                raise ValueError(
                    f"Expected exactly one {placeholder} marker in its template."
                )
            output = output.replace(placeholder, value)
        if "__GENERATE_" in output:
            raise ValueError("A template contains an unsupported generation marker.")
        rendered.append(output.replace("\r\n", "\n").replace("\r", "\n"))

    created: list[Path] = []
    try:
        for path, contents in zip(outputs, rendered, strict=True):
            with path.open("x", encoding="utf-8", newline="\n") as local_file:
                local_file.write(contents)
            created.append(path)
    except OSError as exc:
        missing = [
            output.relative_to(root).as_posix()
            for output in outputs
            if not output.exists()
        ]
        raise OSError(
            f"Could not finish local configuration ({exc.__class__.__name__}); "
            f"created {len(created)} file(s); still missing: {', '.join(missing)}"
        ) from None

    return outputs


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    outputs = tuple(repo_root / output for _, output in TEMPLATE_OUTPUTS)
    existed_before = tuple(path.exists() for path in outputs)

    try:
        result = initialize_local(repo_root)
    except (FileExistsError, FileNotFoundError, OSError, ValueError) as exc:
        print(f"Local environment setup failed: {exc}", file=sys.stderr)
        return 1

    status = "kept existing files" if all(existed_before) else "created files"
    print(f"Local environment setup {status}:")
    for path in result:
        print(f"- {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
