// node --test tests/ : une photo retrouvée par le nom, quelle que soit son écriture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { photoKey, photoOf, setPhotos } from "../src/lib/photos.ts";

const JPEG = "data:image/jpeg;base64,/9j/4AAQ";

test("le même nom écrit autrement donne la même clé", () => {
  assert.equal(photoKey("Ana Martin"), photoKey("MARTIN, Ana"));
  assert.equal(photoKey("Léa Dupré (Externe)"), photoKey("lea dupre"));
  assert.equal(photoKey("Paul [Acme] Roux"), photoKey("Roux Paul"));
  assert.notEqual(photoKey("Ana Martin"), photoKey("Ana Martinez"));
});

test("seules des images sont gardées, et retrouvées par le nom", () => {
  setPhotos({ "Ana Martin": JPEG, Paul: "javascript:alert(1)" });
  assert.equal(photoOf("MARTIN Ana"), JPEG);
  assert.equal(photoOf("Paul"), null);
  assert.equal(photoOf("Inconnu"), null);
  setPhotos({});
  assert.equal(photoOf("Ana Martin"), null);
});
