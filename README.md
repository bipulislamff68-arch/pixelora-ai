# Pixelora – Advanced AI Photo Editor

## Run it

1. Install Node.js 18 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` (https://platform.openai.com/api-keys).
4. `npm start`, then open http://localhost:3000

Open the site through the server (not by double-clicking index.html), otherwise the `/api/...` calls have nothing to talk to.

## Files

- `index.html` – the full website
- `server.js` – serves the page and talks to OpenAI; the API key never reaches the browser
- `package.json`, `.env.example`, `.gitignore`
- `examples/` (optional) – pre-made transparent PNGs named like `products-1-after.png`

## AI tools (both use the OpenAI image model)

- **Background removal** – returns a transparent PNG. The AI result is used only as a mask on your original photo, so the subject keeps its original pixels and the image keeps its original size.
- **AI Background** – describe a new background in the prompt box (max 300 characters) and the subject is placed on it.

## Examples section

For each example the page first tries `examples/<category>-<n>-after.png`. If it is missing, it asks
`/api/example-cutout/<photo-id>`; the server removes the background once and keeps the result in `cache/`,
so later visits cost nothing. To make them permanent, copy files from `cache/` into `examples/`.

## Notes

- Each AI call costs OpenAI credits. The server allows 6 AI requests per minute per IP.
- Generative models can slightly change fine edges; for the most exact cut-outs use `OPENAI_IMAGE_QUALITY=high`.
- Images over ~9 MB are re-encoded in the browser before upload; the server limit is 12 MB.
- Never commit `.env` to GitHub.
