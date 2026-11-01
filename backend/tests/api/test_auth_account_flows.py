def test_register_is_neutral_for_non_allowlisted_email(
    auth_client, auth_repository, auth_mailbox
):
    response = auth_client.post(
        "/api/v1/auth/register", json={"email": "other@example.test"}
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "resend_after_seconds": 60}
    assert auth_repository.users == []
    assert auth_mailbox.messages == []


def test_forgot_is_neutral_for_unknown_and_non_allowlisted_email(
    auth_client, auth_repository, auth_mailbox
):
    unknown = auth_client.post(
        "/api/v1/auth/password/forgot", json={"email": "missing@example.test"}
    )
    non_allowlisted = auth_client.post(
        "/api/v1/auth/password/forgot", json={"email": "other@example.test"}
    )

    assert unknown.status_code == non_allowlisted.status_code == 202
    assert (
        unknown.json()
        == non_allowlisted.json()
        == {
            "status": "accepted",
            "resend_after_seconds": 60,
        }
    )
    assert auth_repository.users == []
    assert auth_mailbox.messages == []


def test_auth_posts_reject_untrusted_origin_or_csrf(auth_client):
    auth_client.headers["X-CSRF-Token"] = "A" * 43

    response = auth_client.post(
        "/api/v1/auth/register", json={"email": "owner@example.test"}
    )

    assert response.status_code == 403
    assert response.json()["code"] == "csrf_failed"
    assert auth_client.auth_service.calls == []


def test_auth_requires_application_json(auth_client):
    response = auth_client.post(
        "/api/v1/auth/register",
        content=b'{"email":"other@example.test"}',
        headers={"Content-Type": "text/plain"},
    )

    assert response.status_code == 415
    assert auth_client.auth_service.calls == []


def test_auth_response_headers_are_no_store_even_on_rejection(auth_client):
    response = auth_client.post(
        "/api/v1/auth/register",
        json={"email": "other@example.test"},
        headers={"Origin": "null"},
    )

    assert response.status_code == 403
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


def test_login_requires_boolean_remember_me(auth_client):
    response = auth_client.post(
        "/api/v1/auth/login",
        json={
            "email": "owner@example.test",
            "password": "correct horse battery staple",
            "remember_me": "true",
        },
    )

    assert response.status_code == 422
    assert auth_client.auth_service.calls == []
