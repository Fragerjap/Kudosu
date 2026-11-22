"""
Bolt: Kudosu — FastAPI localhost fallback server.

The app is a static PWA (vanilla html/css/js). Any static server works, but
this file lets you test locally with:
    python main.py
then open http://127.0.0.1:8000

It serves index.html at "/", the service worker at "/sw.js" (root scope is
required for the offline cache), and the /public and /src folders as assets.
"""
import os

try:
    import uvicorn
    from fastapi import FastAPI
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
except ImportError:
    raise SystemExit(
        "FastAPI is not installed. Run:  pip install fastapi uvicorn\n"
        "Or use any static server instead, e.g.:  python -m http.server 8000"
    )

ROOT = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="Kudosu")

# Bolt: the app shell itself.
@app.get("/")
def index():
    return FileResponse(os.path.join(ROOT, "index.html"))

# Bolt: service worker must be served from the root to own the "/" scope.
@app.get("/sw.js")
def service_worker():
    return FileResponse(
        os.path.join(ROOT, "sw.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )

# Bolt: static asset folders (styles, scripts, manifest, icons, generator).
app.mount("/public", StaticFiles(directory=os.path.join(ROOT, "public")), name="public")
app.mount("/src", StaticFiles(directory=os.path.join(ROOT, "src")), name="src")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
