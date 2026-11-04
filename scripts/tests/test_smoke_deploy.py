import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.smoke_deploy import (  # noqa: E402
    HttpResponse,
    SmokeDeploymentError,
    smoke_deployment,
)


class SmokeDeployTests(unittest.TestCase):
    def setUp(self):
        self.responses = {
            "/work": HttpResponse(200, {"x-dayforge-build": "build-123"}, b"ok"),
            "/milestones": HttpResponse(200, {"x-dayforge-build": "build-123"}, b"ok"),
            "/sw.js": HttpResponse(200, {"x-dayforge-build": "build-123"}, b"ok"),
            "/dayforge-build.json": HttpResponse(
                200,
                {"x-dayforge-build": "build-123"},
                b'{"build_id":"build-123","protocol_version":1,"schema_version":2,"routes":["/work","/milestones"]}',
            ),
            "/api/v1/health": HttpResponse(200, {}, b'{"status":"ok"}'),
            "/api/v1/version": HttpResponse(
                200, {}, b'{"protocol_versions":[1],"reducer_versions":[1]}'
            ),
        }

    def request(self, url, timeout_seconds):
        self.assertLessEqual(timeout_seconds, 60)
        return self.responses[url.removeprefix("https://stage.example.test")]

    def test_checks_shell_manifest_and_api_contract(self):
        result = smoke_deployment(
            "https://stage.example.test", "build-123", request=self.request
        )
        self.assertEqual(len(result), 6)
        self.assertTrue(all(result.values()))

    def test_rejects_api_unhealthy_or_build_mismatch(self):
        self.responses["/api/v1/health"] = HttpResponse(503, {}, b"secret sentinel")
        with self.assertRaises(SmokeDeploymentError) as caught:
            smoke_deployment(
                "https://stage.example.test", "build-123", request=self.request
            )
        self.assertEqual(str(caught.exception), "smoke_checks_failed: /api/v1/health")
        self.responses["/api/v1/health"] = HttpResponse(200, {}, b'{"status":"ok"}')
        self.responses["/work"] = HttpResponse(200, {"x-dayforge-build": "old"}, b"ok")
        with self.assertRaises(SmokeDeploymentError):
            smoke_deployment(
                "https://stage.example.test", "build-123", request=self.request
            )

    def test_rejects_unsafe_arguments_without_network(self):
        for origin, build_id, timeout in (
            ("http://stage.example.test", "build-123", 60),
            ("https://stage.example.test/path", "build-123", 60),
            ("https://user:pw@stage.example.test", "build-123", 60),
            ("https://stage.example.test", "bad\nid", 60),
            ("https://stage.example.test", "build-123", 0),
        ):
            with self.subTest(origin=origin, build_id=build_id, timeout=timeout):
                with self.assertRaises(SmokeDeploymentError):
                    smoke_deployment(
                        origin, build_id, timeout_seconds=timeout, request=self.request
                    )


if __name__ == "__main__":
    unittest.main()
