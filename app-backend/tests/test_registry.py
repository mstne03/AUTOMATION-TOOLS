from app_backend import registry


def test_registry_covers_both_repos_with_risks():
    specs = registry.by_name(registry.build())
    assert "youtube_auth" not in specs  # abre el navegador: solo por /youtube/auth
    assert specs["youtube_delete_video"].risk == "destructive"
    assert specs["youtube_upload_video"].risk == "write"
    assert specs["youtube_upload_video"].quota == {"bucket": "video_insert", "cost": 1}
    assert specs["youtube_upload_video"].job_kind == "upload"
    assert specs["transcribe_local"].job_kind == "transcribe"
    assert specs["buscar_kb"].risk == "read"
    assert specs["youtube_search"].quota == {"bucket": "search", "cost": 1}
    assert all(s.quota is None for s in specs.values() if s.name.startswith("youtube_analytics"))
    estrictas = [s for s in specs.values() if s.strict]
    assert len(estrictas) <= 20 and all(s.risk != "read" for s in estrictas)  # limite de la API
    assert specs["youtube_delete_video"].input_schema["additionalProperties"] is False
    assert "additionalProperties" not in specs["buscar_kb"].input_schema  # esquema original


def test_strict_schema_makes_optionals_nullable_and_required():
    schema = {
        "title": "xArguments",
        "type": "object",
        "properties": {
            "a": {"type": "string", "title": "A"},
            "b": {"type": "integer", "default": 3, "title": "B"},
            "c": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None},
        },
        "required": ["a"],
    }
    out = registry.strict_schema(schema)
    assert out["required"] == ["a", "b", "c"]
    assert out["additionalProperties"] is False
    assert "title" not in out and "title" not in out["properties"]["a"]
    assert out["properties"]["b"] == {"anyOf": [{"type": "integer"}, {"type": "null"}]}
    assert out["properties"]["c"] == {"anyOf": [{"type": "string"}, {"type": "null"}]}
    assert schema["properties"]["b"]["default"] == 3  # el original no se toca


def test_call_drops_nulls_so_defaults_apply():
    spec = registry.ToolSpec(
        name="t", description="", input_schema={}, fn=lambda a, b=3: (a, b),
        risk="read", quota=None, job_kind=None,
    )
    assert spec.call({"a": 1, "b": None}) == (1, 3)
    assert spec.call({"a": 1, "b": 7}) == (1, 7)
