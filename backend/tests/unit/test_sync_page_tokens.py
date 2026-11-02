from uuid import UUID

import pytest

from app.services.sync_tokens import PageTokenError, create_page_token, verify_page_token

KEY = bytes(range(32))
OWNER = UUID("11111111-1111-4111-8111-111111111111")
EPOCH = UUID("22222222-2222-4222-8222-222222222222")


def token_for(*, endpoint="pull", owner_id=OWNER, epoch=EPOCH, now=1_800_000_000):
    return create_page_token(
        KEY,
        endpoint=endpoint,
        owner_id=owner_id,
        epoch=epoch,
        after_cursor=4,
        through_cursor=12,
        position=7,
        now=now,
    )


def test_page_token_authenticates_owner_endpoint_epoch_watermark_and_position():
    token = token_for()

    payload = verify_page_token(
        KEY,
        token,
        endpoint="pull",
        owner_id=OWNER,
        now=1_800_000_100,
    )

    assert payload.owner_id == OWNER
    assert payload.epoch == EPOCH
    assert payload.endpoint == "pull"
    assert payload.after_cursor == 4
    assert payload.through_cursor == 12
    assert payload.position == 7
    assert payload.expires_at == 1_800_001_800
    assert payload.schema_version == 1


def test_page_token_rejects_tampering_and_wrong_owner_or_endpoint():
    token = token_for()
    changed = token[:-1] + ("A" if token[-1] != "A" else "B")

    with pytest.raises(PageTokenError) as tampered:
        verify_page_token(KEY, changed, endpoint="pull", owner_id=OWNER, now=1_800_000_100)
    assert tampered.value.code == "malformed_request"

    with pytest.raises(PageTokenError) as wrong_owner:
        verify_page_token(
            KEY,
            token,
            endpoint="pull",
            owner_id=UUID("33333333-3333-4333-8333-333333333333"),
            now=1_800_000_100,
        )
    assert wrong_owner.value.code == "malformed_request"

    with pytest.raises(PageTokenError) as wrong_endpoint:
        verify_page_token(KEY, token, endpoint="bootstrap", owner_id=OWNER, now=1_800_000_100)
    assert wrong_endpoint.value.code == "malformed_request"


def test_page_token_expires_after_fixed_thirty_minute_window():
    token = token_for(now=1_800_000_000)

    with pytest.raises(PageTokenError) as expired:
        verify_page_token(KEY, token, endpoint="pull", owner_id=OWNER, now=1_800_001_800)

    assert expired.value.code == "page_token_expired"


def test_page_token_rejects_position_outside_fixed_prefix():
    with pytest.raises(PageTokenError) as invalid:
        create_page_token(
            KEY,
            endpoint="pull",
            owner_id=OWNER,
            epoch=EPOCH,
            after_cursor=4,
            through_cursor=12,
            position=13,
            now=1_800_000_000,
        )

    assert invalid.value.code == "malformed_request"
