"""Build the licensed WAV effects; pass the director's incoming directory.

Requires numpy/scipy. Originals stay outside the shipped assets. Source selection,
edits and licences are documented in game/assets/audio/CREDITS.md.
"""
import argparse
import io
import math
from pathlib import Path
import wave
import zipfile

import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

RATE = 44100
OUT = Path(__file__).resolve().parents[1] / "game/assets/audio/recordings"


def read(source):
    rate, data = wavfile.read(source)
    data = data.astype(float) / np.iinfo(data.dtype).max
    if np.any(np.abs(data) >= .999):
        raise ValueError("Clipped source: keep the procedural fallback")
    if data.ndim == 2:
        data = data.mean(axis=1)
    divisor = math.gcd(rate, RATE)
    return resample_poly(data, RATE // divisor, rate // divisor)


def save(name, data, rms):
    data -= data.mean()
    data *= min(.8 / np.max(np.abs(data)), rms / np.sqrt(np.mean(data * data)))
    pcm = np.round(data * 32767).astype('<i2')
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(pcm.tobytes())
    assert path.stat().st_size <= 150000
    print(f'{name}: {len(pcm) / RATE:.3f} s, {path.stat().st_size} bytes, '
          f'peak {np.max(np.abs(pcm.astype(float))) / 32767:.3f}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('incoming', type=Path)
    args = parser.parse_args()
    # A stationary portion of the supplied three-second tyre loop. Blend the
    # final 200 ms into the opening 200 ms, then wrap into the next sample.
    tyre = read(args.incoming / 'tires_squal_loop.wav')[int(.3 * RATE):int(2 * RATE)]
    n = int(.2 * RATE)
    loop = tyre[n:].copy()
    fade = np.linspace(0, 1, n)
    loop[-n:] = tyre[-n:] * (1 - fade) + tyre[:n] * fade
    save('tyre_squeal.wav', loop, .17)
    # Impact 10 has headroom in the original; several other impacts hard-clip.
    with zipfile.ZipFile(args.incoming / 'impacts.zip') as archive:
        hit = read(io.BytesIO(archive.read('Impacts/Impact 10.wav')))
    hit = hit[int(.04 * RATE):int(1.3 * RATE)].copy()
    hit[:220] *= np.linspace(0, 1, 220)
    hit[-2205:] *= np.linspace(1, 0, 2205)
    save('impact.wav', hit, .12)


if __name__ == '__main__':
    main()
