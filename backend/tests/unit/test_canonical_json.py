import pytest

from app.services.canonical_json import canonicalize


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ({"z": 1, "a": [True, None, "é"]}, '{"a":[true,null,"é"],"z":1}'),
        ({"😀": 1, "\ue000": 2}, '{"😀":1,"\ue000":2}'),
        (
            [1e-6, 1e-7, 1e20, 1e21, -0.0],
            "[0.000001,1e-7,100000000000000000000,1e+21,0]",
        ),
        (1.2345678901234568, "1.2345678901234567"),
    ],
)
def test_canonicalize_matches_jcs(value, expected):
    assert canonicalize(value) == expected


def test_canonicalize_rejects_surrogate_and_unsafe_integer():
    with pytest.raises(ValueError):
        canonicalize("\ud800")
    with pytest.raises(ValueError):
        canonicalize(9_007_199_254_740_992)
