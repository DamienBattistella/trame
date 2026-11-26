from __future__ import annotations
import json
import threading
import time

import pytest

import reflection
import telemetry
from brain.claude import parse_stream
from brain.mock import MockBrain
from conftest import FakeBrain

SOFIA = "19:aa11@thread.v2"
SECRET = "pensée secrète 4242"


class ThinkingBrain(FakeBrain):
    """Streams its reasoning, then answers, or fails in the middle of the stream."""

    def __init__(self, fail: bool = False, **kw):
        super().__init__(**kw)
        self.fail = fail

    def correct(self, text: str) -> str:
        reflection.thinking("Je relis ")
        reflection.thinking(SECRET)
        if self.fail:
            raise RuntimeError("flux coupé")
        return text.capitalize()


class WaitingBrain(FakeBrain):
    """Thinks until the user cancels: cancelling kills it, like a brain process."""

    def correct(self, text: str) -> str:
        killed = threading.Event()
        reflection.on_cancel(killed.set)
        reflection.thinking("Je réfléchis longuement")
        assert killed.wait(5), "l'annulation n'a jamais tué le cerveau"
        raise RuntimeError("processus tué")


def _otel(home) -> str:
    telemetry.flush()
    lines = (home / "otel.jsonl").read_text(encoding="utf-8").splitlines()
    return json.dumps([json.loads(line) for line in lines if line.strip()], ensure_ascii=False)


@pytest.fixture(autouse=True)
def _telemetry_off():
    yield
    telemetry.configure({"enabled": False})


def _runs(client):
    return client.get("/api/reflections").json()["runs"]


def test_suggest_streams_steps_then_reasoning_then_result_in_order(make_client):
    client, watcher, _ = make_client(brain=MockBrain())
    r = client.post(f"/api/threads/{SOFIA}/suggest")
    assert r.status_code == 200
    [run] = _runs(client)
    assert run["action"] == "suggest" and run["title"] == "Proposer une réponse"
    assert run["status"] == "done" and run["conversation"] == "Sofia Marino" and run["threadId"] == SOFIA
    assert run["result"] == r.json()["text"] and run["reasoning"] is True and run["durationMs"] is not None
    kinds = [s["kind"] for s in run["steps"]]
    texts = [s["text"] for s in run["steps"]]
    assert texts[0].startswith("Lecture du fil")
    assert texts[1].startswith("Contexte rassemblé")
    assert texts[2].startswith("Appel envoyé")
    # The reasoning chunks are gathered in one block, between the call and the answer.
    assert kinds[3:] == ["thinking", "step"] and texts[-1].startswith("Réponse reçue")
    assert "Le dernier message dit" in texts[3]
    times = [s["atMs"] for s in run["steps"]]
    assert times == sorted(times)


def test_brain_without_reasoning_shows_trame_steps_only(make_client):
    client, watcher, _ = make_client(brain=FakeBrain(completion="Bonjour"))
    r = client.post("/api/correct", json={"text": "bonjour", "thread_id": SOFIA})
    assert r.status_code == 200
    [run] = _runs(client)
    assert run["action"] == "correct" and run["status"] == "done" and run["reasoning"] is False
    assert {s["kind"] for s in run["steps"]} == {"step"}
    assert run["steps"][0]["text"].startswith("Message à corriger") and run["conversation"] == "Sofia Marino"


def test_error_in_the_middle_of_the_stream(make_client):
    client, watcher, _ = make_client(brain=ThinkingBrain(fail=True))
    r = client.post("/api/correct", json={"text": "bonjour"})
    assert r.status_code == 502
    [run] = _runs(client)
    assert run["status"] == "error" and run["durationMs"] is not None
    assert [s["kind"] for s in run["steps"]] == ["step", "step", "thinking", "error"]
    assert run["steps"][2]["text"] == "Je relis " + SECRET
    assert "flux coupé" in run["steps"][-1]["text"]


def test_fact_check_is_followed(make_client):
    payload = {"claims": [{"excerpt": "vendredi", "verdict": "contredit", "source": "Sofia, 10:12", "fix": "jeudi"}]}
    client, watcher, _ = make_client(brain=FakeBrain(completion=json.dumps(payload)))
    assert client.post(f"/api/threads/{SOFIA}/check", json={"text": "vendredi ?"}).status_code == 200
    [run] = _runs(client)
    assert run["action"] == "check" and run["status"] == "done"
    assert run["result"] == "1 affirmation(s) relevée(s), 1 contredite(s)"
    assert any(s["text"].startswith("Contexte rassemblé : fil") and "entourage" in s["text"] and "GitHub" in s["text"]
               for s in run["steps"])


def test_cancel_a_running_action(make_client):
    client, watcher, _ = make_client(brain=WaitingBrain())
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", client.post("/api/correct", json={"text": "bonjour"})))
    t.start()
    for _ in range(200):
        runs = watcher.reflections.snapshot()
        if runs and any(s["kind"] == "thinking" for s in runs[0]["steps"]):
            break
        time.sleep(0.01)
    run_id = watcher.reflections.snapshot()[0]["id"]
    assert client.post(f"/api/reflections/{run_id}/cancel").status_code == 200
    t.join(5)
    assert out["r"].status_code == 409 and out["r"].json()["error"] == "Action annulée."
    [run] = _runs(client)
    assert run["status"] == "cancelled" and run["steps"][-1] == {"atMs": run["steps"][-1]["atMs"], "kind": "error",
                                                                 "text": "Action annulée"}
    # Nothing left to cancel.
    assert client.post(f"/api/reflections/{run_id}/cancel").status_code == 409


def test_reasoning_never_reaches_telemetry_without_permission(make_client, fresh_home):
    client, watcher, _ = make_client(brain=ThinkingBrain())
    client.put("/api/settings", json={"telemetry": {"enabled": True, "endpoint": ""}})
    assert client.post("/api/correct", json={"text": "bonjour"}).status_code == 200
    raw = _otel(fresh_home)
    assert "Réflexion (Corriger) : done" in raw and SECRET not in raw
    # Nor in the journal, whatever the settings.
    assert SECRET not in (fresh_home / "journal.jsonl").read_text(encoding="utf-8")


def test_reasoning_in_telemetry_only_when_content_allowed(make_client, fresh_home):
    client, watcher, _ = make_client(brain=ThinkingBrain())
    client.put("/api/settings", json={"telemetry": {"enabled": True, "include_content": True}})
    assert client.post("/api/correct", json={"text": "bonjour"}).status_code == 200
    assert SECRET in _otel(fresh_home)


def test_websocket_streams_reflection_frames(make_client, monkeypatch):
    import app as appmod
    monkeypatch.setattr(appmod, "WS_POLL", 0.01)
    client, watcher, _ = make_client(brain=ThinkingBrain())
    with client.websocket_connect("/ws") as ws:
        assert '"paused"' in ws.receive_text()
        assert client.post("/api/correct", json={"text": "bonjour"}).status_code == 200
        frames = []
        while not frames or frames[-1]["run"]["status"] == "running":
            frame = json.loads(ws.receive_text())
            if frame.get("kind") == "reflection":
                frames.append(frame)
    assert frames[-1]["run"]["status"] == "done" and frames[-1]["run"]["reasoning"] is True


def test_history_keeps_the_last_runs():
    reg = reflection.Reflections()
    for _ in range(reflection.MAX_RUNS + 5):
        with reg.track("correct", "mock"):
            reflection.step("x")
    runs = reg.snapshot()
    assert len(runs) == reflection.MAX_RUNS and runs[0]["id"] == f"r{reflection.MAX_RUNS + 5}"


def test_emitting_outside_an_action_does_nothing():
    reflection.step("rien")
    reflection.thinking("rien")
    assert not reflection.active() and not reflection.cancelled()


def test_claude_stream_json_relays_reasoning_then_answer():
    lines = [
        json.dumps({"type": "system", "subtype": "init", "model": "claude-sonnet-5-5"}),
        json.dumps({"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 50}),
        json.dumps({"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 202}),
        json.dumps({"type": "stream_event", "event": {"type": "content_block_delta",
                                                      "delta": {"type": "thinking_delta", "thinking": "Il demande "}}}),
        json.dumps({"type": "stream_event", "event": {"type": "content_block_delta",
                                                      "delta": {"type": "thinking_delta", "thinking": "l'heure."}}}),
        "bruit non JSON",
        json.dumps({"type": "stream_event", "event": {"type": "content_block_delta",
                                                      "delta": {"type": "text_delta", "text": "À 14 h."}}}),
        json.dumps({"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "doublon"}]}}),
        json.dumps({"type": "result", "subtype": "success", "result": "À 14 h."}),
    ]
    reg = reflection.Reflections()
    with reg.track("suggest", "claude", "sonnet"):
        answer, text, failure = parse_stream(lines)
    assert (answer, text, failure) == ("À 14 h.", "À 14 h.", "")
    [run] = reg.snapshot()
    assert [(s["kind"], s["text"]) for s in run["steps"]] == [
        ("step", "Modèle prêt : claude-sonnet-5-5"),
        ("step", "Le modèle réfléchit (≈ 202 jetons, texte non transmis)"),
        ("thinking", "Il demande l'heure."),
        ("step", "Le modèle écrit sa réponse"),
    ]


def test_claude_stream_json_error_result():
    reg = reflection.Reflections()
    with reg.track("correct", "claude"):
        answer, _text, failure = parse_stream([json.dumps({"type": "result", "subtype": "error_max_turns",
                                                           "is_error": True})])
    assert answer is None and failure == "error_max_turns"
