# PirmaNest

Sign PDFs in the browser — draw with a pen, or place a saved signature — and download the signed PDF.
Documents never leave your device: rendering, signing and PDF export all run client-side.

## Features

- Open a PDF (button or drag & drop)
- **Pen** tool with adjustable thickness and colour; pressure-sensitive with a stylus
- **Eraser**, **undo / redo**
- **Draw signature** pad, or **upload signature** image (white background removed automatically)
- Move / resize / delete placed signatures
- **Download PDF** with everything burned into the file (works on rotated pages too)

Shortcuts: `P` pen · `E` eraser · `V` select · `Ctrl+Z` undo · `Ctrl+Y` redo · `Delete` remove selected · `Ctrl+scroll` zoom

## Development

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Stack

Vite · React · TypeScript · Tailwind CSS · [pdf.js](https://github.com/mozilla/pdf.js) (rendering) ·
[perfect-freehand](https://github.com/steveruizok/perfect-freehand) (ink) · [pdf-lib](https://pdf-lib.js.org) (export)

## PirmaNest Pro (in development)

Secure recipient signing (password-protected links, evidence trail). Design and status:
[docs/pro-signing/phase1-assessment.md](docs/pro-signing/phase1-assessment.md) ·
[docs/pro-signing/phase2-notes.md](docs/pro-signing/phase2-notes.md).

```bash
npm test          # security test suite (in-process Postgres, no Docker)
npm run dev:api   # local Pro backend for development
```

## Roadmap

- Word (.docx) upload — converted to PDF via a small Gotenberg (LibreOffice) service
- Deploy
