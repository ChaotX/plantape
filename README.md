# Plantape

Measure up a garden with an ordinary tape measure. Name landmark points (building corners, trees, fence posts,
path spots…), measure distances between them, and Plantape computes least-squares 3D positions. The positions
get more accurate with every measurement. Data lives in a Google Spreadsheet (one per garden), or in the browser
if you don't want to use Google.

It is a static web app (plain JavaScript ES modules, no build step), so it can be hosted on GitHub Pages.

## Features

- **Plan from measurements:** a weighted least-squares adjustment (Levenberg–Marquardt) computes x, y, z for
  every point, with standard deviations and 95 % error ellipses.
- **Slope / 3D:** hold the tape higher at one end (e.g. 0 m → 2 m) and the height differences of the ground
  become measurable.
- **Measuring assistant:** "I'm at point S" lists the reachable points with estimated distances and the value of
  measuring each one. New points can be named on the spot.
- **Hints:** a ranked list of the measurements that would shrink the plan / height uncertainty most, plus points
  that still need links. The hints are also drawn on the plan.
- **Typo detection:**
  - Each distance is checked against the expected value as you type it. If it doesn't fit, you get "Did you
    mean 12.45 (swapped digits)?"
  - After each adjustment, Baarda data snooping flags measurements that don't fit the rest and proposes the
    likely correction.
- **Live sync to Google Sheets:** every point and measurement is appended right away. Changes made offline are
  queued in the browser and sent once online. You can also write the computed coordinates back into the sheet.
- **Export:** vector **PDF** and **SVG** at true scale (1:20 … 1:2000, A4/A3/A2) with scale bar and title
  block, a coordinates CSV, and a JSON backup.
- English and Hungarian UI.

## Running locally

```sh
node tools/serve.mjs   # or: npm run serve (in PowerShell: npm.cmd run serve)
node --test "tests/*.test.js"   # or: npm test — solver, typo detection and Google Sheets store tests (Node ≥ 20, no dependencies)
```

Open <http://localhost:8000>. **Use without Google → Try the demo garden** shows a sloped demo garden that
contains one deliberate typo.

## Deploying to GitHub Pages

1. Push the repository to GitHub.
2. Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then branch `main` and
   folder `/ (root)`.
3. The app is served at `https://<user>.github.io/<repo>/`. All paths are relative, so it works under a
   sub-path.

## Google Cloud setup (one-time, for "Sign in with Google")

Without this setup the app still works, but gardens are stored in the browser only.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
2. **APIs & Services → Library:** enable **Google Sheets API**, **Google Drive API** and **Google Picker API**.
3. **OAuth consent screen:**
   - Choose *External*, and fill in the app name and your e-mail address.
   - Add the scope `https://www.googleapis.com/auth/drive.file`. This is a non-sensitive scope: the app can
     only see spreadsheets that it created or that the user picked in the Drive Picker. No Google
     verification is needed.
   - While the app is in *Testing* mode, add the Google accounts that may use it as test users.
4. **Credentials → Create credentials → OAuth client ID**, type *Web application*. Add these as
   **Authorized JavaScript origins**:
   - `https://<user>.github.io`
   - `http://localhost:8000` (for local testing)
5. **Credentials → Create credentials → API key**. Restrict it:
   - *Application restrictions → HTTP referrers:* `https://<user>.github.io/*` and `http://localhost:8000/*`.
   - *API restrictions:* Google Picker API.
6. Copy the values into [js/config.js](js/config.js):
   - `GOOGLE_CLIENT_ID`: the OAuth client ID.
   - `GOOGLE_API_KEY`: the API key.
   - `GOOGLE_APP_ID`: the **project number** (Cloud console dashboard → Project info).

   These values end up in the browser anyway; the origin restrictions above are what protect them.

## Spreadsheet format

**New garden** creates the spreadsheet for you. You can also pick an existing spreadsheet: missing tabs are
added. Columns are found by their header name (case-insensitive), so you can reorder them and add your own.

| Tab | Columns | Notes |
|---|---|---|
| `Points` | `name`, `category`, `notes`, `x`, `y`, `z`, `sigma_xy`, `sigma_z`, `links`, `status` | `x` … `status` are filled by **Write coordinates to sheet**. |
| `Measurements` | `id`, `timestamp`, `from`, `from_h`, `to`, `to_h`, `distance`, `status`, `residual`, `w`, `flag`, `note` | `from_h` / `to_h`: height of the tape above the ground in metres (default 0). Set `status` to `excluded` to ignore a row. |
| `Settings` | `key`, `value` | Garden name, tape length, accuracy, datum points… |
| `Blocked` | `from`, `to`, `note` | Pairs that can't be measured (obstructed); they are not suggested. |

Rows typed into the sheet by hand work too; decimal commas (`12,45`) are accepted. Points that are used in
measurements but missing from `Points` are created automatically.

## How it works

- **Model.**
  - Each point has a ground position P = (x, y, z), with z vertical.
  - A measurement from point *a* (tape at height hₐ) to point *b* (tape at h_b) observes
    d = |(P_b + h_b·ez) − (P_a + hₐ·ez)|.
  - Weights come from σ = 5 mm + 2 mm/m (both editable).
- **Datum.** The origin point is (0, 0, 0), the axis point lies on +x, and the side point is on the +y side.
  All three can be chosen in Settings and don't need to be measured to each other.
- **Heights.**
  - Only measurements with different tape heights at the two ends carry height information.
  - Points without such measurements get a weak "terrain smoothness" prior toward their neighbours
    (σ = 0.1 m + 15 % of the distance). Their heights are shown as `~` (interpolated).
  - The prior is not used between points whose height difference is measured, so it doesn't bias them.
- **Start values.**
  - Incremental trilateration from the best-braced link.
  - A point placed from only two neighbours has two mirror-image solutions. The app searches over these
    choices so that no branch of the network ends up folded.
  - Heights are then initialised from the height-offset measurements.
- **Adjustment.**
  - Levenberg–Marquardt with the full Newton curvature of the distance function. Without it, convergence
    along the flat height directions is slow.
  - The covariance of the unknowns gives the error ellipses and σz.
- **Hints.**
  - For each candidate measurement with row *a*, the covariance shrinks by Q·a·aᵀ·Q / (σ² + aᵀ·Q·a)
    (Sherman–Morrison).
  - Plan and height reductions are reported separately, as percentages of their totals.
- **Typos.**
  - On entry, the distance is compared with the predicted one, using the predicted σ from the covariance.
  - After each adjustment, standardized residuals w = v / σᵥ are tested, and the worst measurement is removed
    iteratively. The critical value is 3.29, raised by a Bonferroni correction for large networks.
  - Candidate corrections cover swapped digits, a misplaced decimal point, 6↔9, ±1 m, ±10 cm, and an extra,
    missing or wrong digit.

## Project layout

```
index.html, style.css      UI shell
js/app.js                  controller: screens, actions, recomputation
js/solver/                 linalg, initial placement, adjustment, planner (hints), blunders (typos)
js/store.js                Local and Google Sheets stores (offline queue, write-back)
js/sheets-api.js           Sheets REST wrapper (fetchWithRetry ported from plant-trainer)
js/google-auth.js, picker.js  Google Identity Services token client, Drive Picker
js/view/                   SVG plan view and side panels
js/export.js               paper layout, SVG / PDF (jsPDF + svg2pdf.js in vendor/) and data exports
i18n/en.js, i18n/hu.js     UI strings
tests/                     node --test suites
```

## Limitations and ideas

- The standard PDF fonts only cover Latin-1. `ő` and `ű` are printed as `ö` and `ü` in PDFs; SVG is not
  affected. Embedding a TTF font would remove this limitation.
- The adjustment runs on the main thread: about 75 ms for 60 points and about 0.4 s for 100 points including
  typo checks. A Web Worker would help very large gardens.
- Heights of points that were only measured ground-to-ground are interpolated. Measure a few distances with a
  raised tape to fix them.
- Possible additions: DXF export for CAD, PNG export, contour lines from the measured heights.
