import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTimelineOwner, timelineWriteErrors } from "./check-timeline-owner.mjs";
test("timeline consumers cannot bypass the viewport owner", () => {
  for (const source of [
    "pane.scrollTop = 100",
    'pane["scrollTop"] += 5',
    "match.scrollIntoView()",
    "pane.scrollTo({top:0})",
  ]) {
    assert.match(timelineWriteErrors(source, "consumer.tsx")[0], /use-timeline-viewport/);
  }
  assert.deepEqual(
    timelineWriteErrors("const top = pane.scrollTop; viewport.jumpToLatest();", "consumer.tsx"),
    [],
  );
});
test("actual timeline consumers respect the owner", () =>
  assert.deepEqual(checkTimelineOwner(process.cwd()), []));
