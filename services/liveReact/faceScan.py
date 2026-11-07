#!/usr/bin/env python3
"""
RANT: find and follow every face in a video. No AI is paid for here and nothing
leaves the server: this only says where faces are. faceScan.js then asks Claude
about a few small pictures of each face.

  python3 faceScan.py <video> <workdir>

Writes <workdir>/tracks.json and crop pictures. Prints "progress 0.42" lines.
Boxes are fractions of the picture (0..1) so they work at any size.
"""
import json, os, sys
import cv2

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")
SAMPLE_FPS = 5.0      # looks per second
LONG_SIDE = 960       # picture size the detector sees
MIN_SCORE = 0.6       # low on purpose: a blurred non-face costs little, a missed face costs a lot
MAX_GAP = 1.0         # seconds a face may vanish and still be the same track
CROPS_PER_TRACK = 3
CROP_SIZE = 224


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    i = max(0, x2 - x1) * max(0, y2 - y1)
    u = a[2] * a[3] + b[2] * b[3] - i
    return i / u if u > 0 else 0


def close_enough(a, b):
    if iou(a, b) > 0.1:
        return True
    ax, ay, bx, by = a[0] + a[2] / 2, a[1] + a[3] / 2, b[0] + b[2] / 2, b[1] + b[3] / 2
    return abs(ax - bx) < a[2] and abs(ay - by) < a[3]


def crop(frame, box):
    """The face with hair, headscarf and shoulders around it, which help tell who it is."""
    h, w = frame.shape[:2]
    x, y, bw, bh = box
    pad = max(bw, bh) * 0.7
    x1, y1 = max(0, int(x - pad)), max(0, int(y - pad))
    x2, y2 = min(w, int(x + bw + pad)), min(h, int(y + bh + pad))
    c = frame[y1:y2, x1:x2]
    if c.size == 0:
        return None
    s = CROP_SIZE / max(c.shape[:2])
    if s < 1:
        c = cv2.resize(c, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", c, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return jpg.tobytes() if ok else None


def main(video, workdir):
    os.makedirs(workdir, exist_ok=True)
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit("Could not open the video")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    step = max(1, int(round(fps / SAMPLE_FPS)))
    det, hist_prev, active, done = None, None, [], []
    scale, sw, sh, n, next_id = 1, 0, 0, -1, 0

    def finish(t):
        done.append(t)

    while cap.grab():
        n += 1
        if n % step:
            continue
        ok, frame = cap.retrieve()
        if not ok:
            break
        now = n / fps
        if det is None:
            h, w = frame.shape[:2]
            scale = min(1.0, LONG_SIDE / max(w, h))
            sw, sh = int(w * scale), int(h * scale)
            det = cv2.FaceDetectorYN.create(MODEL, "", (sw, sh), MIN_SCORE, 0.3, 5000)
        small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA) if scale < 1 else frame

        # A cut to a new shot ends every track, so a box never slides across a cut.
        hist = cv2.calcHist([cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)], [0], None, [32], [0, 256])
        cv2.normalize(hist, hist)
        if hist_prev is not None and cv2.compareHist(hist_prev, hist, cv2.HISTCMP_CORREL) < 0.6:
            for t in active:
                finish(t)
            active = []
        hist_prev = hist

        _, faces = det.detect(small)
        found = [] if faces is None else [([float(v) for v in f[:4]], float(f[14])) for f in faces]
        found.sort(key=lambda f: -f[0][2] * f[0][3])
        taken = set()
        for box, score in found:
            best = None
            for i, t in enumerate(active):
                if i not in taken and now - t["last"] <= MAX_GAP and close_enough(t["box"], box):
                    best = i
                    break
            if best is None:
                active.append({"id": next_id, "start": now, "last": now, "box": box, "boxes": [], "shots": []})
                next_id += 1
                best = len(active) - 1
            taken.add(best)
            t = active[best]
            t["last"], t["box"] = now, box
            t["boxes"].append([round(now, 2), round(box[0] / sw, 4), round(box[1] / sh, 4), round(box[2] / sw, 4), round(box[3] / sh, 4)])
            # Clearest pictures, spread out along the track.
            quality = score * box[2] * box[3]
            slot = int(now - t["start"]) // 3
            have = next((s for s in t["shots"] if s["slot"] == slot), None)
            if have is None or quality > have["q"]:
                j = crop(small, box)
                if j:
                    if have:
                        have.update(q=quality, jpg=j)
                    else:
                        t["shots"].append({"slot": slot, "q": quality, "jpg": j})
        still = []
        for t in active:
            (still if now - t["last"] <= MAX_GAP else done).append(t)
        active = still
        if total and n % (step * 25) == 0:
            print(f"progress {min(0.99, n / total):.3f}", flush=True)

    done.extend(active)
    cap.release()

    out = []
    for t in sorted(done, key=lambda t: t["start"]):
        if len(t["boxes"]) < 2:      # one lonely look is nearly always a false alarm
            continue
        best = sorted(t["shots"], key=lambda s: -s["q"])[:CROPS_PER_TRACK]
        crops = []
        for i, s in enumerate(best):
            name = f"t{t['id']}_{i}.jpg"
            with open(os.path.join(workdir, name), "wb") as f:
                f.write(s["jpg"])
            crops.append(name)
        out.append({"id": t["id"], "start": t["boxes"][0][0], "end": t["boxes"][-1][0], "boxes": t["boxes"], "crops": crops})
    with open(os.path.join(workdir, "tracks.json"), "w") as f:
        json.dump({"tracks": out, "duration": n / fps}, f)
    print("progress 1", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
