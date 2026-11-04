from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts.backup_policy import (
    BackupPolicyError,
    load_backup_policy,
    read_restic_environment,
    validate_restic_files,
)


class BackupPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repository_file = self.root / "repository"
        self.password_file = self.root / "password"
        self.credentials_file = self.root / "credentials"
        self.workspace_root = self.root / "backup-work"
        self.policy_file = self.root / "policy.json"
        self.repository_file.write_text(
            "s3:https://storage.example.test/dayforge\n", encoding="utf-8"
        )
        self.password_file.write_text("restic-secret-sentinel\n", encoding="utf-8")
        self.credentials_file.write_text(
            "AWS_ACCESS_KEY_ID=key-sentinel\nAWS_SECRET_ACCESS_KEY=secret-sentinel\n",
            encoding="utf-8",
        )
        self.write_policy()
        if os.name != "nt":
            for path in (
                self.repository_file,
                self.password_file,
                self.credentials_file,
            ):
                path.chmod(0o600)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def policy_data(self) -> dict[str, object]:
        return {
            "repository_file": str(self.repository_file),
            "password_file": str(self.password_file),
            "credentials_file": str(self.credentials_file),
            "workspace_root": str(self.workspace_root),
            "keep_daily": 7,
            "keep_weekly": 4,
            "keep_monthly": 3,
            "max_success_age_hours": 26,
        }

    def write_policy(self, overrides: dict[str, object] | None = None) -> None:
        data = self.policy_data()
        if overrides:
            data.update(overrides)
        self.policy_file.write_text(json.dumps(data), encoding="utf-8")

    def test_loads_strict_secret_free_policy(self) -> None:
        policy = load_backup_policy(self.policy_file)
        self.assertEqual(policy.keep_daily, 7)
        self.assertEqual(policy.keep_weekly, 4)
        self.assertEqual(policy.keep_monthly, 3)
        self.assertEqual(policy.max_success_age_hours, 26)

    def test_rejects_unknown_or_missing_fields_without_echoing_values(self) -> None:
        self.write_policy({"unexpected": "secret-sentinel"})
        with self.assertRaises(BackupPolicyError) as caught:
            load_backup_policy(self.policy_file)
        self.assertNotIn("secret-sentinel", str(caught.exception))
        self.write_policy()
        data = self.policy_data()
        del data["password_file"]
        self.policy_file.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(BackupPolicyError, "policy_fields"):
            load_backup_policy(self.policy_file)

    def test_rejects_relative_paths_and_invalid_retention(self) -> None:
        self.write_policy({"workspace_root": "relative/path"})
        with self.assertRaisesRegex(BackupPolicyError, "workspace_root"):
            load_backup_policy(self.policy_file)
        self.write_policy({"keep_daily": True})
        with self.assertRaisesRegex(BackupPolicyError, "keep_daily"):
            load_backup_policy(self.policy_file)

    def test_restic_environment_is_allow_listed_and_secrets_are_not_echoed(
        self,
    ) -> None:
        policy = load_backup_policy(self.policy_file)
        environment = read_restic_environment(policy)
        self.assertEqual(environment["AWS_ACCESS_KEY_ID"], "key-sentinel")
        self.assertEqual(environment["AWS_SECRET_ACCESS_KEY"], "secret-sentinel")
        self.credentials_file.write_text(
            "AWS_SECRET_ACCESS_KEY=secret-sentinel\nPATH=C:\\bad\n", encoding="utf-8"
        )
        with self.assertRaises(BackupPolicyError) as caught:
            read_restic_environment(policy)
        self.assertNotIn("secret-sentinel", str(caught.exception))

    def test_restic_environment_rejects_duplicate_or_empty_entries(self) -> None:
        policy = load_backup_policy(self.policy_file)
        self.credentials_file.write_text(
            "AWS_REGION=region\nAWS_REGION=other\n", encoding="utf-8"
        )
        with self.assertRaisesRegex(BackupPolicyError, "credentials_file"):
            read_restic_environment(policy)
        self.credentials_file.write_text("AWS_REGION=\n", encoding="utf-8")
        with self.assertRaisesRegex(BackupPolicyError, "credentials_file"):
            read_restic_environment(policy)

    def test_validates_private_restic_paths_without_disclosing_contents(self) -> None:
        policy = load_backup_policy(self.policy_file)
        self.assertEqual(
            validate_restic_files(policy), "s3:https://storage.example.test/dayforge"
        )
        self.password_file.unlink()
        if os.name == "nt":
            try:
                self.password_file.symlink_to(self.repository_file)
            except OSError:
                self.skipTest("symlink creation requires Windows developer mode")
        else:
            self.password_file.symlink_to(self.repository_file)
        with self.assertRaises(BackupPolicyError) as caught:
            validate_restic_files(policy)
        self.assertNotIn("storage.example.test", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
