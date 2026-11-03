"""Run two real browser clients against an isolated MySQL-backed API."""

from __future__ import annotations

import asyncio
import ipaddress
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509 import (
    DNSName,
    IPAddress,
    Name,
    NameAttribute,
    SubjectAlternativeName,
)
from cryptography.x509.oid import NameOID
from sqlalchemy import select

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
PASSWORD = "A sufficiently long password for Dayforge"
sys.path.insert(0, str(BACKEND))


class BrowserRunnerError(RuntimeError):
    pass


@contextmanager
def _temporary_directory(prefix: str):
    temporary = Path(tempfile.mkdtemp(prefix=prefix))
    expected_parent = Path(tempfile.gettempdir()).resolve()
    if temporary.resolve().parent != expected_parent or not temporary.name.startswith(
        prefix
    ):
        raise BrowserRunnerError(
            "The browser test temporary directory is outside its expected location"
        )
    try:
        yield temporary
    finally:
        deadline = time.monotonic() + 5
        while True:
            try:
                shutil.rmtree(temporary)
                break
            except PermissionError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)


def _check_migrations(environ: dict[str, str]) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND,
        env=environ,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise BrowserRunnerError(
            "Alembic failed to prepare the isolated browser-test database"
        )


async def _verification_payloads(database, settings) -> list[dict[str, str]]:
    from app.models.auth import EmailDeliveryJob
    from app.services.email_delivery import decrypt_delivery_payload

    async with database.sessions() as session:
        jobs = (
            await session.scalars(
                select(EmailDeliveryJob).order_by(EmailDeliveryJob.created_at)
            )
        ).all()
        key = settings.secret_key("auth_email_outbox_key_b64")
        return [
            decrypt_delivery_payload(
                job.id, bytes(job.payload_ciphertext), key, job.outbox_key_version
            )
            for job in jobs
        ]


def _verify_test_owner(settings) -> None:
    from app.core.database import create_database
    from app.services.auth import AuthService

    async def prepare_owner() -> None:
        database = create_database(settings)
        try:
            service = AuthService(database, settings)
            await service.request_email(
                settings.owner_email,
                "verify_email",
                "127.0.0.1",
                audit_action="register",
                request_id=str(uuid4()),
            )
            payloads = await _verification_payloads(database, settings)
            verification = next(
                (
                    payload
                    for payload in payloads
                    if payload.get("recipient") == settings.owner_email
                    and payload.get("kind") == "verify_email"
                    and isinstance(payload.get("token"), str)
                ),
                None,
            )
            if verification is None:
                raise BrowserRunnerError(
                    "The isolated verification message was not queued"
                )
            token = verification["token"]
            await service.confirm_email(
                token,
                PASSWORD,
                "127.0.0.1",
                request_id=str(uuid4()),
            )
        finally:
            await database.engine.dispose()

    try:
        asyncio.run(prepare_owner())
    except BrowserRunnerError:
        raise
    except Exception as error:  # noqa: BLE001
        # Database exception text may contain connection credentials.
        raise BrowserRunnerError(
            f"Could not prepare the isolated browser-test owner ({type(error).__name__})"
        ) from None


def _restore_test_sync_epoch(settings, owner_id: str) -> str:
    from sqlalchemy import delete, select

    from app.core.database import create_database
    from app.models.sync import (
        ChangeLog,
        OperationReceipt,
        OwnerSyncState,
        RecordedOperation,
    )

    try:
        parsed_owner = UUID(owner_id)
    except ValueError as error:
        raise BrowserRunnerError(
            "Browser runner requested an invalid test owner"
        ) from error
    database = create_database(settings)
    epoch = uuid4()

    async def reset():
        try:
            async with database.sessions() as session, session.begin():
                state = await session.scalar(
                    select(OwnerSyncState)
                    .where(OwnerSyncState.owner_id == parsed_owner)
                    .with_for_update()
                )
                if state is None:
                    raise BrowserRunnerError("Test owner sync state is missing")
                await session.execute(
                    delete(ChangeLog).where(ChangeLog.owner_id == parsed_owner)
                )
                await session.execute(
                    delete(OperationReceipt).where(
                        OperationReceipt.owner_id == parsed_owner
                    )
                )
                removed = await session.execute(
                    delete(RecordedOperation).where(
                        RecordedOperation.owner_id == parsed_owner
                    )
                )
                state.epoch = epoch
                state.head_cursor = 0
                return removed.rowcount or 0
        finally:
            await database.engine.dispose()

    try:
        removed_count = asyncio.run(reset())
    except BrowserRunnerError:
        raise
    except Exception as error:
        raise BrowserRunnerError(
            "Could not restore the isolated test owner's sync epoch"
        ) from error
    print(
        f"Simulated isolated server restore: removed {removed_count} events and advanced the test owner epoch.",
        flush=True,
    )
    return str(epoch)


def _write_test_certificate(directory: Path) -> tuple[Path, Path]:
    key = ec.generate_private_key(ec.SECP256R1())
    subject = issuer = Name([NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before((now - timedelta(minutes=5)).replace(tzinfo=None))
        .not_valid_after((now + timedelta(days=1)).replace(tzinfo=None))
        .add_extension(
            SubjectAlternativeName(
                [DNSName("localhost"), IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    key_path = directory / "sync-browser-test-key.pem"
    certificate_path = directory / "sync-browser-test-cert.pem"
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    certificate_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return certificate_path, key_path


def _wait_for_api(process: subprocess.Popen) -> None:
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise BrowserRunnerError("Test API exited before becoming ready")
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:8000/api/v1/version", timeout=1
            ) as response:
                if response.status == 200:
                    return
        except OSError, urllib.error.URLError:
            time.sleep(0.2)
    raise BrowserRunnerError("Test API did not become ready")


def main() -> int:
    environ = os.environ.copy()
    try:
        browser_port = int(environ["DAYFORGE_SYNC_BROWSER_PORT"])
        if not 1024 <= browser_port <= 65535:
            raise ValueError
    except KeyError, ValueError:
        print("The isolated browser runner has no valid HTTPS port.", file=sys.stderr)
        return 2

    # CSRF validation must trust the exact origin used by the ephemeral browser.
    environ["PUBLIC_ORIGIN"] = f"https://127.0.0.1:{browser_port}"

    # The app rewrites API calls to its fixed local API origin. Never reuse an
    # unknown listener on that address because it could point at a developer DB.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", 8000))
        except OSError:
            print(
                "Port 8000 is occupied; refusing to attach the browser test to an unknown API.",
                file=sys.stderr,
            )
            return 2

    try:
        from app.core.config import load_settings

        _check_migrations(environ)
        settings = load_settings(environ)
        _verify_test_owner(settings)
    # Database/configuration exceptions can embed credentials; keep diagnostics redacted.
    except Exception as error:  # noqa: BLE001
        if isinstance(error, BrowserRunnerError):
            print(str(error), file=sys.stderr)
        else:
            print(
                "Could not prepare the verified test owner for browser sync.",
                file=sys.stderr,
            )
        return 1

    node = shutil.which("node")
    if not node:
        print("Node.js is required to run the browser sync suite.", file=sys.stderr)
        return 2

    exit_code = 1
    with _temporary_directory(prefix="dayforge-sync-browser-") as temporary_path:
        certificate_path, key_path = _write_test_certificate(temporary_path)
        api_log_path = temporary_path / "api.log"
        api_log = api_log_path.open("w", encoding="utf-8")
        try:
            api = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "app.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "8000",
                    "--no-access-log",
                ],
                cwd=BACKEND,
                env=environ,
                stdout=api_log,
                stderr=subprocess.STDOUT,
            )
            try:
                _wait_for_api(api)
                browser_environ = environ.copy()
                browser_environ.update(
                    DAYFORGE_SYNC_TLS_CERT=str(certificate_path),
                    DAYFORGE_SYNC_TLS_KEY=str(key_path),
                    DAYFORGE_SYNC_BROWSER_PORT=str(browser_port),
                    DAYFORGE_SYNC_BROWSER_EPOCH_CONTROL="1",
                )
                browser = subprocess.Popen(
                    [node, str(ROOT / "scripts" / "test_sync_browser.cjs")],
                    cwd=ROOT,
                    env=browser_environ,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    bufsize=1,
                )
                try:
                    assert browser.stdin is not None and browser.stdout is not None
                    for line in browser.stdout:
                        if line.startswith("DAYFORGE_TEST_RESET_EPOCH "):
                            owner_id = line.removeprefix(
                                "DAYFORGE_TEST_RESET_EPOCH "
                            ).strip()
                            try:
                                epoch = _restore_test_sync_epoch(settings, owner_id)
                            except BrowserRunnerError as error:
                                print(str(error), file=sys.stderr, flush=True)
                                browser.stdin.write(
                                    "DAYFORGE_TEST_EPOCH_RESET_FAILED\n"
                                )
                            else:
                                browser.stdin.write(
                                    f"DAYFORGE_TEST_EPOCH_RESET_DONE {epoch}\n"
                                )
                            browser.stdin.flush()
                        else:
                            print(line, end="", flush=True)
                    exit_code = browser.wait()
                finally:
                    if browser.poll() is None:
                        browser.terminate()
                        try:
                            browser.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            browser.kill()
                            browser.wait(timeout=10)
            finally:
                api.terminate()
                try:
                    api.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    api.kill()
                    api.wait(timeout=10)
        except Exception:  # noqa: BLE001 - keep service failures free of DB credentials
            print(
                "The isolated browser sync runner could not start its test services.",
                file=sys.stderr,
            )
        finally:
            api_log.close()
        if exit_code:
            api_log_lines = api_log_path.read_text(encoding="utf-8").splitlines()
            diagnostics = [
                line
                for line in api_log_lines
                if '"diagnostic":"internal_exception"' in line
            ]
            if diagnostics:
                print(
                    "Isolated API exception diagnostics: " + diagnostics[-1],
                    file=sys.stderr,
                    flush=True,
                )
            exception_start = max(
                (
                    index
                    for index, line in enumerate(api_log_lines)
                    if "Exception in ASGI application" in line
                ),
                default=-1,
            )
            if exception_start >= 0:
                exception_lines = api_log_lines[exception_start:]
                frames = [
                    line.strip()
                    for line in exception_lines
                    if line.lstrip().startswith("File ")
                ]
                exception_type = next(
                    (
                        line.strip().split(":", 1)[0]
                        for line in reversed(exception_lines)
                        if line and not line[0].isspace() and ":" in line
                    ),
                    "UnknownError",
                )
                print(
                    "Isolated API failure frames: "
                    + " -> ".join(frames)
                    + f" ({exception_type})",
                    file=sys.stderr,
                    flush=True,
                )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
