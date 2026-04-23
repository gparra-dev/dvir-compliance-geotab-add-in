# Lytx DVIR Compliance — MyGeotab Add-In

A MyGeotab Page Add-In that shows daily DVIR inspection compliance per vehicle.

**Compliance logic:**
- Vehicle did not move (distance = 0) → No Inspection Needed
- Vehicle moved + inspection submitted → Compliant
- Vehicle moved + no inspection → Not Compliant

## File structure

```
index.html        Add-In page (UI + styles)
js/app.js         DVIRApp logic + Geotab lifecycle entry point
config.json       Add-In configuration file (paste into MyGeotab)
icon.svg          Navigation menu icon
```

## Setup

### 1. Enable GitHub Pages
In your repo: **Settings → Pages → Source → Deploy from branch → main → / (root) → Save**

Your site will be live at: `https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/`

### 2. Update config.json
Replace the two placeholder URLs with your actual GitHub Pages URL:
```json
"url": "https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/index.html"
"svgIcon": "https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/icon.svg"
```

### 3. Install in MyGeotab
1. Go to **Administration → System → System Settings → Add-Ins**
2. Click **+ New Add-In**
3. Paste the contents of `config.json`
4. Set **Allow unverified Add-Ins → Yes**
5. Click **Save**, then refresh the page
6. The Add-In will appear in the left nav under **Compliance**

## Notes
- Add-In respects the MyGeotab group/org filter
- Distance units switch automatically based on the user's metric/imperial preference
- CSV export downloads all vehicles for the selected date
