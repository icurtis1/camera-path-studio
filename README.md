# Camera Path Studio

Turn an [Atlas](https://www.worldlabs.ai) export into a clean camera-path visual and export it as a video.

![Camera Path Studio: an Atlas take with its camera path inset, and the side panel](docs/hero.gif)

Drop in the export's `.zip`, pick a layout, adjust the look in the side panel, and export an MP4. It runs locally in your browser with a tiny Python server, and there's nothing to install except Python and ffmpeg.

**Two layouts**

- **Video**: the generated video full-frame, with the 3D camera path inset in a corner. The path ahead is dotted, the camera frustum shows the live frame, and the path fades where it passes behind a frame image.
- **3D scene**: the camera path inside a point cloud of the scene (built from the input photo's depth), with the video and input photo picture-in-picture. A gentle wiggle helps the depth read.

## Quick start

You need **Python 3.10+** and a modern browser (Chrome, Edge, Safari or Firefox). To export video you also need **[ffmpeg](https://ffmpeg.org/download.html)** on your PATH (`brew install ffmpeg` on macOS).

```bash
git clone https://github.com/icurtis1/camera-path-studio.git
cd camera-path-studio
python3 server.py --open
```

The `--open` flag opens http://127.0.0.1:8780 in your browser. Drop an Atlas export `.zip` onto the page and it opens right away.

Imported takes are unpacked into `takes/` next to the server. To use a folder of exports you already have, pass it instead:

```bash
python3 server.py ~/path/to/exports --open
```

Every subfolder with a `scene.json` shows up in the **Take** menu.

## What's in an Atlas export

The studio reads the export folder as-is:

```
my-take/
├── scene.json        cameras for every output frame (+ the input photo's camera)
├── video.mp4         the generated video (optional; frames are used if it's missing)
├── inputs/           the input photo, its depth map (.exr) and confidence (.png)
└── outputs/          one image per generated frame
```

Only `scene.json` and the frames it lists are required. The input photo's depth is used for the point cloud in the 3D scene layout.

## Using it

- **Take**: switch between takes, or import another `.zip`. You can also drag a `.zip` anywhere onto the page. To remove a take you imported, hover it in the menu and click the trash icon. That deletes its unpacked files and exports from the takes folder. Folders you pointed the server at yourself can't be removed from the page.
- **Layout**: switch between Video and 3D scene. Each layout keeps its own style.
- **Side panel**: Path, Cameras, View, Adjustments, Text, Environment and Export. The 3D scene layout also has **Output & input**, which shows, hides, moves or resizes the video and input-photo pictures. Your settings are saved in your browser.
- **3D view**: in the Video layout that's the corner inset. Drag it to rotate, right-drag to pan, scroll to zoom. **Path → Show path** hides the inset if you only want the video. **View → Snap to angle** reframes it from a preset angle. The framing is remembered per take.
- **Timeline**: <kbd>Space</kbd> plays or pauses, <kbd>←</kbd> <kbd>→</kbd> step one frame.

**Export**

- **Export MP4**: every frame at full quality (1920×1080, 2× supersampled 3D), encoded as H.264.
- **Export alpha .mov**: the path and overlays only, on a transparent background (ProRes 4444), for compositing in Premiere, Resolve or After Effects.
- **Snapshot**: the current frame as a PNG.

Exports download through your browser, into your Downloads folder (or wherever your browser saves files). A copy also stays in the take's `exports/` folder.

## For scripts and agents

The page exposes a small handle, `window.studio`:

```js
await studio.ready;                    // a take is loaded
studio.setLayout('world');             // 'overlay' (Video) or 'world' (3D scene)
studio.set('pathWidth', 8);            // any side-panel setting (keys are in BASE in app.js)
studio.setFrame(60);
const mp4 = await studio.exportVideo();          // downloads it, and resolves to the copy's path in <take>/exports/
const mov = await studio.exportVideo({ alpha: true });
const png = await studio.snapshot();
```

Open a specific take and layout with URL parameters: `http://127.0.0.1:8780/?take=my-take&layout=world`.

The server's endpoints are what the page uses:

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/takes` | Lists takes and whether ffmpeg is available |
| POST | `/api/import?name=x.zip` | Body: a `.zip`. Unpacks it into the takes folder and returns `{ take }` |
| POST | `/api/export/start`, `/frame`, `/finish` | Collects PNG frames and encodes them with ffmpeg |
| POST | `/api/snapshot?take=…&name=…` | Body: a PNG. Saves it to `<take>/exports/` |
| POST | `/api/remove?take=…` | Deletes a take that was imported from a `.zip` |
| GET | `/data/<take>/…` | Files inside a take |

## Files

```
server.py    local server: serves the page and takes, unpacks .zip imports, runs ffmpeg
index.html   page layout and styles
app.js       everything else: loading takes, the 3D scene (three.js), drawing, export, side panel
docs/        the README's preview
```

three.js and lil-gui load from a CDN, so there's no build step.

## Notes

- Camera poses are read in the `rub` convention used by three.js (+x right, +y up, the camera looks down −z), and `rdf` is converted. Quaternions are `[x, y, z, w]`.
- Depth is treated as planar z-depth in the scene's units, and distances are labelled in metres (`UNIT` in `app.js`).
- The server only listens on `127.0.0.1`, so it isn't reachable from other machines.

## License

[MIT](LICENSE)
