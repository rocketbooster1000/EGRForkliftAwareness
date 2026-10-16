import json
import time
try:
    import tkinter as tk
except ImportError:
    tk = None  # The web bridge runs without a desktop/Tk installation.
import cv2
import numpy as np
from gpiozero import DistanceSensor, Device
from gpiozero.pins.lgpio import LGPIOFactory
from picamera2 import Picamera2

Device.pin_factory = LGPIOFactory()


class Ultrasonic:
    def __init__(self, trigger=17, echo=18, max_distance=4.0):
        self._s = DistanceSensor(echo=echo, trigger=trigger, max_distance=max_distance)

    def distance_cm(self):
        return self._s.distance * 100

    def is_closer_than(self, threshold_cm):
        return self.distance_cm() < threshold_cm

    def close(self):
        self._s.close()


class Camera:
    def __init__(self, size=(640, 480)):
        self.size = size
        self._c = Picamera2()
        self._c.configure(self._c.create_preview_configuration(
            main={"size": size, "format": "BGR888"}))  # BGR888 -> RGB byte order
        self._c.start()

    def frame(self):
        return self._c.capture_array()  # RGB numpy array

    def close(self):
        self._c.stop()
        self._c.close()


class DepthCamera:
    def __init__(self, camera=None, sensor=None, cal_file="calibration.json"):
        self.camera = camera or Camera()
        self.sensor = sensor or Ultrasonic()
        self.file = cal_file
        w, h = self.camera.size
        try:
            with open(cal_file) as f:
                self.cal = json.load(f)
        except (OSError, ValueError):
            self.cal = {"x": w // 2, "y": h // 2, "scale": 1.0}
        self._prev = None
        self._hog = cv2.HOGDescriptor()
        self._hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    # --- calibration ---
    def _save(self):
        with open(self.file, "w") as f:
            json.dump(self.cal, f)

    def set_target(self, x, y):
        """Pixel where the ultrasonic sensor is pointing."""
        self.cal["x"], self.cal["y"] = x, y
        self._save()

    def calibrate_distance(self, actual_cm):
        """Set the distance scale from a known distance to the targeted object."""
        self.cal["scale"] = actual_cm / self.sensor.distance_cm()
        self._save()

    # --- readings ---
    def frame(self):
        return self.camera.frame()

    def get_distance(self):
        return self.sensor.distance_cm() * self.cal["scale"]

    def new_object(self, min_frac=0.02, max_frac=0.5, thresh=25, frame=None):
        """Call once per frame. True if the fraction of changed pixels (after
        compensating for global camera shift) is between min_frac and max_frac."""
        frame = self.frame() if frame is None else frame
        g = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY), (21, 21), 0)
        prev, self._prev = self._prev, g
        if prev is None:
            return False
        (dx, dy), _ = cv2.phaseCorrelate(prev.astype(np.float32), g.astype(np.float32))
        h, w = g.shape
        aligned = cv2.warpAffine(prev, np.float32([[1, 0, dx], [0, 1, dy]]), (w, h))
        frac = np.mean(cv2.absdiff(aligned, g) > thresh)
        return min_frac < frac < max_frac

    def detect_people(self, frame, scale=0.5):
        """Returns a list of (x, y, w, h) boxes using OpenCV's pretrained HOG detector."""
        small = cv2.resize(frame, None, fx=scale, fy=scale)
        rects, _ = self._hog.detectMultiScale(small, winStride=(8, 8))
        return [tuple(int(v / scale) for v in r) for r in rects]

    def close(self):
        self.camera.close()
        self.sensor.close()


class DepthCameraGUI:
    def __init__(self, depth_camera, threshold_cm=30):
        if tk is None:
            raise RuntimeError("The desktop GUI needs python3-tk; use pi_bridge.py for the website.")
        self.dc, self.threshold = depth_camera, threshold_cm
        self.alert_until, self.people, self.n = 0, [], 0
        w, h = depth_camera.camera.size
        self.root = tk.Tk()
        self.root.title("Depth Camera")
        self.canvas = tk.Canvas(self.root, width=w, height=h)
        self.canvas.pack()
        self.canvas.bind("<Button-1>", lambda e: self.dc.set_target(e.x, e.y))
        bar = tk.Frame(self.root)
        bar.pack()
        tk.Label(bar, text="Actual distance (cm):").pack(side="left")
        self.entry = tk.Entry(bar, width=6)
        self.entry.pack(side="left")
        tk.Button(bar, text="Calibrate distance", command=self._cal_distance).pack(side="left")

    def _cal_distance(self):
        try:
            self.dc.calibrate_distance(float(self.entry.get()))
        except (ValueError, ZeroDivisionError):
            pass

    def _update(self):
        dc, c = self.dc, self.canvas
        f, d = dc.frame(), dc.get_distance()
        if dc.new_object():
            self.alert_until = time.time() + 1
            self.root.bell()
        if self.n % 5 == 0:  # HOG is slow; run every 5th frame
            self.people = dc.detect_people(f)
        self.n += 1

        self.photo = tk.PhotoImage(data=b"P6 %d %d 255\n" % (f.shape[1], f.shape[0]) + f.tobytes())
        c.delete("all")
        c.create_image(0, 0, image=self.photo, anchor="nw")
        for x, y, w, h in self.people:
            c.create_rectangle(x, y, x + w, y + h, outline="cyan", width=2)
            c.create_text(x + 3, y + 3, text="person", fill="cyan", anchor="nw")
        x, y = dc.cal["x"], dc.cal["y"]
        color = "red" if d < self.threshold else "lime"
        c.create_line(x - 20, y, x + 20, y, fill=color, width=2)
        c.create_line(x, y - 20, x, y + 20, fill=color, width=2)
        c.create_text(x + 25, y - 15, text=f"{d:.1f} cm", fill=color, anchor="w",
                      font=("Helvetica", 14, "bold"))
        if time.time() < self.alert_until:
            c.create_text(10, 10, text="NEW OBJECT", fill="yellow", anchor="nw",
                          font=("Helvetica", 18, "bold"))
        self.root.after(30, self._update)

    def run(self):
        self._update()
        self.root.mainloop()


if __name__ == "__main__":
    dc = DepthCamera()
    try:
        DepthCameraGUI(dc).run()
    finally:
        dc.close()
