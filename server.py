#!/usr/bin/env python3
"""Camera Path Studio: a small local server for the studio page.

    python3 server.py [TAKES_DIR] [--port 8780] [--open]

TAKES_DIR (default: ./takes next to this file) is scanned for "takes": any
folder that contains a scene.json. Atlas exports dropped into the page as a
.zip are unpacked there. Exports are written to <take>/exports/ and the page then
downloads them through the browser.

Standard library only; exporting video needs ffmpeg on your PATH.
"""
import argparse
import http.server
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import uuid
import webbrowser
import zipfile
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
ROOT = TOOL_DIR / "takes"
EXPORTS = {}  # export id -> {"dir", "take", "name", "fps", "alpha"}
IMPORTED = ".imported"  # marker in folders unpacked from a dropped .zip; only those can be removed from the page


def safe_join(base: Path, rel: str) -> Path | None:
    """base/rel, or None if that would land outside base."""
    target = (base / rel).resolve()
    if target == base or base in target.parents:
        return target
    return None


def find_takes():
    takes = []
    for scene in sorted(ROOT.rglob("scene.json")):
        if any(p.startswith(".") or p == "exports" for p in scene.relative_to(ROOT).parts):
            continue
        takes.append(str(scene.parent.relative_to(ROOT)))
    return takes


def saved(path: Path) -> dict:
    """What the page needs to download a file we just wrote under ROOT."""
    return {"path": str(path), "name": path.name, "url": "/data/" + urllib.parse.quote(str(path.relative_to(ROOT)))}


def import_root(take: str) -> Path | None:
    """The folder a take was unpacked into, if it came from a dropped .zip (else None)."""
    path = safe_join(ROOT, take)
    while path and path != ROOT and ROOT in path.parents:
        if (path / IMPORTED).exists():
            return path
        path = path.parent
    return None


def slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-.") or "take"


def import_zip(zip_path: Path, name: str) -> str:
    """Unpack an Atlas export .zip into ROOT/<name>/ and return the take's name."""
    with zipfile.ZipFile(zip_path) as z:
        files = [m for m in z.infolist() if not m.is_dir()
                 and not m.filename.startswith("__MACOSX/") and not Path(m.filename).name.startswith("._")]
        if not any(Path(m.filename).name == "scene.json" for m in files):
            raise ValueError("No scene.json in this zip. Is it an Atlas export?")
        # zips of a folder put everything under one top-level directory; drop it
        tops = {m.filename.split("/", 1)[0] for m in files}
        strip = f"{tops.pop()}/" if len(tops) == 1 and all("/" in m.filename for m in files) else ""
        dest, k = ROOT / slug(name), 2
        while dest.exists():
            dest, k = ROOT / f"{slug(name)}-{k}", k + 1
        dest.mkdir(parents=True)
        dest = dest.resolve()
        for m in files:
            target = safe_join(dest, m.filename[len(strip):])
            if not target:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(m) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    (dest / IMPORTED).write_text(json.dumps({"from": f"{name}.zip", "at": time.strftime("%Y-%m-%d %H:%M:%S")}))
    scene = sorted(dest.rglob("scene.json"))[0]
    return str(scene.parent.relative_to(ROOT))


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "/api/" in self.path:
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path):
        # /data/<take>/... is served from the takes folder, everything else from this folder
        path = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        if path.startswith("/data/"):
            target = safe_join(ROOT, path[len("/data/"):])
        else:
            target = safe_join(TOOL_DIR, path.lstrip("/") or "index.html")
        return str(target) if target else str(TOOL_DIR / "__forbidden__")

    def json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/takes"):
            takes = find_takes()
            return self.json({"root": str(ROOT), "takes": takes, "removable": [t for t in takes if import_root(t)],
                              "ffmpeg": bool(shutil.which("ffmpeg"))})
        return super().do_GET()

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        try:
            if url.path == "/api/import":
                # body: the .zip; streamed to disk, since exports can be a few hundred MB
                left = int(self.headers.get("Content-Length", 0))
                if not left:
                    return self.json({"error": "empty upload"}, 400)
                with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
                    while left > 0:
                        chunk = self.rfile.read(min(left, 1 << 20))
                        if not chunk:
                            break
                        tmp.write(chunk)
                        left -= len(chunk)
                try:
                    take = import_zip(Path(tmp.name), Path(q.get("name", "take")).stem)
                except (zipfile.BadZipFile, ValueError) as e:
                    return self.json({"error": str(e) or "not a valid .zip"}, 400)
                finally:
                    os.unlink(tmp.name)
                return self.json({"take": take})

            if url.path == "/api/remove":
                # deletes a take that was imported from a .zip (never a folder you pointed the server at)
                folder = import_root(q["take"])
                if not folder:
                    return self.json({"error": "only takes imported from a .zip can be removed here"}, 403)
                shutil.rmtree(folder)
                return self.json({"ok": True})

            if url.path == "/api/export/start":
                opts = json.loads(self.body() or b"{}")
                take = safe_join(ROOT, opts["take"])
                if not take or not (take / "scene.json").exists():
                    return self.json({"error": "unknown take"}, 400)
                eid = uuid.uuid4().hex[:10]
                EXPORTS[eid] = {
                    "dir": Path(tempfile.mkdtemp(prefix="camera-path-studio-")),
                    "take": take,
                    "name": slug(opts.get("name", "export")),
                    "fps": float(opts.get("fps", 24)),
                    "alpha": bool(opts.get("alpha", False)),
                }
                return self.json({"id": eid})

            if url.path == "/api/export/frame":
                job = EXPORTS[q["id"]]
                (job["dir"] / f"{int(q['i']):05d}.png").write_bytes(self.body())
                return self.json({"ok": True})

            if url.path == "/api/export/finish":
                job = EXPORTS.pop(q["id"])
                out_dir = job["take"] / "exports"
                out_dir.mkdir(exist_ok=True)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                if job["alpha"]:
                    out = out_dir / f"{job['name']}-{stamp}.mov"
                    codec = ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]
                else:
                    out = out_dir / f"{job['name']}-{stamp}.mp4"
                    codec = ["-c:v", "libx264", "-preset", "slow", "-crf", "14",
                             "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
                cmd = ["ffmpeg", "-v", "error", "-y", "-framerate", str(job["fps"]),
                       "-i", str(job["dir"] / "%05d.png"), *codec, str(out)]
                try:
                    res = subprocess.run(cmd, capture_output=True, text=True)
                except FileNotFoundError:
                    return self.json({"error": "ffmpeg not found. Install it and make sure it's on your PATH."}, 500)
                finally:
                    shutil.rmtree(job["dir"], ignore_errors=True)
                if res.returncode != 0:
                    return self.json({"error": res.stderr[-2000:]}, 500)
                return self.json(saved(out))

            if url.path == "/api/snapshot":
                take = safe_join(ROOT, q["take"])
                if not take or not (take / "scene.json").exists():
                    return self.json({"error": "unknown take"}, 400)
                out_dir = take / "exports"
                out_dir.mkdir(exist_ok=True)
                out = out_dir / f"{slug(q.get('name', 'snapshot'))}-{time.strftime('%Y%m%d-%H%M%S')}.png"
                out.write_bytes(self.body())
                return self.json(saved(out))
        except KeyError as e:
            return self.json({"error": f"missing {e}"}, 400)
        return self.json({"error": "not found"}, 404)


def main():
    global ROOT
    ap = argparse.ArgumentParser(description="Camera Path Studio")
    ap.add_argument("takes", nargs="?", default=str(ROOT), help="folder with Atlas takes (default: ./takes)")
    ap.add_argument("--port", type=int, default=8780)
    ap.add_argument("--open", action="store_true", help="open the studio in your browser")
    args = ap.parse_args()
    ROOT = Path(args.takes).expanduser().resolve()
    ROOT.mkdir(parents=True, exist_ok=True)
    url = f"http://127.0.0.1:{args.port}/"
    takes = find_takes()
    print(f"Takes folder: {ROOT} ({len(takes)} take{'s' if len(takes) != 1 else ''})")
    if not shutil.which("ffmpeg"):
        print("Note: ffmpeg not found; previews work, but exporting video needs it.")
    print(f"Camera Path Studio: {url}")
    if args.open:
        webbrowser.open(url)
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
