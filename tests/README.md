# Tests (Phase C: person selection and tracking)

Run every command from the repository root.

## Unit tests: `person-tracker.test.mjs`

Pure logic of `js/person-tracker.js`: tap hit-test (including the gliding
box drawn on screen), matching the selected box between detections,
SEARCHING / LOST timing, LOST reason, a person coming back, and tap
position mapping through the letterbox bars.

Needs only Node 18 or newer, no packages:

```bash
node --test tests/person-tracker.test.mjs
```

## Browser test: `e2e/phase-c.e2e.mjs`

Opens the real page (`index.html` and `js/`) in headless Chromium on a
phone-sized touch screen and checks:

- tapping a moving person selects it, the box turns orange, and every
  person label says "ยังไม่ยืนยันตัวตน";
- SEARCHING, then LOST about 2.5 s later, with the right message for a
  person vanishing mid-frame, walking out the left edge, or a covered
  (dark) camera;
- a person coming back: tracking resumes while SEARCHING; after LOST only a
  new tap selects them (new number);
- no ONNX Runtime, model file, `manifest.json` or embedding module is
  requested (no face recognition in Phase C);
- FACE CROP EXPORT gives a 112x112 PNG from a page-local `blob:` URL, with
  no network request and no IndexedDB change;
- the Phase A+B enrollment UI is gone and a full session (camera, tracking,
  face crop) creates no IndexedDB database;
- data saved by Phase A+B is shown in SAVED OWNER DATA, survives reloads
  and app use, is kept when the delete dialog is cancelled, and is cleared
  only after the user confirms.

MediaPipe is replaced by `e2e/fake-vision.mjs`, so the test needs no
network or model files and the person/face boxes are set by the test. The
fake camera plays two small Y4M videos the test writes to a temp folder
and deletes afterwards. Because the detector is fake, this test does NOT
measure detection quality, and it does not run Safari or a real phone.

Needs Playwright with Chromium:

```bash
npm install --no-save playwright
```

```bash
npx playwright install chromium
```

```bash
node --test tests/e2e/phase-c.e2e.mjs
```

With a global Playwright install instead:

```bash
NODE_PATH="$(npm root -g)" node --test tests/e2e/phase-c.e2e.mjs
```

Without Playwright the browser tests are reported as skipped. A run takes
about 20 seconds.
