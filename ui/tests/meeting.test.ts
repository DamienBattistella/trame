import { test } from "node:test";
import assert from "node:assert/strict";
import { meetingUrl } from "../src/lib/meeting.ts";

const JOIN =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_YTM1%40thread.v2/0?context=%7b%22Tid%22%3a%229fff%22%7d";

test("liens de réunion Teams gardés", () => {
  for (const url of [
    JOIN,
    "https://teams.cloud.microsoft/l/meetup-join/19%3ameeting_x%40thread.v2/0",
    "https://teams.microsoft.com/meet/123456789?p=abc",
    "https://teams.live.com/meet/9876?p=xyz",
  ])
    assert.equal(meetingUrl(url), url);
});

test("tout le reste écarté", () => {
  for (const url of [
    null,
    42,
    "",
    "http://teams.microsoft.com/l/meetup-join/x/0",
    "https://evil.example/l/meetup-join/x/0",
    "https://teams.microsoft.com.evil.example/l/meetup-join/x/0",
    "https://user@teams.microsoft.com/l/meetup-join/x/0",
    "https://teams.microsoft.com:8443/l/meetup-join/x/0",
    "https://Teams.Microsoft.com/l/meetup-join/x/0",
    "https://teams.microsoft.com/l/chat/0/0?users=x",
    "https://teams.microsoft.com/l/meetup-join/",
    "https://teams.microsoft.com/l/meetup-join/x\n/0",
    "javascript:alert(1)",
  ])
    assert.equal(meetingUrl(url), null, String(url));
});
