"""Docker and restic rehearsal of an encrypted snapshot into a clean project."""

from __future__ import annotations

import base64
import os
import secrets
import shutil
import subprocess
import tempfile
import unittest
from collections.abc import Mapping, Sequence
from pathlib import Path
from uuid import uuid4

from scripts.backup_database import (
    _KEY_FILES,
    _current_revision,
    create_backup,
    initialize_backup_repository,
)
from scripts.backup_policy import BackupPolicy
from scripts.deploy_config import DeployConfig
from scripts.deploy_release import DeploymentError, _compose_prefix, _execute
from scripts.release_manifest import ReleaseManifest
from scripts.restore_database import RestoreError, restore_database
from scripts.verify_restore import (
    _write_fingerprint,
    fingerprint_database,
    verify_restored_database,
)

ROOT = Path(__file__).resolve().parents[2]


class IsolatedDockerRunner:
    def __init__(
        self, compose_project: str, *, isolate_project: str | None = None
    ) -> None:
        self.compose_project = compose_project
        self.isolate_project = isolate_project or compose_project
        self.events: list[list[str]] = []
        self.last_result: subprocess.CompletedProcess[str] | None = None

    def _isolated(self, arguments: Sequence[str], environment: Mapping[str, str]):
        command = list(arguments)
        env = dict(environment)
        if command[:2] == ["docker", "compose"]:
            project_index = command.index("--project-name") + 1
            command[project_index] = self.isolate_project
            env["COMPOSE_PROJECT"] = self.isolate_project
        return command, env

    def __call__(self, arguments: Sequence[str], environment: Mapping[str, str]):
        command, env = self._isolated(arguments, environment)
        self.events.append(command)
        result = subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=60 * 60,
        )
        self.last_result = result
        return result

    def popen(self, arguments: Sequence[str], **kwargs):
        command, env = self._isolated(arguments, kwargs.pop("env", {}))
        return subprocess.Popen(command, cwd=ROOT, env=env, **kwargs)


class BackupRestoreIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.web_image = os.environ.get("DAYFORGE_PACKAGE_WEB_IMAGE", "")
        cls.api_image = os.environ.get("DAYFORGE_PACKAGE_API_IMAGE", "")
        cls.mysql_image = os.environ.get("DAYFORGE_PACKAGE_MYSQL_IMAGE", "")
        cls.build_id = os.environ.get("DAYFORGE_PACKAGE_BUILD_ID", "")
        if not all((cls.web_image, cls.api_image, cls.mysql_image, cls.build_id)):
            raise RuntimeError(
                "Backup/restore rehearsal requires package images and build ID"
            )

    def setUp(self) -> None:
        self.run_id = uuid4().hex
        self.root_temp = tempfile.TemporaryDirectory(prefix="dayforge-backup-restore-")
        self.root = Path(self.root_temp.name)
        self.source_project = f"dayforge-backup-test-{self.run_id}-source"
        self.target_id = uuid4().hex
        self.target_project = f"dayforge-restore-{self.target_id}"
        self.source_network = f"{self.source_project}-ingress"
        self.target_network = f"{self.target_project}-ingress"
        source_subnet_octet = secrets.randbelow(200) + 20
        target_subnet_octet = secrets.randbelow(200) + 20
        while target_subnet_octet == source_subnet_octet:
            target_subnet_octet = secrets.randbelow(200) + 20
        self.networks: list[str] = []
        self.source_root = self.root / "source"
        self.target_root = self.root / "target"
        self.source_state = self.source_root / "state"
        self.target_state = self.target_root / "state"
        self.source_secrets = self.source_root / "secrets"
        self.target_secrets = self.target_root / "secrets"
        for path in (
            self.source_state,
            self.target_state,
            self.source_secrets,
            self.target_secrets,
        ):
            path.mkdir(parents=True, mode=0o700)
            if os.name != "nt":
                path.chmod(0o700)
        self.source_config = DeployConfig(
            environment="staging",
            provider="aws",
            region="us-east-1",
            platform="linux/amd64",
            public_origin="https://staging.example.test",
            compose_project="dayforge-staging",
            db_name="dayforge_staging",
            secrets_dir=self.source_secrets,
            state_dir=self.source_state,
            edge_alias="staging-web",
            app_subnet=f"10.243.{source_subnet_octet}.0/24",
        )
        self.target_config = DeployConfig(
            environment="restore",
            provider="aws",
            region="us-east-1",
            platform="linux/amd64",
            public_origin="https://restore.example.test",
            compose_project=self.target_project,
            db_name=f"dayforge_restore_{self.target_id}",
            secrets_dir=self.target_secrets,
            state_dir=self.target_state,
            edge_alias=f"restore-{self.target_id}",
            app_subnet=f"10.244.{target_subnet_octet}.0/24",
        )
        self.owner_email = "owner@example.test"
        self._write_secrets(self.source_secrets, source=True)
        self._write_secrets(self.target_secrets, source=False)
        for name in _KEY_FILES:
            shutil.copyfile(self.source_secrets / name, self.target_secrets / name)
            if os.name != "nt":
                (self.target_secrets / name).chmod(0o600)
        self.source_runtime = self.source_root / "runtime.env"
        self.target_runtime = self.target_root / "runtime.env"
        self._write_runtime(self.source_runtime, self.source_config)
        self._write_runtime(self.target_runtime, self.target_config)
        self.repository = self.root / "restic-repository"
        self.repository.mkdir(mode=0o700)
        self.repository_file = self.root / "repository"
        self.repository_file.write_text(
            f"local:{self.repository.as_posix()}\n", encoding="utf-8"
        )
        self.password_file = self.root / "restic-password"
        self.password_file.write_text(
            secrets.token_urlsafe(48) + "\n", encoding="utf-8"
        )
        self.credentials_file = self.root / "restic-credentials.env"
        self.credentials_file.write_text("", encoding="utf-8")
        if os.name != "nt":
            for path in (
                self.repository_file,
                self.password_file,
                self.credentials_file,
            ):
                path.chmod(0o600)
        self.source_policy = BackupPolicy(
            repository_file=self.repository_file,
            password_file=self.password_file,
            credentials_file=self.credentials_file,
            workspace_root=self.source_state / "backup-work",
        )
        self.target_policy = BackupPolicy(
            repository_file=self.repository_file,
            password_file=self.password_file,
            credentials_file=self.credentials_file,
            workspace_root=self.target_state / "restore-work",
        )
        self.source_runner = IsolatedDockerRunner(
            self.source_config.compose_project,
            isolate_project=self.source_project,
        )
        self.target_runner = IsolatedDockerRunner(self.target_project)
        self.release = ReleaseManifest(
            release_id="t31-backup-restore-fixture",
            git_sha="1" * 40,
            build_id=self.build_id,
            platform="linux/amd64",
            web_image=self.web_image,
            api_image=self.api_image,
            mysql_image=self.mysql_image,
            required_db_revision="fixture",
            supported_db_revisions=("fixture",),
            indexeddb_schema_version=1,
            supported_indexeddb_schema_versions=(1,),
            protocol_versions=(1,),
            reducer_versions=(1,),
            created_at="2026-11-04T00:00:00Z",
        )

    def tearDown(self) -> None:
        try:
            self._compose_down(
                self.source_config,
                self.release,
                self.source_runtime,
                self.source_runner,
            )
            self._compose_down(
                self.target_config,
                self.release,
                self.target_runtime,
                self.target_runner,
            )
            for network in self.networks:
                subprocess.run(
                    ["docker", "network", "rm", network],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=30,
                )
        finally:
            self.root_temp.cleanup()

    def _write_secrets(self, directory: Path, *, source: bool) -> None:
        password_names = (
            "mysql_root_password",
            "db_password",
            "db_migrator_password",
            "email_smtp_password",
        )
        for name in password_names:
            value = secrets.token_urlsafe(32)
            (directory / name).write_text(value, encoding="utf-8")
        for name in _KEY_FILES:
            if not source:
                continue
            value = (
                ""
                if name == "logout_ticket_previous_keys_b64"
                else base64.urlsafe_b64encode(secrets.token_bytes(32))
                .decode("ascii")
                .rstrip("=")
            )
            (directory / name).write_text(value, encoding="utf-8")
        (directory / "email_smtp_username").write_text(
            "restore-test-user", encoding="utf-8"
        )
        if os.name != "nt":
            for path in directory.iterdir():
                path.chmod(0o600)

    def _write_runtime(self, path: Path, config: DeployConfig) -> None:
        values = {
            "COMPOSE_PROJECT": config.compose_project,
            "APP_ENV": "production",
            "PUBLIC_ORIGIN": config.public_origin,
            "DB_NAME": config.db_name,
            "OWNER_EMAIL": self.owner_email,
            "LOCAL_KEY_KEK_VERSION": "1",
            "EMAIL_SMTP_HOST": "smtp.example.test",
            "EMAIL_SMTP_PORT": "587",
            "EMAIL_FROM": "dayforge@example.test",
            "EMAIL_SMTP_TLS": "starttls",
            "EMAIL_SMTP_TIMEOUT_SECONDS": "10",
            "APP_SUBNET": config.app_subnet,
            "EDGE_ALIAS": config.edge_alias,
            "SECRETS_DIR": config.secrets_dir.as_posix(),
            "WEB_IMAGE": self.web_image,
            "API_IMAGE": self.api_image,
            "MYSQL_IMAGE": self.mysql_image,
        }
        path.write_text(
            "".join(f"{key}={value}\n" for key, value in values.items()),
            encoding="utf-8",
        )
        if os.name != "nt":
            path.chmod(0o600)

    def _compose(self, config, release, runtime, runner, *arguments):
        prefix, environment = _compose_prefix(
            config,
            release,
            runtime,
            ROOT / "deploy" / "compose.app.yaml",
        )
        try:
            return _execute(
                runner,
                prefix,
                environment,
                arguments,
                "backup_restore_compose_failed",
            )
        except DeploymentError as error:
            result = runner.last_result
            if result is None or not result.returncode:
                raise
            diagnostic = result.stderr.strip()
            for path in config.secrets_dir.iterdir():
                if path.is_file():
                    try:
                        secret = path.read_text(encoding="utf-8").strip()
                    except (OSError, UnicodeError):
                        continue
                    if secret:
                        diagnostic = diagnostic.replace(secret, "<redacted>")
            diagnostic = diagnostic.replace(str(config.secrets_dir), "<secrets-dir>")[
                :500
            ]
            if diagnostic:
                raise DeploymentError(f"{error}; compose_stderr={diagnostic}") from None
            raise

    def _create_network(self, name: str) -> None:
        result = subprocess.run(
            ["docker", "network", "create", name],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        if result.returncode:
            self.fail("Could not create isolated external test network")
        self.networks.append(name)

    def _compose_down(self, config, release, runtime, runner) -> None:
        try:
            self._compose(
                config,
                release,
                runtime,
                runner,
                "down",
                "--volumes",
                "--remove-orphans",
            )
        except (DeploymentError, OSError, subprocess.SubprocessError):
            pass

    def _start_source(self) -> ReleaseManifest:
        self._create_network(self.source_network)
        self._compose(
            self.source_config,
            self.release,
            self.source_runtime,
            self.source_runner,
            "up",
            "--detach",
            "--wait",
            "--wait-timeout",
            "180",
            "mysql",
        )
        self._compose(
            self.source_config,
            self.release,
            self.source_runtime,
            self.source_runner,
            "run",
            "--rm",
            "--no-deps",
            "provision-users",
        )
        self._compose(
            self.source_config,
            self.release,
            self.source_runtime,
            self.source_runner,
            "run",
            "--rm",
            "--no-deps",
            "migrate",
            "upgrade",
            "head",
        )
        prefix, environment = _compose_prefix(
            self.source_config,
            self.release,
            self.source_runtime,
            ROOT / "deploy" / "compose.app.yaml",
        )
        revision = _current_revision(
            self.source_runner,
            prefix,
            environment,
            allow_uninitialized=False,
        )
        if revision is None:
            self.fail("Disposable source database has no migration revision")
        return ReleaseManifest(
            **{
                **self.release.__dict__,
                "required_db_revision": revision,
                "supported_db_revisions": (revision,),
            }
        )

    def test_encrypted_snapshot_restores_to_a_clean_database(self) -> None:
        try:
            release = self._start_source()
            initialize_backup_repository(
                self.source_config,
                self.source_policy,
                runner=self.source_runner,
            )
            backup = create_backup(
                self.source_config,
                release,
                self.source_policy,
                env_file=self.source_runtime,
                compose_file=ROOT / "deploy" / "compose.app.yaml",
                runner=self.source_runner,
                popen_factory=self.source_runner.popen,
            )
            source_fingerprint_path = self.root / "source-fingerprint.json"
            source_fingerprint = fingerprint_database(
                self.source_config,
                release,
                env_file=self.source_runtime,
                compose_file=ROOT / "deploy" / "compose.app.yaml",
                runner=self.source_runner,
            )
            _write_fingerprint(source_fingerprint_path, source_fingerprint)

            self._create_network(self.target_network)
            restored = restore_database(
                self.target_config,
                release,
                self.target_policy,
                snapshot_id=backup.snapshot_id,
                source_environment="staging",
                env_file=self.target_runtime,
                compose_file=ROOT / "deploy" / "compose.app.yaml",
                runner=self.target_runner,
                popen_factory=self.target_runner.popen,
            )
            self.assertEqual(restored.snapshot_id, backup.snapshot_id)
            self.assertEqual(restored.restored_revision, release.required_db_revision)
            self.assertNotEqual(
                (self.source_secrets / "mysql_root_password").read_bytes(),
                (self.target_secrets / "mysql_root_password").read_bytes(),
            )
            for name in _KEY_FILES:
                self.assertEqual(
                    (self.source_secrets / name).read_bytes(),
                    (self.target_secrets / name).read_bytes(),
                )
            report = verify_restored_database(
                self.target_config,
                expected_fingerprint=source_fingerprint_path,
                release=release,
                env_file=self.target_runtime,
                compose_file=ROOT / "deploy" / "compose.app.yaml",
                runner=self.target_runner,
            )
            self.assertTrue(report.matches_expected)
            self.assertEqual(
                report.envelope_fingerprint_sha256,
                source_fingerprint["envelope_fingerprint_sha256"],
            )
            self.assertTrue((self.target_state / "restore-ready.json").is_file())

            before = sum("snapshots" in call for call in self.target_runner_calls())
            with self.assertRaisesRegex(RestoreError, "restore_database_not_empty"):
                restore_database(
                    self.target_config,
                    release,
                    self.target_policy,
                    snapshot_id=backup.snapshot_id,
                    source_environment="staging",
                    env_file=self.target_runtime,
                    compose_file=ROOT / "deploy" / "compose.app.yaml",
                    runner=self.target_runner,
                    popen_factory=self.target_runner.popen,
                )
            after = sum("snapshots" in call for call in self.target_runner_calls())
            self.assertEqual(after, before)
        finally:
            self._compose_down(
                self.source_config,
                self.release,
                self.source_runtime,
                self.source_runner,
            )
            self._compose_down(
                self.target_config,
                self.release,
                self.target_runtime,
                self.target_runner,
            )

    def target_runner_calls(self) -> list[list[str]]:
        return self.target_runner.events


if __name__ == "__main__":
    unittest.main()

