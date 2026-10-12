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
    assert len(estrictas) <= registry.MAX_STRICT_TOOLS  # limite de la API
    assert all(s.risk != "read" for s in estrictas)
    assert specs["youtube_delete_video"].input_schema["additionalProperties"] is False
    assert "additionalProperties" not in specs["buscar_kb"].input_schema  # esquema original


def test_strict_tools_stay_under_the_api_union_limit():
    """La API rechaza (400) cualquier peticion si las tools estrictas suman mas de 16
    parametros con union. Los E2E de la UI usan un Anthropic falso y no lo ven."""
    estrictas = [s for s in registry.build() if s.strict]
    uniones = {s.name: registry.count_unions(s.input_schema) for s in estrictas}
    total = sum(uniones.values())
    assert total <= registry.MAX_STRICT_UNIONS, uniones
    assert total <= 12, f"Margen para tools futuras (limite {registry.MAX_STRICT_UNIONS}): {uniones}"


def test_strict_update_video_treats_empty_as_unchanged():
    spec = registry.by_name(registry.build())["youtube_update_video"]
    props = spec.input_schema["properties"]
    assert props["description"]["type"] == "string" and "anyOf" not in props["description"]
    assert props["tags"]["type"] == "array"
    assert {"title", "description", "tags", "publish_at"} <= spec.omit_if_empty
    assert "video_id" not in spec.omit_if_empty  # obligatorio: "" no se descarta


def test_strict_schema_makes_optionals_required():
    schema = {
        "title": "xArguments",
        "type": "object",
        "properties": {
            "a": {"type": "string", "title": "A"},
            "b": {"type": "integer", "default": 3, "title": "B"},
            "c": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None},
            "d": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}]},
            "e": {"type": "string", "enum": ["x", "y"], "default": "x"},
        },
        "required": ["a"],
    }
    out = registry.strict_schema(schema)
    assert out["required"] == ["a", "b", "c", "d", "e"]
    assert out["additionalProperties"] is False
    assert "title" not in out and "title" not in out["properties"]["a"]
    assert out["properties"]["b"] == {"anyOf": [{"type": "integer"}, {"type": "null"}]}
    # texto y lista: obligatorios sin union, "" / [] = no indicado
    assert out["properties"]["c"]["type"] == "string" and "anyOf" not in out["properties"]["c"]
    assert out["properties"]["d"]["type"] == "array" and out["properties"]["d"]["items"] == {"type": "string"}
    assert "not provided" in out["properties"]["c"]["description"]
    # con enum "" no es valido: sigue con null
    assert out["properties"]["e"] == {"anyOf": [{"type": "string", "enum": ["x", "y"]}, {"type": "null"}]}
    assert registry.omit_if_empty(schema) == {"c", "d"}
    assert registry.count_unions(out) == 2
    assert schema["properties"]["b"]["default"] == 3  # el original no se toca


def test_call_drops_nulls_so_defaults_apply():
    spec = registry.ToolSpec(
        name="t", description="", input_schema={}, fn=lambda a, b=3: (a, b),
        risk="read", quota=None, job_kind=None,
    )
    assert spec.call({"a": 1, "b": None}) == (1, 3)
    assert spec.call({"a": 1, "b": 7}) == (1, 7)


def test_call_drops_empties_only_in_omit_if_empty():
    spec = registry.ToolSpec(
        name="t", description="", input_schema={}, fn=lambda a, b="def", c=None: (a, b, c),
        risk="write", quota=None, job_kind=None, strict=True, omit_if_empty=frozenset({"b", "c"}),
    )
    assert spec.call({"a": "", "b": "", "c": []}) == ("", "def", None)  # a no esta en el conjunto
    assert spec.call({"a": "x", "b": "y", "c": ["t"]}) == ("x", "y", ["t"])
