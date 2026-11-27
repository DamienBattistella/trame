"""Images of a thread shown to a brain that can see them (Claude), named in words otherwise."""
from __future__ import annotations

import io
import json

from brain import claude as claude_mod
from brain.base import build_prompt, image_block
from drivers.mock import MockTeamsDriver
from models import ImageRef, IncomingMessage, MessageRef, Surface
from conftest import FakeBrain

DM = "19:bb22@thread.v2"
JPEG = "data:image/jpeg;base64," + "A" * 40
PNG = "data:image/png;base64," + "B" * 40


class SeeingBrain(FakeBrain):
    supports_images = True

    def __init__(self) -> None:
        super().__init__()
        self.images: list[list[str]] = []
        self.summaries: list[str] = []

    def draft(self, soul, thread_summary, incoming, github_context="", people_context="", images=()):
        self.images.append(list(images))
        self.summaries.append(thread_summary)
        return super().draft(soul, thread_summary, incoming, github_context, people_context)


class BlindBrain(FakeBrain):
    def __init__(self) -> None:
        super().__init__()
        self.summaries: list[str] = []

    def draft(self, soul, thread_summary, incoming, github_context="", people_context=""):
        self.summaries.append(thread_summary)
        return super().draft(soul, thread_summary, incoming, github_context, people_context)


class ScreenshotDriver(MockTeamsDriver):
    """Lucas sends two screenshots (one Teams never displayed), then asks for help."""

    def read_context(self, thread_id, last_n):
        def msg(text, at, images=()):
            return IncomingMessage(thread_id=thread_id, sender="Lucas Bernard", text=text, received_at=at,
                                   surface=Surface.dm, images=list(images))
        return [
            msg("", "10:22", [ImageRef(data=JPEG, width=800, height=189), ImageRef(), ImageRef(data=PNG, width=10, height=10)]),
            msg("Le traitement plante encore", "10:23"),
            msg("sinon je le fais à la main", "10:26"),
        ]


def test_image_block_takes_jpeg_and_png_only():
    assert image_block(JPEG) == {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "A" * 40}}
    assert image_block(PNG)["source"]["media_type"] == "image/png"
    assert image_block("data:image/svg+xml;base64,PHN2Zz4=") is None
    assert image_block("https://example.com/x.png") is None


def test_prompt_names_the_joined_images():
    assert "[image 1] à [image 2]" in build_prompt("soul", "fil", "msg", "", "", images=2)
    assert "[image 1]" not in build_prompt("soul", "fil", "msg", "", "")


def test_suggestion_shows_the_thread_images_to_a_seeing_brain(make_client):
    brain = SeeingBrain()
    _client, watcher, _driver = make_client(driver=ScreenshotDriver(interval=9999), brain=brain)
    watcher.suggest_reply(DM, 15)
    assert brain.images == [[JPEG, PNG]]
    # Numbered in order; the image Trame could not capture stays a word.
    assert brain.summaries[0].startswith("Lucas Bernard: [image 1]\n[image]\n[image 2]")


def test_brain_without_vision_gets_words_only(make_client):
    brain = BlindBrain()
    _client, watcher, _driver = make_client(driver=ScreenshotDriver(interval=9999), brain=brain)
    watcher.suggest_reply(DM, 15)
    assert brain.summaries[0].startswith("Lucas Bernard: [image]\n[image]\n[image]")


def test_only_the_most_recent_images_are_shown(make_client):
    brain = SeeingBrain()
    _client, watcher, _driver = make_client(driver=ScreenshotDriver(interval=9999), brain=brain)
    watcher.BRAIN_IMAGES = 1
    watcher.suggest_reply(DM, 15)
    assert brain.images == [[PNG]]
    assert brain.summaries[0].startswith("Lucas Bernard: [image]\n[image]\n[image 1]")


def test_reply_to_an_image_only_message_finds_it_and_sees_it(make_client):
    brain = SeeingBrain()
    _client, watcher, _driver = make_client(driver=ScreenshotDriver(interval=9999), brain=brain)
    # The app names an image-only message « [image] » (one per image).
    watcher.suggest_reply(DM, 15, MessageRef(sender="Lucas Bernard", text="[image]\n[image]\n[image]"))
    assert brain.calls == ["[image 1]\n[image]\n[image 2]"]
    assert brain.images == [[JPEG, PNG]]
    assert "pas au dernier du fil" in brain.summaries[0]


def test_auto_draft_context_keeps_the_images(make_client):
    brain = SeeingBrain()
    _client, watcher, _driver = make_client(driver=ScreenshotDriver(interval=9999), brain=brain)
    summary = watcher._summary(DM, 15)
    assert summary.startswith("Lucas Bernard: [image 1]\n[image]\n[image 2]")
    assert watcher._history_images[DM] == [JPEG, PNG]


class _Proc:
    def __init__(self, args, **_kw):
        _Proc.args = args
        self.stdin = io.StringIO()
        _Proc.stdin = self.stdin
        self.stdin.close = lambda: None
        self.stdout = io.StringIO(json.dumps({"type": "result", "subtype": "success", "result": "Je vois l'erreur."}) + "\n")
        self.stderr = io.StringIO("")
        self.returncode = 0

    def wait(self):
        return 0

    def kill(self):
        pass


def test_claude_sends_images_as_stream_json_input(monkeypatch):
    monkeypatch.setattr(claude_mod.subprocess, "Popen", _Proc)
    answer = claude_mod.ClaudeBrain().complete("Que montre l'image ?", images=[JPEG, "data:image/gif;base64,R0lG"])
    assert answer == "Je vois l'erreur."
    assert _Proc.args[_Proc.args.index("--input-format") + 1] == "stream-json"
    assert "--tools" in _Proc.args  # still no tool for the model
    sent = json.loads(_Proc.stdin.getvalue())
    content = sent["message"]["content"]
    assert [b["type"] for b in content] == ["image", "text"]  # the GIF is left out
    assert content[1]["text"] == "Que montre l'image ?"


def test_claude_without_images_keeps_plain_input(monkeypatch):
    seen = {}

    def run(args, **kw):
        seen["args"], seen["input"] = args, kw.get("input")

        class R:
            returncode, stdout, stderr = 0, "ok", ""
        return R()
    monkeypatch.setattr(claude_mod.subprocess, "run", run)
    assert claude_mod.ClaudeBrain().complete("Bonjour") == "ok"
    assert "--input-format" not in seen["args"] and seen["input"] == "Bonjour"
