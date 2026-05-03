"""Generate the install QR code PNG.

URL is the GitHub Pages URL for this repo. Override via env if needed.
"""
import os
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_M

URL = os.environ.get("APP_URL", "https://takerunishiya-coder.github.io/English/")

OUT = Path(__file__).resolve().parent.parent / "icons" / "install-qr.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

qr = qrcode.QRCode(
    version=None,
    error_correction=ERROR_CORRECT_M,
    box_size=12,
    border=2,
)
qr.add_data(URL)
qr.make(fit=True)
img = qr.make_image(fill_color="#0f172a", back_color="white")
img.save(OUT)
print(f"Wrote QR code for {URL} to {OUT}")
